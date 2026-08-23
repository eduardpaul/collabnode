---
"@collabnode/runtime": minor
"@collabnode/schema": minor
"collabnode": minor
---

The primitives an agent loop needs against a live workspace, which shipped
without a changeset:

- **`session.batch(fn)`** and **`session.applyBatch(ops)`** — several node and
  edge writes applied as one, with `ref` naming a node created earlier in the
  same batch. `BatchBuilder` is the fluent form.

- **`session.diffSince(previous)`** — what changed since a snapshot you took
  earlier, as ops and as Markdown.

- **`snapshotToMarkdown` / `diffSnapshotsToMarkdown`** — a graph, or a change to
  one, as token-efficient Markdown for a prompt.

- **`schemaToJsonSchema` / `nodeTypeToJsonSchema` / `propertyDefToJsonSchema`**
  in `@collabnode/schema` — a workspace's node types as JSON Schema, for
  structured model output that matches what the graph will accept.
