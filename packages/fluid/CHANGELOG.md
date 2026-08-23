# @collabnode/fluid

## 0.2.0

### Minor Changes

- 680a532: Make a hosted deployment possible: signed Azure Fluid Relay tokens, an
  authorizing token route, and a Redis-backed workspace registry.
  
  - **`@collabnode/azure`** now signs tokens. `signAzureFluidToken` emits an HS256
    JWT with the claims Azure Fluid Relay requires; the previous `alg: "none"`
    token could never have authenticated, and it also carried the first four
    characters of the tenant key in its payload. `azureRelayFromEnv()` builds a
    provider from `AZURE_FLUID_KEY` when none is passed.
  
  - **`collabnode`**: `createFluidTokenHandler` requires an `authorize` callback
    and refuses to construct without one. **Breaking.** `user()` answers who is
    asking, never what they may open, so without this check the route minted a
    writable token for whatever `documentId` the caller sent — including documents
    belonging to another app in the same tenant. A missing `documentId` is now a
    400 rather than a tenant-wide token, a throwing `user()` a 401, and a rejected
    `authorize` a 403.
  
  - **`@collabnode/redis`** is new: `redisRegistry()` implements
    `WorkspaceRegistry` over Redis, so leases, records, and reaping are shared by
    every replica instead of private to one process. The lease is a `SET NX PX`,
    so expiry belongs to Redis rather than to a timer in a process that may
    already be gone. Every command addresses one key, which keeps it correct
    against a clustered endpoint.
  
  - **`@collabnode/fluid`**: `close()` waits for pending ops to be acknowledged
    before disposing the container, bounded by a timeout. Against Tinylicious on
    localhost the old behaviour was invisible; against a hosted relay it lost the
    last write of a process that was shutting down.

### Patch Changes

- @collabnode/collab@0.2.0
  - @collabnode/graph@0.2.0
  - @collabnode/schema@0.2.0
