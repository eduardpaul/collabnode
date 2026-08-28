---
"@collabnode/deepagents": minor
"@collabnode/mcp": minor
"collabnode": minor
---

Move the structured-output loop into `@collabnode/deepagents`, and write plans
from there too.

`invokeStructured` asks a model for a Zod-checked answer, and — because
`withStructuredOutput` occupies the provider's function-calling channel — runs
any tools in a prior loop and carries their findings across as prose. It came
with `runToolCallingLoop`, `summarizeToolTranscript`, `toBindableTools` and
`readOnlyTools`, which filters on the `metadata.readOnly` annotation that
`bindAgentTools` writes: the producer was already in this package and the only
consumer was an example. `bindAgentTools` now shares the provider schema
sanitiser rather than keeping a second, subtly different copy of it.

`applyPlan` writes a `GraphPlan` as one atomic batch. Endpoints resolve as a
plan `ref` first and a live id second, so a hallucinated endpoint costs one edge
rather than the whole turn, and the dropped ones are reported. `stamp` writes
properties over whatever the model said, per node type; `transform` is the last
look at an entry before it lands, and dropping it is how an app rejects one.

`planEnvelope` (in `@collabnode/mcp`) wraps a plan in the rest of an answer — a
sentence on what changed, a verdict, ids to remove — keeping the plan's type
through the wrapper. It takes `before` and `after` rather than one map because
key order is prompt order: a model fills a structured answer in schema order, so
a field it should reason through goes ahead of the plan and a judgement on the
plan goes behind it.

Together these are typed end to end: `planZod<S>` says what may be answered,
`planEnvelope` keeps that type through the envelope, `invokeStructured` infers
it, and `applyPlan` writes it. The solution-planner sample lost five casts to
this and kept only what is genuinely its own — its credentials, its scopes, its
Task normalisation.
