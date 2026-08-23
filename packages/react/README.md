# @collabnode/react

React hooks for a collabnode document in the browser. Thin wrappers over
[`@collabnode/web`](../web): the session, its live snapshot, and the writes —
with the connection's lifetime tied to the component that opened it.

```bash
npm install @collabnode/react @collabnode/web
```

## Joining a document

A browser cannot invent a document id, a schema, or relay coordinates: the
server owns all three and hands them over on a join route. `useCollabJoin` asks
that route and connects to what comes back.

```tsx
import { useCollabJoin } from "@collabnode/react";

function Board({ workspaceId }: { workspaceId: string }) {
  const { session, nodesByType, isLoading, error } = useCollabJoin(
    `/api/collab/join?workspace=${encodeURIComponent(workspaceId)}`,
    { actorId: "ada" },
  );

  if (error) return <p>{error.message}</p>;
  if (isLoading) return <p>Connecting…</p>;

  return (
    <ul>
      {(nodesByType.Note ?? []).map((note) => (
        <li key={note.id}>{String(note.properties.title)}</li>
      ))}
    </ul>
  );
}
```

The server side of that route is `webJoinInfo()` (single document) or
`hub.open()` plus the workspace's schema (a hub). On Azure Fluid Relay the
descriptor carries a `tokenEndpoint`, and `connect()` builds the token provider
from it — the tenant key never reaches the browser.

Already holding a descriptor? `useCollab(options)` takes the same
`ConnectOptions` as `connect()`, and `useCollabJoin` is that plus the fetch.

## The connection belongs to the component

Unmounting, or pointing the hook at another document, closes the session it
opened. That matters more than it sounds: a dropped `connect()` keeps its
container, its socket, and its presence registration for the life of the tab,
and React StrictMode mounts every component twice in development.

## Reading

| Hook | Answers |
| --- | --- |
| `useCollabSnapshot(session)` | The whole graph, re-rendering on every change |
| `useCollabNodes(session, type?)` | Nodes, optionally of one type |
| `useCollabNode(session, id)` | One node |
| `useCollabEdges(session, type?)` | Edges, optionally of one type |
| `useCollabPresence(session)` | Who else is connected |

Reads go through `useSyncExternalStore` against one cached snapshot per session,
so ten components watching the same document share one subscription — and it is
released when the last of them unmounts.

`useCollab` and `useCollabJoin` also return `nodesByType`, which is the grouping
most views want without filtering the snapshot themselves.

## Writing

`upsertNode`, `deleteNode`, `upsertEdge` and `deleteEdge` come back from
`useCollab`. For several writes that must land together, `useCollabBatch` gives
you `batch` and `applyOps`:

```tsx
const { batch } = useCollabBatch(session);

await batch((b) => {
  const epic = b.upsertNode({ type: "Epic", properties: { title } }, "epic");
  b.upsertNode({ type: "Feature", properties: { title: feature } }, "feature");
  b.upsertEdge({ type: "HAS_FEATURE", from: epic, to: { ref: "feature" } });
});
```

`useCollabNodeState(session, nodeId, "status")` is the read-and-write pair for a
single property, for form fields. It writes only the property you set: an upsert
merges into what is stored, so there is no need to resend the rest.

## Context

`CollabProvider` puts one connection in context and `useCollabContext()` reads
it, for trees where passing `session` down is noise.

```tsx
<CollabProvider options={connectOptions}>
  <Board />
</CollabProvider>
```

## Licence

MIT
