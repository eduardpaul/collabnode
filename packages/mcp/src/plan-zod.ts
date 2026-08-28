import {
  resolveGuidelines,
  resolveI18nString,
  type AnyGraph,
  type EdgeNameOf,
  type GraphSchema,
  type GraphTypeMap,
  type NodeNameOf,
  type PropertyDef,
} from "@collabnode/schema";
import { z, type ZodType } from "zod/v4";
import { getLocale, type SupportedLanguage } from "./i18n.js";
import { propertyZod } from "./property-zod.js";

/**
 * How a property that is not `required` is expressed.
 *
 * `optional` is the MCP tool shape: the key may be left out entirely.
 * `strict` is what OpenAI/Azure `json_schema` strict mode demands — every key
 * present in `required`, so "no value" has to travel as `null` instead of as an
 * absent key. A model answering a structured-output call needs `strict`.
 */
export type ZodPropertyMode = "optional" | "strict";

export interface NodeZodOptions {
  language?: SupportedLanguage | string;
  mode?: ZodPropertyMode;
  /** Properties to leave out — anything the caller writes itself, e.g. `dirty`. */
  omit?: string[];
}

function shapeFor(
  properties: Record<string, PropertyDef>,
  options: NodeZodOptions,
): Record<string, ZodType> {
  const { language, mode = "optional", omit = [] } = options;
  const skip = new Set(omit);
  const shape: Record<string, ZodType> = {};
  for (const [name, def] of Object.entries(properties)) {
    if (def.derived !== undefined || skip.has(name)) {
      continue;
    }
    if (mode !== "strict") {
      shape[name] = propertyZod(def, language);
      continue;
    }
    // Asking for the property as required and adding `.nullable()` keeps the
    // key in `required` — which is what strict `json_schema` demands — while
    // still letting the model decline to fill it in.
    const required = propertyZod(strictDef(def, language), language);
    shape[name] = def.required && def.default === undefined ? required : required.nullable();
  }
  return shape;
}

/**
 * The same property, in the subset of JSON Schema that strict structured output
 * accepts.
 *
 * `minimum`, `maximum` and `maxLength` are not in that subset: a schema
 * carrying them is rejected outright by the provider, so a bound declared in
 * the YAML would take the whole call down. They move into the description
 * instead, where the model still reads them — and a value that lands outside
 * them costs that one property at write time rather than the entire plan at
 * parse time.
 */
function strictDef(def: PropertyDef, language?: SupportedLanguage | string): PropertyDef {
  const t = getLocale(language);
  const { min, max, maxLength, ...rest } = def;
  const bounds: string[] = [];
  if (min !== undefined || max !== undefined) {
    bounds.push(t.tools.plan.numberRange(min, max));
  }
  if (maxLength !== undefined) {
    bounds.push(t.tools.plan.maxLength(maxLength));
  }
  if (bounds.length === 0) {
    return { ...rest, required: true, default: undefined };
  }
  const described = resolveI18nString(def.description, language);
  return {
    ...rest,
    required: true,
    default: undefined,
    description: [described, ...bounds].filter(Boolean).join(" "),
  };
}

/**
 * The zod schema for one node type, straight from the workspace YAML — the
 * property types, their enum values and bounds, and the descriptions and
 * guidelines already written there.
 *
 * This is the schema a model should be asked to fill in. Hand-writing a second
 * copy of it next to the YAML is how the two drift: a property gains an enum
 * value, or a guideline is tightened, and the structured-output schema keeps
 * asking for last month's shape.
 */
export function nodeZod(
  schema: GraphSchema,
  type: string,
  options: NodeZodOptions = {},
): z.ZodObject<Record<string, ZodType>> {
  const def = schema.nodes[type];
  if (!def) {
    throw new Error(`Unknown node type '${type}' in schema '${schema.name}'`);
  }
  const t = getLocale(options.language);
  const parts = [resolveI18nString(def.description, options.language), ...resolveGuidelines(def.guidelines, options.language)]
    .filter((part): part is string => Boolean(part?.trim()))
    .map((part) => part.trim());
  parts.push(t.tools.plan.relationshipsAreEdges);
  return z.object(shapeFor(def.properties, options)).describe(parts.join(" "));
}

