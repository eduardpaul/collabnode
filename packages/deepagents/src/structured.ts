import type { BaseChatModel, BindToolsInput } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import { HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";

/**
 * Asking a model for a shape and letting it read the graph on the way there.
 *
 * `withStructuredOutput` occupies the provider's function-calling channel, so a
 * single call cannot both run tools and return a schema-checked answer. The
 * split here — a tool loop first, then the structured call over what the tools
 * found — is the workaround, and it is the same one for every provider, so it
 * belongs beside the agent configuration rather than in each app.
 *
 * Nothing here knows about a graph. `bindAgentTools` produces the tools this
 * consumes, and `runStructuredPlan` is the graph-shaped caller.
 */

/** One tool call and what it returned, for logging and progress reporting. */
export interface ToolEvent {
  name: string;
  args: unknown;
  result: string;
}

export interface StructuredInvokeOptions {
  /** Tools the model may call while composing the answer. */
  tools?: StructuredToolInterface[];
  system?: string;
  maxToolRounds?: number;
  onToolEvent?: (event: ToolEvent) => void;
}

/**
 * The tools an agent may use while *composing* an answer: queries and docs,
 * never writes.
 *
 * Graph tools carry `metadata.readOnly` from the schema's own annotation, set by
 * `bindAgentTools`. Anything else — a Learn MCP tool, say — has no graph reach
 * and is kept. A structured answer is written once, atomically, by its caller;
 * a second live write path would race it, and whichever landed second would
 * silently overwrite the other.
 */
export function readOnlyTools(tools: StructuredToolInterface[]): StructuredToolInterface[] {
  return tools.filter(
    (t) => (t as { metadata?: { readOnly?: boolean } }).metadata?.readOnly !== false,
  );
}

/**
 * A Zod schema, not a JSON Schema that happens to describe an object.
 *
 * The two are indistinguishable by `type` alone: a Zod v4 `ZodObject` carries
 * an own enumerable `type: "object"`, so a plain `type === "object"` test
 * accepts one and passes its internals off as a schema. `_zod` is the v4
 * internals marker; `safeParse` covers anything standard-schema shaped.
 */
function isZodSchema(schema: unknown): schema is z.ZodTypeAny {
  if (!schema || typeof schema !== "object") return false;
  return (
    "_zod" in schema ||
    "_def" in schema ||
    typeof (schema as { safeParse?: unknown }).safeParse === "function"
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isJsonSchemaObject(schema: unknown): schema is Record<string, unknown> {
  return (
    isPlainObject(schema) &&
    !isZodSchema(schema) &&
    (schema as { type?: string }).type === "object"
  );
}

/**
 * Strip the JSON Schema keywords the providers reject.
 *
 * Gemini's function declarations and Azure's `json_schema` mode both accept a
 * subset of draft-07: no `$schema`/`$id` bookkeeping, no `propertyNames` or
 * `patternProperties`, no `$ref`/`$defs` indirection, and `const` spelled as a
 * single-member `enum`. Returns a new object rather than editing in place —
 * the input is often a tool's own schema, which is reused across calls.
 */
export function sanitizeJsonSchema(schema: unknown): unknown {
  return sanitizeNode(schema, definitionsOf(schema), new Set());
}

/** `#/$defs/Name` (or the draft-07 `#/definitions/Name`) → `Name`. */
function refName(ref: string): string | undefined {
  const match = /^#\/(?:\$defs|definitions)\/([^/]+)$/.exec(ref);
  if (!match) return undefined;
  return decodeURIComponent(match[1]!).replace(/~1/g, "/").replace(/~0/g, "~");
}

function definitionsOf(schema: unknown): Record<string, unknown> {
  if (!isPlainObject(schema)) return {};
  const out: Record<string, unknown> = {};
  for (const key of ["$defs", "definitions"] as const) {
    const bag = schema[key];
    if (isPlainObject(bag)) Object.assign(out, bag);
  }
  return out;
}

/**
 * Replace a `$ref` with the definition it names.
 *
 * A `$ref` cannot simply be deleted — it *is* the shape — and the ref site's
 * own keywords (a `description`, say) win over the definition's. A ref that
 * reaches itself has no finite expansion and degrades to an unconstrained
 * object; so does one naming a definition that is not there.
 *
 * Mutates `obj` and returns the ref names seen on the way in, for the cycle
 * check on the level below.
 */
function inlineRef(
  obj: Record<string, unknown>,
  defs: Record<string, unknown>,
  path: ReadonlySet<string>,
): { schema: Record<string, unknown>; seen: ReadonlySet<string> } {
  if (typeof obj.$ref !== "string") {
    return { schema: obj, seen: path };
  }
  const name = refName(obj.$ref);
  delete obj.$ref;
  const target = name !== undefined && !path.has(name) ? defs[name] : undefined;
  if (!isPlainObject(target)) {
    if (obj.type === undefined) obj.type = "object";
    return { schema: obj, seen: path };
  }
  return { schema: { ...target, ...obj }, seen: new Set(path).add(name!) };
}

/** Walk the places a JSON Schema nests another one. */
function sanitizeChildren(
  obj: Record<string, unknown>,
  defs: Record<string, unknown>,
  seen: ReadonlySet<string>,
): void {
  if (isPlainObject(obj.properties)) {
    const props: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj.properties)) {
      props[key] = sanitizeNode(value, defs, seen);
    }
    obj.properties = props;
  }
  if (obj.items) {
    obj.items = sanitizeNode(obj.items, defs, seen);
  }
  if (isPlainObject(obj.additionalProperties)) {
    obj.additionalProperties = sanitizeNode(obj.additionalProperties, defs, seen);
  }
  for (const key of ["allOf", "anyOf", "oneOf"] as const) {
    if (Array.isArray(obj[key])) {
      obj[key] = (obj[key] as unknown[]).map((item) => sanitizeNode(item, defs, seen));
    }
  }
}

function sanitizeNode(
  schema: unknown,
  defs: Record<string, unknown>,
  path: ReadonlySet<string>,
): unknown {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map((item) => sanitizeNode(item, defs, path));

  const { schema: obj, seen } = inlineRef({ ...(schema as Record<string, unknown>) }, defs, path);

  if ("const" in obj) {
    obj.enum = [obj.const];
    delete obj.const;
  }

  delete obj.propertyNames;
  delete obj.$schema;
  delete obj.$id;
  delete obj.patternProperties;
  delete obj.$defs;
  delete obj.definitions;

  sanitizeChildren(obj, defs, seen);
  return obj;
}

/**
 * A tool's parameters as sanitized JSON Schema, whichever form it arrived in.
 *
 * An MCP tool hands over JSON Schema already; a LangChain tool built here hands
 * over Zod. Falling back to an empty object schema keeps one unconvertible tool
 * from failing the whole bind.
 */
export function toolParametersJsonSchema(schema: unknown): Record<string, unknown> {
  const empty = (): Record<string, unknown> => ({ type: "object", properties: {} });
  let raw: unknown = schema;
  if (!isJsonSchemaObject(raw)) {
    if (!isZodSchema(raw)) return empty();
    try {
      raw = z.toJSONSchema(raw, { target: "draft-7", unrepresentable: "any" });
    } catch {
      return empty();
    }
  }
  const clean = sanitizeJsonSchema(raw);
  return isJsonSchemaObject(clean) ? clean : empty();
}

/**
 * Prefer native LangChain tools (LangChain 1.x `bindTools` accepts JSON Schema).
 * Fall back to OpenAI / Gemini function defs with sanitized JSON schemas.
 */
export function toBindableTools(tools: StructuredToolInterface[]): BindToolsInput[] {
  return tools.map((t) => {
    let raw: unknown = t.schema;
    if (!isJsonSchemaObject(raw)) {
      if (!isZodSchema(raw)) return t;
      try {
        raw = z.toJSONSchema(raw, { target: "draft-7", unrepresentable: "any" });
      } catch {
        // Hand the tool back untouched so LangChain can try its own conversion
        // rather than sending an unconverted schema as `parameters`.
        return t;
      }
    }
    const clean = sanitizeJsonSchema(raw);
    if (!isJsonSchemaObject(clean)) {
      return t;
    }
    return {
      type: "function",
      function: {
        name: t.name,
        description: t.description || t.name,
        parameters: clean,
      },
    };
  });
}

function toolCallsOf(message: BaseMessage): Array<{
  name: string;
  args: Record<string, unknown>;
  id?: string;
}> {
  const raw = (message as { tool_calls?: Array<{ name: string; args?: unknown; id?: string }> })
    .tool_calls;
  if (!Array.isArray(raw) || raw.length === 0) {
    return [];
  }
  return raw.map((call) => ({
    name: call.name,
    args: (call.args && typeof call.args === "object" ? call.args : {}) as Record<string, unknown>,
    id: call.id,
  }));
}

/**
 * Run model ↔ tool rounds. `withStructuredOutput` occupies the function-calling
 * channel, so tools must run in a prior loop; the conversation (including tool
 * results) is what the structured-output call then sees.
 */
export async function runToolCallingLoop(options: {
  invoke: (messages: BaseMessage[]) => Promise<BaseMessage>;
  tools: StructuredToolInterface[];
  messages: BaseMessage[];
  maxRounds?: number;
  onToolEvent?: (event: ToolEvent) => void;
}): Promise<BaseMessage[]> {
  const { invoke, tools, onToolEvent } = options;
  const messages = [...options.messages];
  const maxRounds = options.maxRounds ?? 6;
  const toolsByName = new Map(tools.map((t) => [t.name, t]));

  for (let round = 0; round < maxRounds; round++) {
    const response = await invoke(messages);
    messages.push(response);
    const calls = toolCallsOf(response);
    if (calls.length === 0) {
      break;
    }

    for (const [index, call] of calls.entries()) {
      const impl = toolsByName.get(call.name);
      let result: string;
      try {
        if (!impl) {
          result = `Unknown tool: ${call.name}`;
        } else {
          const raw = await impl.invoke(call.args);
          result = typeof raw === "string" ? raw : JSON.stringify(raw);
        }
      } catch (err) {
        result = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
      }
      onToolEvent?.({ name: call.name, args: call.args, result });
      messages.push(
        new ToolMessage({
          content: result,
          tool_call_id: call.id ?? `${call.name}-${round}-${index}`,
          name: call.name,
        }),
      );
    }
  }

  return messages;
}

/**
 * Flatten a finished tool transcript into plain text.
 *
 * The structured-output model has no tools bound to it, so replaying the raw
 * transcript would hand it `tool_calls` and `ToolMessage`s that reference tools
 * it does not know — Gemini and Azure both reject that. The findings therefore
 * travel as ordinary prose appended to the prompt.
 */
export function summarizeToolTranscript(messages: BaseMessage[]): string {
  const findings: string[] = [];
  for (const message of messages) {
    if (!ToolMessage.isInstance(message)) continue;
    const text =
      typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    if (!text.trim()) continue;
    findings.push(`### ${message.name ?? "tool"}\n${text.trim()}`);
  }
  return findings.join("\n\n");
}

/**
 * Bind a Zod schema onto the chat model so the provider enforces the shape
 * (OpenAI/Azure json_schema, Gemini function-calling) instead of scraping JSON
 * out of free-form text.
 *
 * When `tools` are passed, the model may call them in a loop *before* the
 * structured-output call. A single `withStructuredOutput().invoke(prompt)`
 * cannot mix tools: the output schema takes the tool channel. What the tools
 * returned is carried across as text, not as a replayed transcript.
 */
export async function invokeStructured<T extends z.ZodTypeAny>(
  model: BaseChatModel,
  schema: T,
  prompt: string,
  name: string,
  options?: StructuredInvokeOptions,
): Promise<z.infer<T>> {
  const tools = options?.tools ?? [];
  const canBind = tools.length > 0 && typeof model.bindTools === "function";
  const structured = () => model.withStructuredOutput(schema, { name });
  const structuredInput = (body: string): BaseMessage[] => {
    const messages: BaseMessage[] = [];
    if (options?.system) messages.push(new SystemMessage(options.system));
    messages.push(new HumanMessage(body));
    return messages;
  };

  if (!canBind) {
    return schema.parse(await structured().invoke(structuredInput(prompt))) as z.infer<T>;
  }

  let bound: ReturnType<NonNullable<BaseChatModel["bindTools"]>>;
  try {
    try {
      bound = model.bindTools!(tools);
    } catch {
      bound = model.bindTools!(toBindableTools(tools));
    }
  } catch (err) {
    console.warn("bindTools failed, continuing without tool loop:", err);
    return schema.parse(await structured().invoke(structuredInput(prompt))) as z.infer<T>;
  }

  // The loop reaches the provider, so most of its failure modes are async: a
  // rejected bind, a model that will not emit tool calls, a transport error.
  // None of those are worth losing the answer over — the structured call still
  // stands on its own, just without the findings.
  let messages: BaseMessage[];
  try {
    messages = await runToolCallingLoop({
      invoke: (current) => bound.invoke(current) as Promise<BaseMessage>,
      tools,
      messages: structuredInput(prompt),
      maxRounds: options?.maxToolRounds,
      onToolEvent: options?.onToolEvent,
    });
  } catch (err) {
    console.warn("tool loop failed, continuing without tool findings:", err);
    return schema.parse(await structured().invoke(structuredInput(prompt))) as z.infer<T>;
  }

  const findings = summarizeToolTranscript(messages);
  const body = findings ? `${prompt}\n\n## Tool findings\n${findings}` : prompt;
  return schema.parse(await structured().invoke(structuredInput(body))) as z.infer<T>;
}
