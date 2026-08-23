---
"@collabnode/schema": minor
"@collabnode/runtime": minor
"@collabnode/mcp": minor
"collabnode": minor
---

`singleton: true` on a node type: one node of that type per workspace.

For the state a workspace *has* rather than the things it *contains* — a status
node, a settings node, a board's configuration. Without it, a type with no
`identity:` mints a new node on every id-less upsert, so a workspace that writes
its status on each step ends up with one node per step and readers take
whichever the projection happens to return first. The workaround is for every
writer to find the node and pass its id, which every caller has to remember.

```yaml
nodes:
  BoardState:
    singleton: true
    properties:
      status: { type: enum, values: [idle, planning, approved], default: idle }
```

- Every write lands on the same node, whether or not the caller knows its id.
- The id is derived from the schema and the type name, so two replicas creating
  it at once converge on one node instead of two.
- A node created under another id before the type became singleton is adopted,
  not duplicated.
- An explicit id that points at some other node is refused rather than silently
  redirected.
- `upsert_node_*` for a singleton takes no `id` argument and says there is only
  one; `graph_describe` and the generated prompts report it. Required properties
  are enforced on create and not on update, so an agent can set one field
  without restating the rest.
- Mutually exclusive with `identity:`, and refused in a template's `forEach`,
  where every iteration would write to the same node.

`examples/solution-planner` now declares its `SolutionState` singleton and
writes it with a plain `upsertNode`.
