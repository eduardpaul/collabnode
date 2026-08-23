import { buildTools, toolJsonSchema, type BoundTool, type CollabSession } from "collabnode";

/** A function tool as Voice Live / the realtime event protocol expects it. */
export interface VoiceLiveTool {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * Voice models do worse with long tool lists, and a mishearing should not be
 * able to destroy a note. So the voice agent gets reads plus identity upserts —
 * no `graph_delete_*`, no `graph_query`, no whole-graph snapshot. Widen this if
 * you want the agent to be able to remove things.
 */
function forVoice(tool: BoundTool): boolean {
  return (
    ["graph_list", "graph_get", "graph_search", "graph_similar", "graph_neighbors"].includes(
      tool.name,
    ) ||
    tool.name.startsWith("upsert_node_") ||
    tool.name.startsWith("upsert_edge_")
  );
}

export interface VoiceToolset {
  /** Sent in the `session` config of `rtc.call.sdp.create`. */
  definitions: VoiceLiveTool[];
  /** Runs one `response.function_call_arguments.done` against the graph. */
  call(name: string, args: Record<string, unknown>): Promise<string>;
  names: string[];
}

/**
 * The same schema-driven catalog the MCP server exposes at `/mcp`, re-dressed
 * as Voice Live function tools. Writes are stamped with `actorId` so the graph
 * shows who spoke versus who typed.
 */
export function voiceToolset(
  session: CollabSession,
  actorId: string,
  graphKind = "memory",
  language?: string,
): VoiceToolset {
  const bound =
    session.schema.config.changeTracking.enabled && session.actorId !== actorId
      ? session.runAs(actorId)
      : session;
  // `language` reaches every generated description: the built-in wording comes
  // from the MCP locale catalog, the per-type wording from the `es:` keys in
  // the workspace YAML. The tool *names* stay as they are — they are the wire
  // protocol, and a model that hears Spanish still calls `upsert_node_Note`.
  const tools = buildTools(bound.schema, bound, { graphKind, language }).filter(forVoice);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  return {
    definitions: tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      // `toolJsonSchema` mirrors the schema's `required: true` flags into the
      // definition. Without that a voice model reads every upsert argument as
      // optional and says "I've added the note" having sent only a title.
      parameters: toolJsonSchema(tool, bound.schema),
    })),
    names: tools.map((tool) => tool.name),
    async call(name, args) {
      const tool = byName.get(normalizeToolName(name, byName));
      if (!tool) {
        // Tell the model what it may call, so a bad name self-corrects instead
        // of turning into "let me try that again" forever.
        return JSON.stringify({
          error: `unknown tool ${name}`,
          available: [...byName.keys()],
        });
      }
      const result = await tool.handler(args ?? {});
      const text = result.content[0]?.text ?? "";
      return result.isError ? JSON.stringify({ error: text }) : text;
    },
  };
}

/**
 * Some realtime models leak their internal channel markers into the tool call —
 * `azure-realtime` (preview) emits names like `graph_search<|meta_sep|>commentary`.
 * Cut at the first control token and fall back to a case-insensitive match, so a
 * leaky model still reaches the right tool.
 */
export function normalizeToolName(raw: string, known: ReadonlyMap<string, unknown>): string {
  if (known.has(raw)) {
    return raw;
  }
  const cut = raw.split("<")[0]?.trim().replace(/[^A-Za-z0-9_]+$/, "") ?? "";
  if (known.has(cut)) {
    return cut;
  }
  const lower = cut.toLowerCase();
  for (const name of known.keys()) {
    if (name.toLowerCase() === lower) {
      return name;
    }
  }
  return cut || raw;
}

/**
 * Function-call arguments arrive as a JSON string, can be empty, and — same
 * preview defect as above — can carry trailing junk after the closing brace.
 * So fall back to scanning out the first balanced object rather than giving up
 * and calling the tool with no arguments at all.
 */
export function parseToolArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || !raw.trim()) {
    return {};
  }
  return asRecord(tryParse(raw)) ?? asRecord(tryParse(firstJsonObject(raw))) ?? {};
}

function tryParse(text: string | undefined): unknown {
  if (text === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The first balanced `{...}`, skipping braces that sit inside string literals. */
function firstJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) {
    return undefined;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
    } else if (char === '"') {
      inString = !inString;
    } else if (!inString && char === "{") {
      depth += 1;
    } else if (!inString && char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return undefined;
}
