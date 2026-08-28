import type { BaseChatModel, BindToolsInput } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";

/**
 * Single-shot structured output, and the JSON Schema pipeline providers share.
 *
 * Deep Agents is the tool loop. This helper is the other call: given a role
 * prompt and a Zod schema, ask once and parse. `withStructuredOutput` occupies
 * the function-calling channel, so this path does not bind tools.
 *
 * Both this call and `bindAgentTools` send schemas through `toProviderJsonSchema`
 * — Zod or JSON Schema in, the subset Gemini and Azure actually accept out.
 */

export interface StructuredInvokeOptions {
  system?: string;
  /**
   * OpenAI/Azure `json_schema` strict mode. Defaults to true: the schema was
   * built for every key present (`planZod` `strict`, nullable for "no value").
   */
  strict?: boolean;
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

  if (obj.type === "object" && obj.additionalProperties === undefined) {
    obj.additionalProperties = false;
  }

  sanitizeChildren(obj, defs, seen);
  return obj;
}

const emptyObjectSchema = (): Record<string, unknown> => ({ type: "object", properties: {} });

/**
 * Zod or JSON Schema → the subset of JSON Schema the providers accept.
 *
 * Used for tool parameters *and* structured-output schemas. A `planZod`
 * discriminated union typically arrives with `$ref`/`$defs`; those have to be
 * inlined before Gemini or Azure will take the call. Root `oneOf`/`anyOf` is
 * kept — requiring `type: "object"` here used to collapse a plan schema to
 * `{ type: "object", properties: {} }`.
 */
export function toProviderJsonSchema(schema: unknown): Record<string, unknown> {
  let raw: unknown = schema;
  if (isZodSchema(raw)) {
    try {
      raw = z.toJSONSchema(raw, { target: "draft-7", io: "input", unrepresentable: "any" });
    } catch {
      return emptyObjectSchema();
    }
  } else if (!isPlainObject(raw)) {
    return emptyObjectSchema();
  }
  const clean = sanitizeJsonSchema(raw);
  return isPlainObject(clean) && !isZodSchema(clean) ? clean : emptyObjectSchema();
}

/** @deprecated Use `toProviderJsonSchema`. Same pipeline; kept for existing imports. */
export const toolParametersJsonSchema = toProviderJsonSchema;

/**
 * OpenAI / Gemini function defs with sanitized JSON schemas.
 *
 * Deep Agents / `bindTools` can take native LangChain tools; this is the
 * fallback when a provider rejects Zod internals or `$ref`s.
 */
export function toBindableTools(tools: StructuredToolInterface[]): BindToolsInput[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || t.name,
      parameters: toProviderJsonSchema(t.schema),
    },
  }));
}

/**
 * Ask once for a shape. No tools, no Deep Agents loop.
 *
 * The schema is converted and sanitized *before* `withStructuredOutput`, so the
 * provider sees JSON Schema it can enforce (OpenAI/Azure `json_schema` +
 * `strict`, Gemini function-calling) rather than Zod internals or `$ref`s.
 * `schema.parse` is the local check after the provider answers.
 */
export async function invokeStructured<T extends z.ZodTypeAny>(
  model: BaseChatModel,
  schema: T,
  prompt: string,
  name: string,
  options?: StructuredInvokeOptions,
): Promise<z.infer<T>> {
  const jsonSchema = toProviderJsonSchema(schema);
  const structured = model.withStructuredOutput(jsonSchema, {
    name,
    strict: options?.strict ?? true,
  });
  const messages: BaseMessage[] = [];
  if (options?.system) messages.push(new SystemMessage(options.system));
  messages.push(new HumanMessage(prompt));
  return schema.parse(await structured.invoke(messages));
}
