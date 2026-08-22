# @collabnode/hub

Hub, ephemeral workspace lifecycle, reaper, registry, and artifact persistence for [collabnode](https://github.com/eduardpaul/collabnode).

```bash
npm install @collabnode/hub
```

## Usage

```ts
import { createHub, memoryRegistry } from "@collabnode/hub";
import { parseWorkspaceTypeDocument } from "@collabnode/schema";

const hub = await createHub({
  registry: memoryRegistry(),
});

hub.define(parseWorkspaceTypeDocument(`
type: incident
version: 1
schema:
  nodes:
    Alert:
      properties:
        title: { type: string, required: true }
`));

const ws = await hub.open("incident", {
  id: "inc-2026-08-01",
});

await ws.upsertNode({
  type: "Alert",
  properties: { title: "High CPU usage" },
});

const artifact = await ws.end("explicit");
console.log("Workspace ended, artifact:", artifact.snapshot);
```

## Exports

| Area | Symbols |
| --- | --- |
| Hub | `createHub`, `Hub`, `snapshotToGraphOpInputs` |
| Workspace | `Workspace` |
| Registry | `MemoryWorkspaceRegistry`, `memoryRegistry` |
| Reaper | `Reaper`, `sweepWorkspaces` |
| Types | `WorkspaceType`, `WorkspaceRecord`, `WorkspaceArtifact`, `WorkspaceState`, `EndReason`, `Participant`, `Lease` |

---

Part of [collabnode](https://github.com/eduardpaul/collabnode). Most applications should depend on the top-level [`collabnode`](https://www.npmjs.com/package/collabnode) package instead of wiring this one directly.

MIT © Eduard Paul
