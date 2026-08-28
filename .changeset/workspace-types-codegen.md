---
"@collabnode/schema": minor
"@collabnode/graph": minor
"@collabnode/runtime": minor
"@collabnode/react": minor
"@collabnode/mcp": minor
"@collabnode/cli": minor
"collabnode": minor
---

Generate TypeScript types for a workspace, and thread them through the runtime.

`collabnode types <workspace.yaml> -o <file.ts>` emits a module holding the schema
as an `as const` literal plus `GraphTypes<typeof it>` — every node and edge type,
their read and write property shapes, and the endpoints each edge type allows.
JSDoc'd interfaces are emitted alongside for hover documentation, each pinned to
the inferred shape by a generated `Expect<Equal<…>>`, so the two cannot drift.
`--check` fails when the file is stale (for CI), `--watch` regenerates on change,
and `collabnodeTypes()` from `collabnode/vite` does the same inside a dev server —
save the YAML and the editor picks the new types up with nothing to run by hand.

Pass that type map to `CollabSession<S>`, `BatchBuilder<S>`, `GraphSnapshot<S>`,
the React hooks (`useCollab`, `useCollabJoin`, `useCollabNodes`, …) or
`planZod<S>` and reads and writes are checked against that one schema: a snapshot
is a union discriminated on `type`, `properties` is that type's own shape, and an
enum is its declared values rather than an open string. Every generic defaults to
`AnyGraph`, which instantiates to exactly the previous untyped shapes — existing
code compiles unchanged. `session.as<S>()` puts the types on a session that
arrived from something schema-agnostic like the hub, and `session.as()` takes
them off again for library APIs that serve any schema.

The write shape models the runtime faithfully: an upsert is a merge whenever the
node exists, so every property is optional and `NodeCreate` is the stricter shape
for a known create; derived properties are absent from writes entirely; CRDT
properties are always present on read because `hydrateNode` materializes them;
and `json` reads back as the string the runtime stores.

Selecting from a typed snapshot comes with it: `nodesOfType`, `nodeOfType`,
`singletonOfType`, `edgesOfType`, and the general `ofType`/`findOfType` for
anything discriminated on `type` — a plan's entries as much as a snapshot's
nodes. `filter((n) => n.type === "Epic")` is already type-safe against a typo,
but it hands back the whole union; these carry the narrowing out, so reading a
property only Epics have compiles. `SnapshotMarkdownOptions.types` and `.fields`
are checked against the schema's node names too.

Also deduplicated along the way: `UpsertNodeInput`, `UpsertEdgeInput`, `NodeRef`
and `GraphOpInput` were declared twice (in `@collabnode/schema` and again in
`@collabnode/runtime`) and are now declared once, as are `PropertyValue` and
`PropertyMap`.
