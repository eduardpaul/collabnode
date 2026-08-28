/**
 * Minimal Streamable HTTP MCP client. Microsoft Learn (and other remote MCP
 * servers) speak JSON-RPC over POST, with SSE `event: message` bodies and an
 * `mcp-session-id` header after initialize.
 */

export type FetchFn = typeof fetch;

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpInitializeResult {
  protocolVersion?: string;
  instructions?: string;
  serverInfo?: { name?: string; version?: string };
  capabilities?: Record<string, unknown>;
}

export interface StreamableHttpMcpClientOptions {
  url: string;
  clientName?: string;
  clientVersion?: string;
  fetchFn?: FetchFn;
  protocolVersion?: string;
}

const DEFAULT_PROTOCOL = "2025-03-26";

export function unwrapJsonRpc(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") {
    return payload;
  }
  const obj = payload as { error?: { message?: string; code?: number }; result?: unknown };
  if (obj.error) {
    throw new Error(obj.error.message ?? `MCP error ${obj.error.code ?? ""}`.trim());
  }
  return "result" in obj ? obj.result : payload;
}

/** Parse a Streamable HTTP MCP response body (SSE or raw JSON). */
export function parseMcpSseOrJson(body: string): unknown {
  const trimmed = body.trim();
  if (!trimmed) {
    throw new Error("Empty MCP response");
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return unwrapJsonRpc(JSON.parse(trimmed));
  }

  const payloads: string[] = [];
  let acc: string[] = [];
  const flush = () => {
    if (acc.length > 0) {
      payloads.push(acc.join("\n"));
      acc = [];
    }
  };
  for (const line of trimmed.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      acc.push(line.slice(5).trimStart());
    } else if (line === "") {
      flush();
    }
  }
  flush();

  let last: unknown;
  for (const payload of payloads) {
    if (!payload || payload === "[DONE]") {
      continue;
    }
    last = unwrapJsonRpc(JSON.parse(payload));
  }
  if (last === undefined) {
    throw new Error("No MCP data in response");
  }
  return last;
}

export function stringifyMcpToolResult(result: unknown): string {
  if (result == null) {
    return "";
  }
  if (typeof result === "string") {
    return result;
  }
  if (typeof result !== "object") {
    return String(result);
  }
  const obj = result as {
    isError?: boolean;
    content?: Array<{ type?: string; text?: string }>;
    structuredContent?: unknown;
  };
  const texts = (obj.content ?? [])
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .filter(Boolean);
  if (texts.length > 0) {
    return texts.join("\n\n");
  }
  if (obj.structuredContent !== undefined) {
    return JSON.stringify(obj.structuredContent);
  }
  return JSON.stringify(result);
}

export class StreamableHttpMcpClient {
  readonly url: string;
  private readonly fetchFn: FetchFn;
  private readonly clientName: string;
  private readonly clientVersion: string;
  private readonly protocolVersion: string;
  private sessionId: string | undefined;
  private nextId = 1;

  constructor(options: StreamableHttpMcpClientOptions) {
    this.url = options.url;
    this.fetchFn = options.fetchFn ?? fetch;
    this.clientName = options.clientName ?? "solution-planner-architect";
    this.clientVersion = options.clientVersion ?? "0.1.0";
    this.protocolVersion = options.protocolVersion ?? DEFAULT_PROTOCOL;
  }

  async initialize(): Promise<McpInitializeResult> {
    const result = (await this.request("initialize", {
      protocolVersion: this.protocolVersion,
      capabilities: {},
      clientInfo: { name: this.clientName, version: this.clientVersion },
    })) as McpInitializeResult;
    await this.notify("notifications/initialized");
    return result ?? {};
  }

  async listTools(): Promise<McpToolDef[]> {
    const result = (await this.request("tools/list", {})) as { tools?: McpToolDef[] } | undefined;
    return result?.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.request("tools/call", { name, arguments: args });
  }

  async close(): Promise<void> {
    this.sessionId = undefined;
  }

  private async notify(method: string): Promise<void> {
    const headers = this.headers();
    const response = await this.fetchFn(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", method }),
    });
    if (!response.ok && response.status !== 202) {
      throw new Error(`MCP notify ${method} failed: HTTP ${response.status}`);
    }
    this.captureSession(response);
  }

  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const response = await this.fetchFn(this.url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    this.captureSession(response);
    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      throw new Error(`MCP ${method} failed: HTTP ${response.status}${errBody ? ` ${errBody.slice(0, 200)}` : ""}`);
    }
    const body = await response.text();
    if (!body.trim()) {
      return undefined;
    }
    return parseMcpSseOrJson(body);
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": this.protocolVersion,
    };
    if (this.sessionId) {
      headers["mcp-session-id"] = this.sessionId;
    }
    return headers;
  }

  private captureSession(response: Response): void {
    const sid = response.headers.get("mcp-session-id");
    if (sid) {
      this.sessionId = sid;
    }
  }
}
