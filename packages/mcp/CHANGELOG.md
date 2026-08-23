# @collabnode/mcp

## 0.2.0

### Minor Changes

- 680a532: Fix the Hub MCP endpoint, which could not serve a session past `initialize`.
  
  `createHubMcpHandler` built a fresh `McpServer` **and** a fresh
  `WebStandardStreamableHTTPServerTransport` on every request and closed neither.
  The session id returned by `initialize` therefore meant nothing: the next
  request got a different transport, which answered `Server not initialized` to
  `tools/list`, `tools/call`, and everything else a client actually calls. The
  endpoint was unusable by any compliant MCP client.
  
  It now serves through `createMcpHandler` — the SDK's own handler entry, already
  used by `createGraphMcpHandler` on the single-document path — which owns
  instance lifetime and era routing. Workspace resolution still happens before any
  server is constructed, so an unknown workspace is still a 404, and `agentRole`
  and `language` are still read per request.
  
  **Breaking:** `createHubMcpHandler` returns an `McpHttpHandler`
  (`{ fetch, close, notify, bus }`) rather than a bare function, matching
  `createGraphMcpHandler`. Call sites move from `handler(request)` to
  `handler.fetch(request)`. `serveHubMcpHttp` is unchanged from the outside and
  now closes the handler on shutdown.

### Patch Changes

- @collabnode/hub@0.2.0
  - @collabnode/runtime@0.2.0
  - @collabnode/schema@0.2.0
