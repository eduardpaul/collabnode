---
"@collabnode/graph-view": patch
"@collabnode/schema": patch
"@collabnode/cli": patch
---

Fix three things a view, a schema comment and a CLI argument could each get
wrong.

Dropping a bound view (`view = undefined`) now drops the id allowlist it
installed, instead of leaving the graph restricted to a slice nothing is asking
for. A view that resolves to *no* nodes now shows no nodes: an empty
`visibleNodeIds` is a restriction like any other, and only an absent one means
"no id restriction". `patchFilters` reads `visibleNodeIds` by presence, so
passing it as `undefined` is how a caller clears it.

Prose from a schema YAML is escaped before it lands in a JSDoc block, so a
description containing a comment-closing star-slash no longer emits a module
that will not parse.

`collabnode types constructor` (or any argument sharing a name with an
`Object.prototype` key) is read as a positional argument again rather than
being mistaken for a flag.
