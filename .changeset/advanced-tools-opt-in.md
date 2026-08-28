---
"@collabnode/schema": minor
"@collabnode/mcp": minor
"collabnode": minor
---

Take four generated tools out of the default MCP surface and put them behind a
new `tools.advanced` opt-in.

`graph_snapshot`, `graph_diff_since`, `graph_query` and `graph_apply_batch` all
ask the model to hold the whole graph in its head, which is where small models
fall over. With `views:` in the DSL they are also mostly redundant:

- **`graph_snapshot`** returns every node, every property and every edge. A
  declared view — or `graph_list` / `graph_get` — answers the same question in a
  fraction of the tokens.
- **`graph_diff_since`** takes an entire previous snapshot back as an *argument*,
  so a model has to carry one between turns to use it at all.
  `graph_changes({ since })` needs a timestamp.
- **`graph_query`** needs Cypher, and only works where a projection is
  configured. A view's `traverse` covers the reachability questions agents
  actually ask, and `graph_neighbors` covers the rest.
- **`graph_apply_batch`** holds every write until the whole batch lands. In a
  live collaborative document that is backwards: one `upsert_node_*` per write
  streams each change to the other participants as it happens.

A workspace that wants one names it:

```yaml
tools:
  advanced: [graph_query]
```

`advanced` is additive and independent of `expose` — `expose` filters what was
generated, `advanced` decides what is generated at all, so `expose: ["*"]` does
not bring these back. The node policy still governs them: a role with `hidden`
types gets no `graph_query` or `graph_diff_since` however the workspace is
configured.

Two things follow from the surface no longer being fixed:

- **`graph_describe`** now advertises only the reads the caller actually
  received, instead of a hardcoded list that named tools it did not have.
- The "prefer targeted reads over `graph_snapshot`" system-prompt rule is only
  emitted where `graph_snapshot` exists to be preferred against.
