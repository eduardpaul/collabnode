---
"@collabnode/mcp": minor
"collabnode": minor
---

Close a hole in the agent write policy, and stop a diff tool from leaking
concealed types.

- **`graph_apply_batch`** applied whatever ops it was handed. It is offered as
  soon as a role may write *anything*, and `applyOps` knows nothing about roles,
  so a role restricted to one node type could create, update and delete every
  other type through it — and delete nodes the single-write tools refuse. Every
  entry is now checked the way its single-write tool would check it: node
  upserts against `canWrite(type)`, edge upserts against `canWriteEdge(type)`
  plus the per-instance endpoint rule, deletes through the same resolution that
  makes a hidden id read as an id that never existed. A refused entry refuses
  the whole batch.

- **`graph_diff_since`** is no longer offered to a role that conceals any node
  type. A diff aggregates the whole graph into one answer and cannot be filtered
  afterwards — the same reason `graph_query` is withheld — so the hidden types
  were named in `ops` and spelled out in the Markdown.

- Both tools now validate their arguments against a real schema rather than
  `z.record(...)` casts, and both take their descriptions from the locale
  catalogue, so an MCP client asking for Spanish no longer gets two English
  tools among the rest.

- **`toAgentTools`** validates arguments before running a tool. Nothing else on
  that path does: an MCP transport parses the input schema first, an in-process
  agent loop calls straight through. It also takes an optional schema and
  returns `jsonSchema` per tool.
