# @collabnode/collab

The backend-agnostic collaborative graph interface for [collabnode](https://github.com/eduardpaul/collabnode), plus an in-memory implementation.

`CollabBackend` is the seam that keeps application code independent of the CRDT vendor. [Fluid](https://www.npmjs.com/package/@collabnode/fluid) and [Hocuspocus/Yjs](https://www.npmjs.com/package/@collabnode/hocuspocus) both implement it; a new backend only has to satisfy this interface.

```bash
npm install @collabnode/collab
```

## Usage

```ts
import { InMemoryCollabBackend } from "@collabnode/collab";

const backend = new InMemoryCollabBackend();
const handle = await backend.create(schema);   // or backend.join(documentId, schema)
```

The in-memory backend is the right choice for tests, single-process runs, and as a reference when implementing a new transport.

## Exports

- `CollabBackend`, `CollabHandle` — the interface a CRDT backend implements
- `InMemoryCollabBackend` — non-networked reference implementation
- `CollabText`, `CollabMap`, `CollabArray` — live property handles
- `cloneJson`, `replaceText` — field helpers
- `assertSchemaMatch`, `CollabError` — schema-hash guard raised when peers disagree

---

Part of [collabnode](https://github.com/eduardpaul/collabnode). Most applications should depend on the top-level [`collabnode`](https://www.npmjs.com/package/collabnode) package instead of wiring this one directly.

MIT © Eduard Paul
