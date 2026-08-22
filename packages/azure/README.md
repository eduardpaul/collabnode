# @collabnode/azure

[Azure Fluid Relay](https://learn.microsoft.com/azure/azure-fluid-relay/) transport for [collabnode](https://github.com/eduardpaul/collabnode).

Swaps Tinylicious for a hosted relay while keeping Fluid's SharedTree CRDT — the [`@collabnode/fluid`](https://www.npmjs.com/package/@collabnode/fluid) backend is reused underneath.

```bash
npm install @collabnode/azure @fluidframework/azure-client
```

`@fluidframework/azure-client` is an optional peer dependency: install it only if you use this transport.

## Usage

```ts
import { AzureFluidCollabBackend, azureRelayFromEnv } from "@collabnode/azure";

const backend = new AzureFluidCollabBackend(azureRelayFromEnv());
```

`azureRelayFromEnv()` reads `AZURE_FLUID_TENANT_ID`, `AZURE_FLUID_ENDPOINT`, and `AZURE_FLUID_KEY`. Azure Fluid Relay is provisioned in Azure — nothing here starts a server.

> **Never ship the tenant key to the browser.** Browser peers should fetch a scoped token from your own endpoint; see `createFluidTokenHandler` in [`collabnode`](https://www.npmjs.com/package/collabnode) and `httpTokenProvider` in [`@collabnode/web`](https://www.npmjs.com/package/@collabnode/web).

## Exports

- `AzureFluidCollabBackend` — `CollabBackend` backed by Azure Fluid Relay
- `azureOpen` — container factory for injecting into `FluidCollabBackend`
- `azureRelayFromEnv`, `AzureRelayConfig` — environment configuration
- `staticKeyTokenProvider`, `AzureTokenProvider`, `AzureTokenResponse` — server-side token minting

---

Part of [collabnode](https://github.com/eduardpaul/collabnode). Most applications should depend on the top-level [`collabnode`](https://www.npmjs.com/package/collabnode) package instead of wiring this one directly.

MIT © Eduard Paul