export interface PlanZodOptions<
  S extends GraphTypeMap = AnyGraph,
  N extends NodeNameOf<S> = NodeNameOf<S>,
  E extends EdgeNameOf<S> = EdgeNameOf<S>,
> extends Omit<NodeZodOptions, "omit"> {
  /** Node types the plan may write. Defaults to every type in the schema. */
  nodeTypes?: readonly N[];
  /** Edge types the plan may write. Defaults to every type in the schema. */
  edgeTypes?: readonly E[];
  /** Properties to leave out, per node type. */
  omit?: { [T in N]?: readonly (keyof S["nodes"][T]["input"] & string)[] };
}

/**
 * A whole plan — nodes and the relationships between them — as one schema
 * derived from the workspace YAML.
 *
 * Every node carries a `ref` the plan itself chooses, and every edge names its
 * endpoints by that `ref` or by the id of a node already in the graph. There is
 * deliberately nowhere to put a parent's *title*: a title is not a handle, it
 * changes when a human renames the node, and matching on it silently links the
 * wrong node when two share a name. `session.batch()` takes the result as-is —
 * a `{ ref }` endpoint is exactly what it resolves within one batch.
 */
export function planZod<
  S extends GraphTypeMap = AnyGraph,
  const N extends NodeNameOf<S> = NodeNameOf<S>,
  const E extends EdgeNameOf<S> = EdgeNameOf<S>,
>(schema: GraphSchema, options: PlanZodOptions<S, N, E> = {}): z.ZodType<GraphPlan<S, N, E>> {
  const { language, mode = "optional", nodeTypes, edgeTypes, omit = {} } = options;
  const t = getLocale(language);

  const scopedNodes: readonly string[] = nodeTypes ?? Object.keys(schema.nodes);
  const scopedEdges: readonly string[] = edgeTypes ?? Object.keys(schema.edges);
  const omitted = omit as Record<string, readonly string[] | undefined>;
  const nodeNames = scopedNodes.filter((name) => schema.nodes[name]);
  const edgeNames = scopedEdges.filter((name) => schema.edges[name]);
  if (nodeNames.length === 0) {
    throw new Error(`No writable node types for a plan over schema '${schema.name}'`);
  }

  const endpoint = z.string().describe(t.tools.plan.endpoint);

  // An entry updates an existing node when it carries that node's `id`, and
  // creates one when it does not. Either way `ref` is how the plan's own edges
  // reach it, so an edge never has to know which of the two it was.
  const nodeId = z.string().describe(t.tools.plan.nodeId);
  const nodeVariants = nodeNames.map((name) =>
    z.object({
      type: z.literal(name),
      ref: z.string().describe(t.tools.plan.nodeRef),
      id: mode === "strict" ? nodeId.nullable() : nodeId.optional(),
      properties: nodeZod(schema, name, { language, mode, omit: omitted[name]?.slice() }),
    }),
  );

  const edgeVariants = edgeNames.map((name) => {
    const def = schema.edges[name]!;
    const desc = [
      resolveI18nString(def.description, language),
      ...resolveGuidelines(def.guidelines, language),
    ]
      .filter((part): part is string => Boolean(part?.trim()))
      .join(" ");
    const shape: Record<string, ZodType> = {
      type: z.literal(name),
      from: endpoint.describe(`${t.tools.edgeUpsert.from(def.from.join(" | "))} ${t.tools.plan.endpoint}`),
      to: endpoint.describe(`${t.tools.edgeUpsert.to(def.to.join(" | "))} ${t.tools.plan.endpoint}`),
    };
    // An edge type with no properties of its own gets no `properties` key at
    // all: an always-empty object is one more thing for a model to fill in.
    const properties = shapeFor(def.properties, { language, mode });
    if (Object.keys(properties).length > 0) {
      shape.properties = z.object(properties);
    }
    const variant = z.object(shape);
    return desc ? variant.describe(desc) : variant;
  });

  const oneOf = <T extends ZodType>(variants: T[]): ZodType =>
    variants.length === 1 ? variants[0]! : z.discriminatedUnion("type", variants as never);

  return z.object({
    nodes: z.array(oneOf(nodeVariants)).describe(t.tools.plan.nodes),
    edges:
      edgeVariants.length > 0
        ? z.array(oneOf(edgeVariants)).describe(t.tools.plan.edges)
        : z.array(z.never()).describe(t.tools.plan.edges),
    // The zod object is built from a runtime GraphSchema, which has no literal
    // types left to read, so the return type is asserted rather than inferred.
    // `plan-zod.test.ts` is what checks the two agree: it parses a value typed
    // by `GraphPlan` through the schema built here.
  }) as unknown as z.ZodType<GraphPlan<S, N, E>>;
}

