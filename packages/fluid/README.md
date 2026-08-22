# @collabnode/fluid

[Fluid Framework](https://fluidframework.com) SharedTree backend for [collabnode](https://github.com/eduardpaul/collabnode).

Implements `CollabBackend` on top of Fluid's SharedTree, with a Tinylicious client for local development.

```bash
npm install @collabnode/fluid
```

## Usage

```ts
import { FluidCollabBackend } from "@collabnode/fluid";
import { CollabSession } from "@collabnode/runtime";

const session = await CollabSession.create({
  schema,
  collab: new FluidCollabBackend({ storageDir: "data/tinylicious" }),
  graph,
  actorId: "api",
});
```

Spawning a local Tinylicious process is a Node-only concern, so it lives on a separate subpath:

```ts
import { ensureTinylicious, releaseTinylicious } from "@collabnode/fluid/node";

await ensureTinylicious({ storageDir: "data/tinylicious" });
```

Pin `storageDir` so `documentId`s survive a restart — without it, Tinylicious uses a temp snapshot directory. `releaseTinylicious` stops the process only if this process spawned it and no other users remain.

For a hosted relay instead of Tinylicious, see [`@collabnode/azure`](https://www.npmjs.com/package/@collabnode/azure).

## Exports

| Entry | Contents |
| --- | --- |
| `@collabnode/fluid` | `FluidCollabBackend`, `FluidCollabBackendOptions`, `FluidCollaborativeGraph` |
| | Tinylicious client: `createTinyliciousClient`, `createTinyliciousContainer`, `loadTinyliciousContainer`, `fluidContainerSchema`, `TinyliciousOptions` |
| | Tree schema: `GraphDocument`, `GraphNode`, `GraphEdge`, `schemaFactory` |
| `@collabnode/fluid/node` | `ensureTinylicious`, `releaseTinylicious`, `stopTinylicious`, `waitForPort` |

---

Part of [collabnode](https://github.com/eduardpaul/collabnode). Most applications should depend on the top-level [`collabnode`](https://www.npmjs.com/package/collabnode) package instead of wiring this one directly.

MIT © Eduard Paul
