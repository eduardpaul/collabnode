# @collabnode/schema

YAML graph schema parser and CRDT property types for [collabnode](https://github.com/eduardpaul/collabnode).

Turns a versioned YAML file into a validated `GraphSchema` plus a stable `schemaHash`, so every peer can prove it loaded the same schema before exchanging CRDT ops.

```bash
npm install @collabnode/schema
```

## Usage

```ts
import { parseSchemaDocument, sha256Canonical } from "@collabnode/schema";

const schema = parseSchemaDocument(yamlText);
const hash = sha256Canonical(schema);
```

Reading from disk is a Node-only concern, so it lives on a separate subpath:

```ts
import { loadSchemaFile } from "@collabnode/schema/node";

const schema = await loadSchemaFile(new URL("./schema.yaml", import.meta.url));
```

## Exports

| Entry | Contents |
| --- | --- |
| `@collabnode/schema` | `parseSchemaDocument`, `uiFor`, `guidelinesFor`, `SchemaError` |
| | CRDT fields: `crdtProperties`, `lwwProperties`, `partitionNodeProperties`, `fillRequiredCrdt`, `assertCrdtField`, `CRDT_PROPERTY_TYPES`, `isCrdtPropertyType` |
| | Derived properties: `parseArithmeticExpression`, `arithmeticIdentifiers` |
| | Identity: `generateId`, `identityId`, `ulid` |
| | Hashing: `canonicalJson`, `sha256Canonical`, `sha256Hex` |
| `@collabnode/schema/node` | `loadSchemaFile` |

Side-effect free (`sideEffects: false`) and safe to tree-shake in a browser bundle.

---

Part of [collabnode](https://github.com/eduardpaul/collabnode). Most applications should depend on the top-level [`collabnode`](https://www.npmjs.com/package/collabnode) package instead of wiring this one directly.

MIT © Eduard Paul