/**
 * What one node entry in a plan looks like.
 *
 * `properties` is the write shape whichever mode built the schema. Under
 * `strict` a model sends every key with `null` for "no value", and that is
 * assignable to this — every key optional, the nullable ones accepting null —
 * so one type covers both a model's answer and a hand-built fallback plan.
 */
export type PlanNode<
  S extends GraphTypeMap = AnyGraph,
  N extends NodeNameOf<S> = NodeNameOf<S>,
> = N extends unknown
  ? { type: N; ref: string; id?: string | null; properties: S["nodes"][N]["input"] }
  : never;

export type PlanEdge<
  S extends GraphTypeMap = AnyGraph,
  E extends EdgeNameOf<S> = EdgeNameOf<S>,
> = E extends unknown
  ? { type: E; from: string; to: string; properties?: S["edges"][E]["input"] }
  : never;

export type GraphPlan<
  S extends GraphTypeMap = AnyGraph,
  N extends NodeNameOf<S> = NodeNameOf<S>,
  E extends EdgeNameOf<S> = EdgeNameOf<S>,
> = {
  nodes: PlanNode<S, N>[];
  edges: PlanEdge<S, E>[];
};

/** A record of Zod schemas, as `z.object()` takes. */
type Shape = Record<string, ZodType>;

type ShapeOutput<T extends Shape | undefined> = T extends Shape
  ? { [K in keyof T]: z.output<T[K]> }
  : Record<never, never>;

/**
 * Wrap a plan in the rest of the answer an agent gives.
 *
 * A plan is rarely the whole reply: a turn also carries a sentence on what
 * changed, a verdict on whether the work is done, ids of edges to remove. Those
 * are the app's, not the schema's, so they are supplied here rather than
 * derived from the YAML.
 *
 * `before` and `after` exist because **key order is prompt order** — a model
 * fills a structured answer in the order the schema declares. A field the model
 * should reason through *first* goes in `before`; a judgement on the plan it
 * has just written goes in `after`. Putting an "are you done?" boolean ahead of
 * the plan asks for the verdict before the work.
 */
export function planEnvelope<
  P,
  B extends Shape | undefined = undefined,
  A extends Shape | undefined = undefined,
>(
  plan: ZodType<P>,
  parts: { before?: B; after?: A },
): ZodType<P & ShapeOutput<B> & ShapeOutput<A>> {
  // `planZod` returns its object asserted as a `ZodType<GraphPlan<…>>`, so the
  // shape has to be recovered to spread it. It is the same object either way —
  // `plan-zod.test.ts` parses an envelope built here to check that.
  const shape = (plan as unknown as z.ZodObject<Shape>).shape;
  return z.object({
    ...(parts.before ?? {}),
    ...shape,
    ...(parts.after ?? {}),
  }) as unknown as ZodType<P & ShapeOutput<B> & ShapeOutput<A>>;
}
