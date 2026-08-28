# Solution Planner — Collaborative AI Multi-Agent Planner

A minimalist, YAGNI-focused real-time collaborative application demonstrating **collabnode**'s distributed graph capabilities, React hooks (`@collabnode/react`), and **LangGraph 1.x** multi-agent cyclic workflows with human-in-the-loop validation.

---

## Highlights

- **Real-Time Collaboration**: Powered by `collabnode` CRDT runtime (`CollabSession`) with Fluid Framework relay & Redis/Memory registry.
- **Multi-Agent Cyclic Workflow (LangChain 1.x / LangGraph 1.x)**:
  - **AI Manager**: Responsible for business Epics, Features, Business Risks, and raising strategic Assumptions.
  - **AI Architect**: Reads Manager's scope, consults [Microsoft Learn MCP](https://learn.microsoft.com/api/mcp) while working (`microsoft_docs_search`, `microsoft_docs_fetch`, `microsoft_code_sample_search`), then generates C4 as **C4DiagramElement** nodes whose `type` is Person, System, Boundary, Container, or Component (`external: true` renders as Mermaid `_Ext`) and decomposes work into Tasks.
  - **Consensus Loop**: Agents take turns mutating shared state until both agree (`managerAgrees && architectAgrees`).
- **Dirty nodes + on-demand revision**: Human edits mark nodes `dirty` (an Epic dirties its Features and Tasks). **Revise dirty nodes** re-runs the Manager ↔ Architect loop against that subgraph so they adapt the plan and raise risks, then clear the flags. You can attach an optional **review note** so the crew has extra context for the change.
- **Human-In-The-Loop (HITL)**: When either agent flags a critical assumption, LangGraph pauses execution (`waiting_user_validation`) and waits for human approval or rejection via the UI before resuming.
- **Task estimation**: Tasks have no workflow status (they are estimates, not a board). Each task's **description** must include **What** (functional outcome) and **How** (technical approach). Effort is scored as:
  1. **Functional Points**: Fibonacci story points (`1, 2, 3, 5, 8, 13, 21`) for functional effort.
  2. **Technical Points**: Fibonacci story points (`1, 2, 3, 5, 8, 13, 21`) for technical effort.
  3. **Complexity**: 0 (Trivial) to 5 (Massive architectural overhaul).
  4. **Uncertainty**: 0 (Done 100x) to 5 (Pure R&D).
  5. **Friction**: 0 (Solo work) to 5 (Heavy cross-team/vendor coordination).
  6. **NFR Scale**: 0 (Low/Internal) to 3 (Extreme compliance/scale).
- **Typed against its own schema**: `src/workspace.types.ts` is generated from `workspaces/solution-planner.yaml` by `collabnode types`, and the dev server regenerates it on save (`collabnodeTypes()` from `collabnode/vite`). `PlannerSession` in `src/agent/session.ts` is `CollabSession<SolutionPlanner>`, so a renamed property or a value outside an enum is a compile error rather than a runtime one. See [Typed schemas](../../README.md#typed-schemas-collabnode-types).
- **First-Class React Integration**: Built with `@collabnode/react` hooks (`useCollab`, `useCollabSnapshot`, `useCollabNodes`, etc.).
- **Live Graph Canvas**: Embedded `<collab-graph>` from `@collabnode/graph-view`. The sample also has a local `<collab-mermaid>` that turns planner nodes into Mermaid DSL and renders them with mermaid.js — C4 containers each have their own node, and the C4 diagram is assembled from those nodes.
- **Bilingual (English & Spanish)**: Full UI toggle and automatic language detection for agent responses.
- **Microsoft Learn grounding**: When an LLM is configured, the Architect runs a tool-calling loop against Microsoft Learn MCP *before* structured output (a single `withStructuredOutput` call cannot mix tools). Disable with `MICROSOFT_LEARN_MCP=0`.
- **Zero-API-Key Local DX**: Runs seamlessly out of the box with deterministic simulation, or with real LLMs (`OPENAI_API_KEY`, `GEMINI_API_KEY`).

---

## Getting Started

### 1. Start the Planner

```bash
pnpm --filter @collabnode/example-solution-planner dev
```

Open [http://127.0.0.1:4180](http://127.0.0.1:4180) in your browser.

### 2. Run Tests

```bash
pnpm --filter @collabnode/example-solution-planner test
```

That runs the planner consensus tests, a functional usability journey (edit a dirty Epic, attach a review note, assert the Manager ↔ Architect loop uses it), and the Architect's Microsoft Learn MCP tool-calling loop.

Live Foundry + Microsoft Learn (requires `.env` credentials and `MICROSOFT_LEARN_MCP=1`):

```bash
pnpm --filter @collabnode/example-solution-planner test:llm
```

That fails if the LLM is missing, Learn MCP tools do not load, or the Architect produces a plan without calling Microsoft Learn tools.

### 3. Change the schema

Edit `workspaces/solution-planner.yaml` and save. `src/workspace.types.ts` is
rewritten by the dev server, and anything that no longer matches goes red in the
editor — nothing to run. Outside a dev server:

```bash
pnpm --filter @collabnode/example-solution-planner gen:types    # regenerate
pnpm --filter @collabnode/example-solution-planner check:types  # CI: fail if stale
```

The generated file is checked in. Do not edit it by hand.

---

## Environment Variables (Optional)

```bash
# LLM Providers (optional - deterministic simulator runs if omitted)
OPENAI_API_KEY="sk-..."
GEMINI_API_KEY="..."

# Collab & Registry backends
COLLAB_BACKEND="fluid" # "fluid" (default) or "hocuspocus"
REDIS_URL="redis://127.0.0.1:6379" # optional Redis registry
PORT=4180

# Microsoft Learn MCP (Architect). Public, no auth. Set to 0 to disable.
# MICROSOFT_LEARN_MCP=0
# MICROSOFT_LEARN_MCP_URL="https://learn.microsoft.com/api/mcp"
```
