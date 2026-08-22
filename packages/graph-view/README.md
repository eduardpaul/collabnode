# @collabnode/graph-view

The drop-in `<collab-graph>` web component for [collabnode](https://github.com/eduardpaul/collabnode) — a schema-driven, editable graph canvas rendered with [vis-network](https://visjs.github.io/vis-network/).

```bash
npm install @collabnode/graph-view
```

`vis-network` and [`@collabnode/web`](https://www.npmjs.com/package/@collabnode/web) come with it. If you only need `connect()` and the change feed, install `@collabnode/web` on its own and skip the renderer entirely.

## Usage

Mount the component and hand it the same `session` you got from `connect()`:

```html
<collab-graph style="height: 70vh"></collab-graph>

<script type="module">
  import { connect } from "@collabnode/web";
  import { CollabGraph } from "@collabnode/graph-view";

  const client = await connect({ schema, documentId, actorId });
  document.querySelector("collab-graph").session = client.session;
</script>
```

Importing the module registers the custom element, so the bare import is enough — `CollabGraph` is exported for `instanceof` checks and typing.

## Schema-driven rendering

`ui.label`, `ui.color`, and `ui.icon` in the YAML drive labels, colors, and shapes. No app-specific drawing code: any schema renders.

| Attribute | Effect |
| --- | --- |
| `editable="false"` | Watch-only — no node/edge mutation |
| `toolbar="false"` | Hide the **+ Node** / **Link** toolbar |
| `inspector="false"` | Hide the side inspector panel |

Layout stays local to the tab. Every node and edge edit goes through `CollabSession`, so it replicates to other peers like any other write.

> The canvas measures itself on creation. Mounting it inside a collapsed `<details>` or a `display: none` container yields a zero-size measurement — create it when the container is first shown.

## Exports

- `CollabGraph` — the custom element class, registered as `<collab-graph>`

---

Part of [collabnode](https://github.com/eduardpaul/collabnode). Most applications should depend on the top-level [`collabnode`](https://www.npmjs.com/package/collabnode) package instead of wiring this one directly.

MIT © Eduard Paul
