# @collabnode/hocuspocus

[Hocuspocus](https://tiptap.dev/hocuspocus) / [Yjs](https://yjs.dev) backend for [collabnode](https://github.com/eduardpaul/collabnode).

Implements the same `CollabBackend` seam as the Fluid backend, so application and UI code does not change with the CRDT vendor.

```bash
npm install @collabnode/hocuspocus
```

## Usage

```ts
import { HocuspocusCollabBackend } from "@collabnode/hocuspocus";
import { CollabSession } from "@collabnode/runtime";

const session = await CollabSession.create({
  schema,
  collab: new HocuspocusCollabBackend({ url: "wss://collab.example.com" }),
  graph,
  actorId: "api",
});
```

`url` defaults to `ws://127.0.0.1:1234`. To run a server in-process for local development:

```ts
import { ensureHocuspocus, stopHocuspocus } from "@collabnode/hocuspocus/node";

await ensureHocuspocus();
```

Rooms are created server-side; browser peers always **join** an existing `documentId`.

## Exports

| Entry | Contents |
| --- | --- |
| `@collabnode/hocuspocus` | `HocuspocusCollabBackend`, `HocuspocusCollabBackendOptions`, `HocuspocusCollaborativeGraph`, `hocuspocusUrl`, `DEFAULT_HOCUSPOCUS_PORT` |
| `@collabnode/hocuspocus/node` | `ensureHocuspocus`, `stopHocuspocus`, `waitForPort` |

---

Part of [collabnode](https://github.com/eduardpaul/collabnode). Most applications should depend on the top-level [`collabnode`](https://www.npmjs.com/package/collabnode) package instead of wiring this one directly.

MIT © Eduard Paul
