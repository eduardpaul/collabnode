# @collabnode/cli

Command line interface for [collabnode](https://github.com/eduardpaul/collabnode): validate a schema, emit DDL, run a local collab server, or serve MCP over stdio.

```bash
npm install -g @collabnode/cli
# or, without installing:
npx @collabnode/cli validate schema.yaml
```

## Commands

```bash
collabnode validate schema.yaml
collabnode serve    schema.yaml --backend memory
collabnode mcp      schema.yaml --backend memory --actor agent-1
collabnode ddl      schema.yaml --graph age --graph-name harbor_lanes
```

| Command | Purpose |
| --- | --- |
| `validate` | Parse the YAML and report schema errors |
| `serve` | Run a local collab session (`--backend memory \| fluid \| hocuspocus`) |
| `mcp` | Serve MCP over stdio — for Cursor, Claude Desktop, and other stdio hosts |
| `ddl` | Print the DDL a projection needs (`--graph ladybug \| age`) |

`serve --backend fluid` starts Tinylicious on port 7070; `--backend hocuspocus` starts an in-process Hocuspocus on port 1234. Azure Fluid Relay is a provisioned service — pass `--relay azure` with `AZURE_FLUID_TENANT_ID`, `AZURE_FLUID_ENDPOINT`, and `AZURE_FLUID_KEY`.

## This is a development tool

Production hosts should call `init()` from [`collabnode`](https://www.npmjs.com/package/collabnode) as an in-process dependency rather than shelling out to the CLI.

---

Part of [collabnode](https://github.com/eduardpaul/collabnode). Most applications should depend on the top-level [`collabnode`](https://www.npmjs.com/package/collabnode) package instead of wiring this one directly.

MIT © Eduard Paul
