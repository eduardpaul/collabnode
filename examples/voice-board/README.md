# Voice Notes

The [notes-board](../notes-board) sample with the keyboard taken away. You **talk** to the graph: speech goes to [Azure Voice Live over WebRTC](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live-webrtc), and the model's tool calls land in the same `text` CRDT your browser tabs are editing.

```bash
pnpm build
pnpm --filter @collabnode/example-voice-board start
```

Open the homepage and pick a board, or start a new one:

- http://127.0.0.1:4175?as=ada
- http://127.0.0.1:4175?as=chidi

Two boards come up seeded — one of each type — so there is something to talk to
on the first run. Open one, tap the mic and dictate — the note rewrites itself in both tabs. Pick a note card to edit it by hand; the editor binds `session.collabText(id, "body")`. Fluid is the default backend; Hocuspocus:

```bash
COLLAB_BACKEND=hocuspocus pnpm --filter @collabnode/example-voice-board start
```

## Boards

`?workspace=<id>` is the whole router: with one you get a board, without one you
get the homepage. Boards are opened at runtime rather than fixed at boot —
**+ New board** on either tile creates one, seeds it, and drops you straight
into it.

The create form is not written anywhere in the client. It is generated from the
`params:` block of the chosen type's YAML, defaults included, so a C4 board asks
for a system name and a primary user while a voice board asks for an author:

```yaml
params:
  systemName:
    type: string
    default: "My Software System"
    description:
      en: Name of the software system at the centre of the model
```

Those values go to `hub.open(type, { params })`, which seeds the new board from
the type's `template:` — create a C4 board called *Payments* and the graph is
already holding that system and its primary user before the page finishes
loading. That is the whole reason a third board type is a new file in
[`workspaces/`](workspaces/) plus one `hub.define`: its tile, its create form,
its voice tools, its MCP mount, and its starter graph all follow from the YAML,
and neither [`src/home.ts`](src/home.ts) nor [`src/server.ts`](src/server.ts)
learns its name.

The board id is a slug of the name you typed (`Payments Platform` →
`c4-architecture-payments-platform`), because that id is also the page URL and
the MCP mount path:

```
http://127.0.0.1:4175/mcp/w/c4-architecture-payments-platform
```

[`src/boards.ts`](src/boards.ts) is the directory itself — a thin read over the
Hub, which already mints, seeds, and leases. The one thing it adds is the *name*
someone typed, which cannot live in the id.

**Delete** ends the board through the Hub's termination sequence — projector
drained, snapshot and history captured into a `WorkspaceArtifact`, then the
registry record dropped so the id is free again. `retention.onEnd: keep` in both
YAMLs is what keeps the artifact rather than destroying the document. Tabs still
sitting on a deleted board keep their local CRDT copy until they reload; on
reload the join is a 404 and the page offers the homepage instead. There is no
default board to fall back to on purpose — a stale bookmark should say the board
is gone, not quietly hand you a different one.

The seeded pair is not special: [`src/server.ts`](src/server.ts) opens it
through the same `hub.open` the button uses, just with fixed ids so the links in
this README keep working.

## Setup

Copy `.env.example` to `.env`:

```
AZURE_VOICE_LIVE_ENDPOINT=https://<resource>.services.ai.azure.com
AZURE_VOICE_LIVE_API_KEY=...
AZURE_VOICE_LIVE_MODEL=gpt-realtime
```

Leave `AZURE_VOICE_LIVE_VOICE` unset and the voice follows the page language
(`en-US-AvaNeural` / `es-ES-ElviraNeural`); setting it pins one voice for every
language.

A Microsoft Foundry resource works; a project endpoint (`.../api/projects/<project>`) is fine too, since only the host is used. For keyless auth, leave the key empty and set `AZURE_VOICE_LIVE_TOKEN` to a token for the `https://ai.azure.com/.default` scope. Restart the process after saving `.env`.

Voice needs a secure context: `127.0.0.1` counts, but if you expose the port to another machine you need TLS or the microphone prompt never appears.

## Languages

The sample ships in English and Spanish, and the switch is one query parameter:

- http://127.0.0.1:4175?lang=es&as=ada
- http://127.0.0.1:4175?workspace=c4-architecture-1&lang=es&as=ada

With no `?lang=`, the page follows the browser's own preference and the server
falls back to `VOICE_BOARD_LANG` (default `en`). Anything the app has no strings
for renders in English rather than half-translated.

