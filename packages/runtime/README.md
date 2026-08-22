# @collabnode/runtime

`CollabSession`, the projector, and schema validation for [collabnode](https://github.com/eduardpaul/collabnode).

The session joins a `CollabBackend` to a `GraphStore`: writes go through the CRDT, and a debounced projector keeps the graph store in sync.

```bash
npm install @collabnode/runtime
```

## Usage

```ts
import { CollabSession } from "@collabnode/runtime";
import { InMemoryCollabBackend } from "@collabnode/collab";
import { InMemoryGraphStore } from "@collabnode/graph";

const session = await CollabSession.create({
  schema,
  collab: new InMemoryCollabBackend(),
  graph: new InMemoryGraphStore(),
  actorId: "api",
});

await session.upsertNode({ type: "Task", properties: { title: "Draft Q3 plan" } });
session.onChange((ops, snapshot) => render(snapshot));
```

Join an existing document with `CollabSession.join(documentId, options)`. `actorId` is required when the YAML enables `config.changeTracking`.

## Exports

| Area | Symbols |
| --- | --- |
| Session | `CollabSession`, `CollabSessionOptions`, `MutationOptions`, `UpsertNodeInput`, `UpsertEdgeInput` |
| Projection | `Projector`, `ProjectorListener`, `CRDT_PROJECT_DEBOUNCE_MS` |
| Validation | `assertNodeOp`, `assertEdgeOp`, `coerceProperties`, `normalizeTags` |
| Derived & history | `applyDerivedProperties`, `redactHistoryValue` |
| Graph tools | `bindGraphTools` plus the individual `graphGet` / `graphList` / `graphSearch` / `graphQuery` / `graphNeighbors` / `graphSimilar` / `graphHistory` / `graphChanges` / `graphSnapshot` / `upsertGraphNode` / `upsertGraphEdge` / `deleteGraphNode` / `deleteGraphEdge` operations |

The graph tools are transport-independent — [`@collabnode/mcp`](https://www.npmjs.com/package/@collabnode/mcp) wraps the same functions as MCP tools.

---

Part of [collabnode](https://github.com/eduardpaul/collabnode). Most applications should depend on the top-level [`collabnode`](https://www.npmjs.com/package/collabnode) package instead of wiring this one directly.

MIT © Eduard Paul
