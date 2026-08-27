---
"@collabnode/graph": minor
"@collabnode/runtime": minor
"@collabnode/web": minor
"collabnode": minor
---

Dirty-node revision in the solution planner, plus snapshot walk and subgraph markdown.

**Planner sample.** Human edits mark nodes `dirty` and cascade down Epic → Feature → Task (and linked risks / assumptions / C4). An on-demand Manager ↔ Architect loop revises that subgraph, optionally with a user review note. Agent calls use LangChain structured output. Task status toggles and HITL writes do not mark dirty.

**Library**

- `walk(snapshot, startId, { edgeTypes, direction, depth, limit })` — BFS over a snapshot. `graph_neighbors` uses it.
- `snapshotToMarkdown` accepts `ids`, `includeNeighbors` (1-hop both ways), and `includeEdges`. With `ids` set, only incident edges are listed.
- `@collabnode/web` `connect()` refuses `collab.kind` `"memory"` and any other unknown kind instead of silently opening Tinylicious.