One language moves four things at once, which is the point:

| Layer | Where the Spanish lives |
| --- | --- |
| Page chrome — buttons, captions, prompts | [`src/i18n.ts`](src/i18n.ts) |
| Node/edge descriptions, guidelines, edge labels, named tools, agent prompts | the `es:` keys in [`workspaces/*.yaml`](workspaces/voice-board.yaml) |
| Built-in tool and prompt wording (`graph_search`, `upsert_node_*`) | the locale catalog in `@collabnode/mcp` |
| The spoken voice and input transcription | `es-ES-ElviraNeural`, `language: "es"` |

The schema half is the interesting one. `description`, `guidelines`, `ui.label`,
`display.title`, param and named-tool descriptions, and an agent's
`systemPrompt` all accept either a plain string or a per-language map:

```yaml
Note:
  description:
    en: A collaborative markdown note, usually dictated out loud
    es: Una nota markdown colaborativa, normalmente dictada en voz alta
  guidelines:
    en:
      - Titles are short
    es:
      - Los títulos son cortos
```

`@collabnode/schema` resolves those against the requested language, falling back
through the bare subtag (`es-MX` → `es`), then `en`. So the tool description the
voice model is handed — and the one an MCP client at `/mcp/w/<id>?lang=es` sees —
is Spanish without a line of app code, and adding a third language is a YAML
edit plus one entry in `src/i18n.ts`.

What deliberately does *not* translate is the wire protocol: tool names stay
`upsert_node_Note`, and enum values stay `todo` / `doing` / `done`. Only the
badge text changes, so a Spanish tab and an English tab can edit the same task
without fighting over what got written to the graph.
[`src/voice-i18n.test.ts`](src/voice-i18n.test.ts) asserts both halves — that
every layer really is translated, and that the protocol layer really isn't.

## The two views

The default screen is built for someone who has never heard of a graph: a large mic, plain-language status, notes as cards, and tool calls rendered as “Saved Weekend Plan” rather than `upsert_node_Note`. The ring around the mic tracks live input level, because a caption claiming the app is listening is a promise and a moving ring is proof.

Everything technical lives behind **Developer view** at the bottom: the model and MCP endpoint, the live `<collab-graph>`, and the raw tool-call log. The graph mounts on first open rather than at page load — vis-network measures its canvas on creation, and inside a closed `<details>` that measurement is zero.

The graph canvas stays dark on the light page on purpose: vis draws node labels on canvas with colours baked into [`packages/web/src/view/apply.ts`](../../packages/web/src/view/apply.ts), so a light stage would need those plumbed through as well. Worth doing in the web package if you want a light graph; out of scope here.

## How the three channels fit together

Voice Live splits one call across three transports, and this sample puts each one where it belongs:

| Channel | Between | Carries |
| --- | --- | --- |
| WebSocket control | **server** ↔ Azure | SDP exchange, then tool calls |
| WebRTC media (RTP) | **browser** ↔ Azure | Microphone audio, the model's spoken reply |
| WebRTC data channel | **browser** ↔ Azure | VAD, transcripts, response lifecycle |

The browser builds the offer and gathers ICE ([`src/voice-client.ts`](src/voice-client.ts)), but posts it to `/api/voice/offer` rather than to Azure. The server holds the credentials, opens the control channel at `voice-live/realtime/calls`, sends `rtc.call.sdp.create` with the session config, and hands the `sdp_answer` back ([`src/voice-live.ts`](src/voice-live.ts)). Audio then flows browser ↔ Azure directly — it never passes through Node.

That split is what makes the API key a server-side secret, and it is also why tool calls work: Voice Live deliberately routes `response.function_call_arguments.done` to the control channel so a backend can execute it. The server runs the call against the `CollabSession`, replies with `conversation.item.create` (`function_call_output`) plus `response.create`, and the model speaks the confirmation.

## Tools

The voice agent is handed the **same schema-driven catalog** the MCP server exposes at `/mcp`, converted from Zod to JSON Schema in [`src/voice-tools.ts`](src/voice-tools.ts):

`graph_list`, `graph_get`, `graph_search`, `graph_similar`, `graph_neighbors`, `upsert_node_Note`, `upsert_node_Person`, `upsert_edge_AUTHORED`

(`graph_similar` appears only when embeddings are configured — see below.)

