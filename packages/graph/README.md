# @collabnode/graph

Graph snapshot, ops, history, and the in-memory store for [collabnode](https://github.com/eduardpaul/collabnode).

Defines the `GraphStore` seam that projections implement ([Ladybug](https://www.npmjs.com/package/@collabnode/ladybug), [Apache AGE](https://www.npmjs.com/package/@collabnode/age)) and the `GraphOp` vocabulary the CRDT backends emit.

```bash
npm install @collabnode/graph
```

## Usage

```ts
import { InMemoryGraphStore, diffSnapshots, snapshotToOps } from "@collabnode/graph";

const store = new InMemoryGraphStore();
await store.applySchema(schema);

const ops = diffSnapshots(before, after);
await store.apply(ops);
```

## Exports

| Area | Symbols |
| --- | --- |
| Store seam | `GraphStore`, `GraphSearchModes`, `GraphStoreError`, `InMemoryGraphStore` |
| Snapshots & ops | `snapshotToOps`, `diffSnapshots`, `applyPropertyPatch`, `stampMeta`, `emptyMeta`, `nodeTags` |
| History | `selectHistory`, `trimHistory`, `compareHistory`, `cloneHistoryEntry`, `historyIndicesToDrop` |
| Search | `searchTerms`, `searchableProperties`, `boostTiers`, `flattenSearchValue`, `joinedTerms`, `fold`, `squash` |
| Vectors | `EmbeddingProvider`, `cosineSimilarity`, `vectorProperties`, `vectorText`, `vectorSlug`, `aboveFloor` |
| Query | `runMinimalQuery` |

---

Part of [collabnode](https://github.com/eduardpaul/collabnode). Most applications should depend on the top-level [`collabnode`](https://www.npmjs.com/package/collabnode) package instead of wiring this one directly.

MIT © Eduard Paul
