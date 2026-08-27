# @collabnode/web

Browser collab client for [collabnode](https://github.com/eduardpaul/collabnode): join a graph as a CRDT peer without importing Fluid or Yjs yourself.

```bash
npm install @collabnode/web
```

Application code never touches `AzureClient` or SharedTree. The browser is a peer on the same `documentId` your Node process opened with `init()`.

## Usage

```ts
import { connect } from "@collabnode/web";

const join = await (await fetch("/api/collab/join")).json();

const client = await connect({
  schema: join.schema,
  documentId: join.documentId,
  actorId: currentUser.id,
  collab: join.collab,
});

client.session.onChange((_ops, snapshot) => render(snapshot));
await client.session.upsertNode({ type: "Task", properties: { title: "Draft Q3 plan" } });
```

The join payload comes from `webJoinInfo(node)` on the server. Hocuspocus uses the same shape with `collab.kind: "hocuspocus"` and a WebSocket `url`. `connect()` accepts `collab.kind` `fluid`, `hocuspocus`, or `custom`. An in-process `memory` join (or any other kind) throws — it will not silently open Tinylicious.

> Never put an Azure tenant key in browser env. On Azure the join descriptor carries a `tokenEndpoint`, and `connect()` fetches a token scoped to one document from it, sending the `actorId` you passed. Mount that route with `createFluidTokenHandler` in [`collabnode`](https://www.npmjs.com/package/collabnode); pass `tokenProvider` instead if you mint tokens some other way.

## Change feed

```html
<collab-change-feed></collab-change-feed>

<script type="module">
  import "@collabnode/web/change-feed";
  document.querySelector("collab-change-feed").session = client.session;
</script>
```

## Graph canvas

The `<collab-graph>` component lives in [`@collabnode/graph-view`](https://www.npmjs.com/package/@collabnode/graph-view), so the renderer and its `vis-network` dependency stay out of installs that only need `connect()`.

```bash
npm install @collabnode/graph-view
```

## Exports

| Entry | Contents |
| --- | --- |
| `@collabnode/web` | `connect`, `WebCollab`, `ConnectOptions`, `WebCollabKind`, `WebGraphKind` |
| | `httpTokenProvider`, `AzureTokenProvider`, `AzureTokenResponse` |
| | Re-exports: `CollabSession`, `parseSchemaDocument`, `GraphSchema` |
| | Change formatting: `describeOps`, `describeLastWrites`, `describeHistory`, `formatHistoryText`, `formatChangeTime`, `ChangeEvent` |
| | HTML helpers: `escapeHtml`, `attrEnabled` |
| `@collabnode/web/change-feed` | Registers `<collab-change-feed>`, exports `CollabChangeFeed` |
| `@collabnode/web/html` | `escapeHtml`, `attrEnabled` |

---

Part of [collabnode](https://github.com/eduardpaul/collabnode). Most applications should depend on the top-level [`collabnode`](https://www.npmjs.com/package/collabnode) package instead of wiring this one directly.

MIT © Eduard Paul