Reads plus identity upserts, and nothing destructive — a long tool list slows a realtime model down, and a mishearing should not be able to delete a note. Widen `forVoice()` if you want `graph_delete_*` on the list. Writes are stamped `meta.updatedBy: "echo"`, so the graph shows what was spoken versus what someone typed.

Because the tools are generated from `schema.yaml`, adding a node type to the YAML gives the voice agent a new verb with no code change.

MCP (Cursor, Claude Desktop, extra agent hosts) still points at the same graph:

```
http://127.0.0.1:4175/mcp
```

## Things worth knowing

- **Use `gpt-realtime`, not `azure-realtime`.** The `azure-realtime` preview leaks harmony control tokens into its tool calls — names arrive as `graph_search<|meta_sep|>commentary`, and arguments as `{"q":"Groceries"}search<|meta_sep|>analysis code`. That breaks the name lookup *and* `JSON.parse`, so every graph write silently fails and the agent loops on "let me try that again". `normalizeToolName` and `parseToolArgs` in [`src/voice-tools.ts`](src/voice-tools.ts) recover from both, but `gpt-realtime` simply doesn't do it. The two models take different voice catalogs (`azure-standard` vs `azure-realtime-native`), so `defaultVoice()` follows the model.
- **Turn detection** uses `azure_semantic_vad` with `remove_filler_words`, so pausing mid-sentence while you think does not end your turn. `server_vad` cuts dictation off at every gap.
- **Spoken titles never match typed ones.** Speech-to-text hands the model a spelling nobody stored — you say "the stand-up note", it searches `Stand-Up`, and a plain substring test misses `Standup` entirely. `graph_search` is answered by whichever graph store backs the session: Ladybug runs its FTS extension, the in-memory store runs an equivalent scan. Both index the text through the same normalizer, which adds the punctuation-free join of each name (`Stand-Up` and `Stand Up` both contribute `standup`) to the ordinary words. Because it is applied to stored text and query text alike, it does not matter which side was hyphenated. Which properties get indexed is declared in [`schema.yaml`](schema.yaml) — `search: true`, or `search: { boost: 6 }` to make a title outweigh body prose. An exact title match is then pushed to the top, so BM25 cannot let a note that merely *says* "standup" outrank the note actually called that. The same folding guards the write path: upserting `Stand-Up` adopts the existing `Standup` note instead of minting a second one from a different title hash. Real typos (`standp`) are not covered — token search has no fuzzy matching, and those fall through to the substring scan.
- **Asking about a subject is not the same as asking for a note.** "What did we decide about hiring?" shares no word with a note called *Q3 headcount*, so no amount of spelling tolerance will find it. Properties marked `vector: true` in [`schema.yaml`](schema.yaml) are embedded as well as indexed, and `graph_search` runs both, fusing the two rankings by [reciprocal rank](https://dl.acm.org/doi/10.1145/1571941.1572114) — their scores are not comparable, only their orders. Every hit carries `match`: `text` when the wording matched, `vector` when the meaning did, `both` when they agree. Asking by name still wins outright, because the exact-title bonus outweighs anything fusion produces. `graph_similar` takes a node id instead of a query, which is the one thing no search string can express — "more notes like this one". Both are off unless an embedding provider is configured; `pnpm add @huggingface/transformers` in this example turns them on, and the server prints which mode it started in.
- **The embedding model is local and downloaded once.** `embeddings: { kind: "local" }` runs bge-small-en-v1.5 (384 dimensions, ~30 MB quantized) in-process through transformers.js — no API key, no text leaving the machine. First use pays ~6 s to load; after that a note embeds in about 3 ms, on the write path, so a note is semantically findable the moment it is dictated. One vector covers the whole note, so a long body dilutes a short title, and text past the model's 512-token window is not embedded at all.
- **`body` is replaced, not appended.** The persona tells the model to pass the full markdown every time; `text` fields store what the tool call sends. The schema's `required: true` flags are mirrored into the tool definition — without that, `buildTools` marks every upsert argument optional and the model happily creates a titled note with an empty body while saying it saved your content.
- **`VOICE_DEBUG=1`** logs every function call the model makes, raw and parsed, which is the fastest way to tell "the model didn't send it" from "we didn't store it".
- **Barge-in works** — start talking over the reply and it stops.
- Tool activity arrives in the browser over SSE (`/api/voice/log`) rather than the data channel, because the tool call ran on the server.
