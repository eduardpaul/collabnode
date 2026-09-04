# @collabnode/loro

The collabnode collab backend that has **versions**.

Fluid and Hocuspocus give a document that is always *now*. Loro keeps a Git-like
DAG of the edits that produced it, so this backend can answer three questions
the others cannot:

- **What version is this?** — `session.version()`
- **What changed since that version?** — `graph.diffSince(v)`
- **Show me the document as it was then** — `session.checkout(v)`

Everything else — `GraphOp`, `snapshot()`, live `text`/`map`/`array` fields,
presence, the projector into Ladybug/AGE — behaves exactly as it does on the
other backends. `CollabBackend` is the seam; nothing above it changes.

## Scope, stated up front

**This backend is in-process.** Loro ships no transport and no disk I/O, and
none is invented here. Two handles opened on the same id *in one process* share
a document; two processes do not.

That makes it right for a single-host hub, an agent runtime, a CLI session, or a
server that owns its documents — and wrong for browser peers, which need
Hocuspocus or Fluid. `LoroCollaborativeGraph` exposes `exportUpdate`,
`importUpdate`, and `onLocalUpdate` so a relay can be built on it.

## Use it

```ts
import { init } from "collabnode";

const node = await init({
  schema: new URL("./schema.yaml", import.meta.url),
  collab: { kind: "loro", dir: "data/docs" }, // omit `dir` to stay in memory
});
```

Or construct the backend directly:

```ts
import { LoroCollabBackend } from "@collabnode/loro";
import { fileDocStore } from "@collabnode/loro/node";

const backend = new LoroCollabBackend({ store: fileDocStore("data/docs") });
```

`LoroDocStore` is `load` / `save` / `delete` over bytes. `fileDocStore` is one
file per document; anything else — S3, a Redis blob, a column beside the
workspace registry — implements the same three methods.

## What it changes upstream

### History is unbounded, and costs nothing to keep

The Yjs and Fluid backends keep a parallel array of `HistoryEntry` JSON *inside*
the replicated document, decode all of it on every write to decide what to
evict, and cap it at `changeTracking.historyLimit`. Here the entries ride on the
commit that made them. Nothing is stored twice, nothing is scanned per write,
and `historyLimit` is not honoured because it is not needed: `exportDoc("shallow")`
is the eviction, and it drops the ops and their history entries together instead
of leaving one without the other.

### Projections update by diff, not by comparing snapshots

`Projector` asks `diffSince` when the backend has it, and walks two snapshots
only when it does not. `diffSnapshots` is linear in the size of the graph and
stringifies every property of every node on every change; `diffSince` is linear
in what actually changed.

The fallback is a real path, not a formality — every unversioned backend takes
it, and so does this one once a shallow export has trimmed the history past the
last projected version. `diffSince` returns `undefined` to say so. That is not
the same as returning `[]`, which means nothing changed.

### Artifacts reopen as a checkout

`WorkspaceArtifact` gains `bytes` and `documentVersion` on this backend, and
`hub.reopen(artifact)` mounts the workspace's own document instead of replaying
its snapshot into a fresh one. The review has the history and the past:

```ts
const artifact = await ws.end("explicit");
const review = await hub.reopen(artifact);
review.session.history();                    // what actually happened
review.session.checkout(someEarlierVersion); // and how it looked then

await hub.reopen(artifact, { at: someEarlierVersion }); // or mount it rewound
```

`hub({ artifactExport: "shallow" })` trades rewinding for much smaller
artifacts.

## Document layout

```
collabnode/               root map
  schemaId, schemaHash
  nodes/<id>              type, tags, meta, properties/, _collab/
  edges/<id>              type, from, to, meta, properties/
```

Every child container is created with Loro's **mergeable** containers. Two peers
can upsert the same node id concurrently — `hub.open()` is create-or-join on one
id, so this is the normal case — and plain container creation would give each
peer a container the other never sees, silently losing one side's writes.

Property values go in natively: Loro's value type covers the whole
`PropertyValue` union, so unlike the Yjs backend there is no JSON encode/decode
pair per value, and per-key diffing keeps working.

## Version tokens

`VersionToken` is `{ kind, encoded }` — opaque, JSON-safe, and tagged with the
backend that minted it, so one cannot be misread by another. This backend
encodes DAG *frontiers* rather than a version vector: both name the same
version, but frontiers stay a handful of ids however many peers have touched the
document, and peers are minted per connection.

## Limits

- No transport. See **Scope**, above.
- `capabilities.presence` is true because the process is the authority on who is
  connected to an in-process document. A networked build would derive it from
  live connections instead.
- `checkout` moves the whole document, and a rewound document is read-only —
  correct for a review mount, wrong for a live workspace, where every peer
  sharing the document would see the rewind.
- Referential integrity is still the application's. `deleteNode` removes
  incident edges, and a concurrent "add edge to a node someone else deleted"
  resolves to whatever the CRDT resolves it to. What the DAG adds is the ability
  to find and repair it afterwards.
