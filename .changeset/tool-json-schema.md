---
"@collabnode/mcp": minor
"collabnode": minor
---

`toolJsonSchema(tool, schema)` and `toJsonSchemaTools(tools, schema)`: the
generated tools as JSON Schema, for the function-calling APIs that take no zod —
realtime voice models, chat-completions `tools`, anything speaking the OpenAI
function shape.

Passing the schema is what gets `required` right. `buildTools` makes every
upsert property optional, because an upsert is also a partial update — but a
model reads optional-everything as permission to create a Note with a title and
no body, say "I've added the note with the details", and move on. The schema's
own `required: true` flags are mirrored into the JSON Schema, where the model
will actually obey them.

Both voice-board samples had hand-rolled this conversion, re-deriving `required`
from the workspace YAML each time.
