# @collabnode/ladybug

[Ladybug](https://www.npmjs.com/package/@ladybugdb/core) `GraphStore` projection for [collabnode](https://github.com/eduardpaul/collabnode).

An embedded, file-backed query projection of the collaborative graph — the CRDT stays the source of truth, and this keeps a Cypher-queryable copy in step with it.

```bash
npm install @collabnode/ladybug @ladybugdb/core
```

`@ladybugdb/core` is an optional peer dependency: install it only if you use this projection.

## Usage

```ts
import { LadybugGraphStore } from "@collabnode/ladybug";

const graph = new LadybugGraphStore({ path: "data/board.lbdb" });
await graph.applySchema(schema);
```

Pass an `embeddings` provider to enable vector search — see [`@collabnode/embeddings`](https://www.npmjs.com/package/@collabnode/embeddings). Without one, nothing is embedded and `searchVector` reports no index.

## Exports

| Area | Symbols |
| --- | --- |
| Store | `LadybugGraphStore`, `LadybugGraphStoreOptions` |
| DDL | `schemaToDdl`, `ladybugColumnType` |
| Cypher | `opToCypher` |
| Full-text indexes | `ftsPlan`, `createIndexStatement`, `dropIndexStatement`, `queryIndexStatement`, `reconcileIndexes`, `FtsIndexPlan` |
| Vector indexes | `vectorPlan`, `vectorColumn`, `vectorLiteral`, `VectorIndexPlan` |

---

Part of [collabnode](https://github.com/eduardpaul/collabnode). Most applications should depend on the top-level [`collabnode`](https://www.npmjs.com/package/collabnode) package instead of wiring this one directly.

MIT © Eduard Paul
