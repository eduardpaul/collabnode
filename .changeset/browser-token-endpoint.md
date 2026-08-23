---
"@collabnode/web": minor
"collabnode": minor
---

Browsers joining Azure Fluid Relay no longer wire up their own token provider.

The server describes which relay to join but cannot hand over the means to join
it, so every Azure app was patching the join descriptor in the browser before it
could call `connect()`. Now `openCollab({ kind: "fluid", relay: "azure",
tokenEndpoint: "/api/fluid/token" })` puts the route in the descriptor — a URL is
not a secret, the tenant key still never leaves the server — and `connect()`
builds an `httpTokenProvider` from it, carrying its `actorId`.

`createFluidTokenHandler`'s `user()` callback now receives what the request
claimed — `{ documentId, actorId }` — as a second argument, parsed once and
shared with `authorize`. Existing single-argument callbacks are unaffected.

`hubDocumentAuthorizer(hub)` is the stock `authorize` for a hub: the document
must be one this hub actually opened. It is the floor to build a membership
check on, not a policy in itself.
