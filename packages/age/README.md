# @collabnode/age

[Apache AGE](https://age.apache.org) `GraphStore` projection for [collabnode](https://github.com/eduardpaul/collabnode).

Projects the collaborative graph into PostgreSQL with the AGE extension, so you can query it with Cypher alongside your existing relational data.

```bash
npm install @collabnode/age
```

Requires a PostgreSQL server with the AGE extension installed. `pg` ships as a direct dependency.

## Usage

```ts
import { AgeGraphStore, ageOptionsFromEnv } from "@collabnode/age";

const graph = new AgeGraphStore({
  host: "127.0.0.1",
  port: 5455,
  database: "collabnode",
  graphName: "harbor_lanes",
});
await graph.applySchema(schema);
```

`ageOptionsFromEnv()` reads the same settings from the environment. Use one AGE graph name per process or peer. Generate the DDL ahead of time with `collabnode ddl schema.yaml --graph age --graph-name harbor_lanes`.

## Exports

| Area | Symbols |
| --- | --- |
| Store | `AgeGraphStore`, `AgeGraphStoreOptions`, `AgeSqlClient`, `ageOptionsFromEnv` |
| DDL | `schemaToAgeDdl` |
| Cypher | `opToCypher`, `wrapCypher`, `returnColumns` |
| agtype | `parseAgtype`, `decodeAgeValue` |
| Safety | `sanitizeGraphName`, `assertGraphName` |

---

Part of [collabnode](https://github.com/eduardpaul/collabnode). Most applications should depend on the top-level [`collabnode`](https://www.npmjs.com/package/collabnode) package instead of wiring this one directly.

MIT © Eduard Paul
