---
"@collabnode/hub": minor
"@collabnode/redis": minor
"collabnode": minor
---

`WorkspaceRecord.label`: the name a person gave a workspace, stored next to the
record.

Ids have to stay URL- and MCP-path-safe, so the typed name cannot be one — and
without a place for it on the record, every app that lets people name workspaces
grows a second store beside the registry, with the name of a workspace created
on one replica missing on the next. Pass `label` to `hub.open()`; joining with a
new one renames, joining without one leaves the name alone.

`WorkspaceRegistry.findByCollabDocId()` is a new optional method, implemented by
both registries — Redis with a `{prefix}:doc:{id}` pointer, memory with a scan.
Answering "may this caller open this document?" is on the request path of every
browser join, and a `list()` scan there costs a read per live workspace.

`Workspace.toRecord()` now carries `label` and `collabDocId`. `hub.get()` answers
from the live workspace whenever there is one, so anything missing there was
silently lost depending on whether the workspace happened to be open in the
asking process — including the document id a relay token has to be scoped to.
