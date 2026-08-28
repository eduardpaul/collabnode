---
"@collabnode/mcp": minor
"collabnode": minor
---

Structured-output schemas generated from the workspace YAML, and plans that reference nodes by id or ref instead of by title.

**Library**

- `nodeZod(schema, type, { language, mode, omit })` — the zod schema for one node type, straight from the YAML: property types, enum values, bounds, and the type's own description and guidelines. This is what an agent should be asked to fill in, instead of a hand-written second copy of the schema that drifts from it.
- `planZod(schema, { nodeTypes, edgeTypes, language, mode, omit })` — a whole plan as one schema: nodes each carrying a `ref` the plan chooses (and an `id` when they update something that already exists), and edges naming their endpoints by that `ref` or by a live node id. There is deliberately nowhere to put a parent's *title*.
- `mode: "strict"` targets OpenAI/Azure `json_schema` strict mode: every key stays in `required` with `null` for "no value", and `minimum` / `maximum` / `maxLength` — which strict mode rejects outright — move into the property description, so a bound declared in YAML no longer takes the whole call down.
- Both are re-exported from `collabnode`, along with `propertyZod` / `propertiesZod`.

**Planner sample.** The Manager and Architect now answer with one plan shape derived from `solution-planner.yaml`, and `applyPlan` writes it as a single batch. `parentTitle`, `featureRef`, `c4Ref`, `threatensRef` and `relatesToRef` are gone, along with the title-matching `RefIndex` and the hand-maintained property allowlist: an endpoint is a plan `ref` or a node id, and anything else is dropped and reported. The Architect is asked for a complete C4 model — Person, System, Boundary, Container, Component — and can draw `USES` itself, and it logs which C4 levels a plan left empty. The HITL pause is now lifted on the shared graph before the resumed Architect starts, and both agents mark themselves as working on `SolutionState.activeAgent` while a step runs.
