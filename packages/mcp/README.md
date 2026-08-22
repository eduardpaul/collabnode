# @collabnode/mcp

Schema-driven [Model Context Protocol](https://modelcontextprotocol.io) tools, prompts, and resources for [collabnode](https://github.com/eduardpaul/collabnode).

The tool surface is generated from your YAML schema, so an agent sees your node types and properties rather than a generic key-value API.

```bash
npm install @collabnode/mcp
```

## Usage

```ts
import { createGraphMcpServer, serveMcpStdio } from "@collabnode/mcp";

const server = createGraphMcpServer(session);
await serveMcpStdio(server);
```

Over HTTP, get a `Request → Response` handler for your own framework:

```ts
import { createGraphMcpHandler, toWebRequest, writeWebResponse } from "@collabnode/mcp";

const handleMcp = createGraphMcpHandler(session);
const response = await handleMcp(toWebRequest(req, body));
await writeWebResponse(res, response);
```

Or bind a listener directly with `serveMcpHttp(server, { listen: "127.0.0.1:3937" })`.

## Exports

| Area | Symbols |
| --- | --- |
| Server | `createGraphMcpServer`, `GraphMcpServerOptions` |
| Transports | `serveMcpStdio`, `serveMcpHttp`, `createGraphMcpHandler`, `toWebRequest`, `writeWebResponse` |
| Generation | `generatePrompts`, `systemPromptText`, `generateResources`, `buildTools`, `registerSessionTools` |
| Naming & schemas | `toolName`, `promptName`, `propertyZod`, `propertiesZod` |

`actorFrom` on `GraphMcpServerOptions` sets a per-request actor, which requires `config.changeTracking.enabled` in the YAML.

---

Part of [collabnode](https://github.com/eduardpaul/collabnode). Most applications should depend on the top-level [`collabnode`](https://www.npmjs.com/package/collabnode) package instead of wiring this one directly.

MIT © Eduard Paul
