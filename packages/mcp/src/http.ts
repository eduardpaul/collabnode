import { WebStandardStreamableHTTPServerTransport, type McpServer } from "@modelcontextprotocol/server";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { Readable } from "node:stream";

export async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}


export function toWebRequest(req: IncomingMessage, body: Buffer = Buffer.alloc(0)): Request {
  const host = req.headers.host ?? "127.0.0.1";
  const url = `http://${host}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) {
      continue;
    }
    headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  const method = req.method ?? "GET";
  const init: RequestInit = { method, headers };
  if (method !== "GET" && method !== "HEAD" && body.length > 0) {
    init.body = new Uint8Array(body);
    (init as RequestInit & { duplex: string }).duplex = "half";
  }
  return new Request(url, init);
}

export async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  const nodeStream = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
  nodeStream.pipe(res);
}

export async function serveMcpHttp(
  server: McpServer,
  listen: string,
): Promise<{ url: string; close(): Promise<void> }> {
  const [host, portRaw] = listen.includes(":") ? listen.split(":") : ["127.0.0.1", listen];
  const port = Number(portRaw);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });
  await server.connect(transport);

  const httpServer: HttpServer = createServer((req, res) => {
    void (async () => {
      try {
        const body = await readBody(req);
        const request = toWebRequest(req, body);
        const response = await transport.handleRequest(request);
        await writeWebResponse(res, response);
      } catch (error) {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end(error instanceof Error ? error.message : String(error));
        }
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.listen(port, host, () => resolve());
    httpServer.on("error", reject);
  });

  return {
    url: `http://${host}:${port}/mcp`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
      await server.close();
    },
  };
}
