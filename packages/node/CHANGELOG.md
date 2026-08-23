# collabnode

## 0.2.0

### Minor Changes

- 680a532: Make a hosted deployment possible: signed Azure Fluid Relay tokens, an
  authorizing token route, and a Redis-backed workspace registry.
  
  - **`@collabnode/azure`** now signs tokens. `signAzureFluidToken` emits an HS256
    JWT with the claims Azure Fluid Relay requires; the previous `alg: "none"`
    token could never have authenticated, and it also carried the first four
    characters of the tenant key in its payload. `azureRelayFromEnv()` builds a
    provider from `AZURE_FLUID_KEY` when none is passed.
  
  - **`collabnode`**: `createFluidTokenHandler` requires an `authorize` callback
    and refuses to construct without one. **Breaking.** `user()` answers who is
    asking, never what they may open, so without this check the route minted a
    writable token for whatever `documentId` the caller sent — including documents
    belonging to another app in the same tenant. A missing `documentId` is now a
    400 rather than a tenant-wide token, a throwing `user()` a 401, and a rejected
    `authorize` a 403.
  
  - **`@collabnode/redis`** is new: `redisRegistry()` implements
    `WorkspaceRegistry` over Redis, so leases, records, and reaping are shared by
    every replica instead of private to one process. The lease is a `SET NX PX`,
    so expiry belongs to Redis rather than to a timer in a process that may
    already be gone. Every command addresses one key, which keeps it correct
    against a clustered endpoint.
  
  - **`@collabnode/fluid`**: `close()` waits for pending ops to be acknowledged
    before disposing the container, bounded by a timeout. Against Tinylicious on
    localhost the old behaviour was invisible; against a hosted relay it lost the
    last write of a process that was shutting down.
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

- Updated dependencies [680a532]
- Updated dependencies [680a532]
  - @collabnode/azure@0.2.0
  - @collabnode/fluid@0.2.0
  - @collabnode/mcp@0.2.0
  - @collabnode/age@0.2.0
  - @collabnode/collab@0.2.0
  - @collabnode/embeddings@0.2.0
  - @collabnode/graph@0.2.0
  - @collabnode/hocuspocus@0.2.0
  - @collabnode/hub@0.2.0
  - @collabnode/ladybug@0.2.0
  - @collabnode/runtime@0.2.0
  - @collabnode/schema@0.2.0
