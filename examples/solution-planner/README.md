# Solution Planner — Collaborative Deep Agents

A real-time collaborative planner: a human, an AI Product Manager, and an AI Architect write the same collabnode graph. The Manager is a Deep Agent the user talks to; the Architect is a subagent it delegates to.

---

## How it works

- **Shared workspace**: Fluid (or memory) CRDT. The board and the agents see the same nodes and edges as they appear.
- **Talk to the Manager**: one prompt box. The Manager reads `view_solution_view` (requirements on `SolutionState` plus the current plan), writes Epics / Features / business risks / assumptions, and **delegates** C4, Tasks, and technical risks to the `architect` subagent.
- **Live writes**: graph tools mutate the `CollabSession` immediately. You watch cards and mermaid update while the HTTP call is still open.
- **Dirty edits**: change a node on the board and it marks `dirty` (and descendants). **Adapt my edits** asks the Manager to call `view_dirty_review` and fix only that subgraph.
- **HITL**: a pending Assumption pauses the crew (`waiting_user_validation`). Approve or reject on the banner; that is another message on the same Manager thread.
- **Typed schema**: `src/workspace.types.ts` is generated from `workspaces/solution-planner.yaml`. Saving the YAML in `dev` regenerates it.

There is no LangGraph consensus cycle and no structured-output plan batch. Tools are the schema; the Deep Agent loop is the planner.

---

## Getting Started

```bash
pnpm --filter @collabnode/example-solution-planner dev
```

Open [http://127.0.0.1:4180](http://127.0.0.1:4180).

### Tests

```bash
pnpm --filter @collabnode/example-solution-planner test
```

Live LLM (requires `.env` credentials):

```bash
pnpm --filter @collabnode/example-solution-planner test:llm
```

### Optimize agent prompts (GEPA)

GEPA evaluates the live Manager + Architect crew on a locked Azure brief, scores the graph with a deterministic rubric, reflects on the traces, and mutates `systemPrompt.en` for both roles. Every rollout uses the same Azure deployment as the app (`getChatModel()`). Reflection defaults to that same model.

```bash
pip install gepa
pnpm --filter @collabnode/example-solution-planner opt:prompts
pnpm --filter @collabnode/example-solution-planner opt:prompts -- --apply-winner
pnpm --filter @collabnode/example-solution-planner opt:prompts -- --max-metric-calls 8
```

`--apply-winner` writes the winner into `workspaces/solution-planner.yaml` (English prompts only). Artifacts land in `prompt-trials/<timestamp>/` (`compare.md`, `best_candidate.json`, per-trial JSON). Default `max_metric_calls` is 4 (baseline plus a few mutations) so a run stays on the order of minutes.

Do not run this unattended on a production key: each trial is a full crew turn (~3 min wall, real tokens).

### Change the schema

Edit `workspaces/solution-planner.yaml` and save. Types regenerate in `dev`.

```bash
pnpm --filter @collabnode/example-solution-planner gen:types
pnpm --filter @collabnode/example-solution-planner check:types
```

---

## Environment

```bash
# LLM (required for the Manager). First match wins unless LLM_PROVIDER is set.
AZURE_OPENAI_API_KEY="..."
AZURE_OPENAI_ENDPOINT="https://....openai.azure.com"
AZURE_OPENAI_DEPLOYMENT_NAME="gpt-4o"
# or OPENAI_API_KEY / GEMINI_API_KEY
LLM_PROVIDER=azure   # optional: azure | openai | gemini

# Microsoft Learn MCP for the Architect (optional; disable with 0)
MICROSOFT_LEARN_MCP=1
MICROSOFT_LEARN_MCP_URL="https://learn.microsoft.com/api/mcp"

COLLAB_BACKEND=fluid   # fluid | memory | hocuspocus
REDIS_URL=             # optional registry
PORT=4180
```

Without an API key the board still opens; sending a prompt returns 503 instead of inventing a plan.

---

## Roles (from the YAML)

| | Manager | Architect |
|---|---|---|
| Who starts it | You, via **Talk to the Manager** | The Manager, via Deep Agents `task` |
| Writes | Epic, Feature, business Risk, Assumption | C4DiagramElement, Task, technical Risk, Assumption |
| Read-only | C4, Task | Epic, Feature |
| Compliance | `view_solution_view` → `managerAgrees` | `view_solution_view` → `architectAgrees` |
