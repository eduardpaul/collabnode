import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { McpServer } from "@modelcontextprotocol/server";

export function serveMcpStdio(create: () => McpServer): { close(): Promise<void> } {
  return serveStdio(() => create(), {
    onerror: (error) => {
      process.stderr.write(`${error.message}\n`);
    },
  });
}
