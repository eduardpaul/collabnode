import type { AnyGraph, EdgeNameOf, GraphTypeMap, NodeNameOf } from "./infer.js";

export const PROPERTY_TYPE_NAMES = [
  "string",
  "number",
  "boolean",
  "datetime",
  "enum",
  "json",
  "text",
  "map",
  "array",
] as const;

export type PropertyTypeName = (typeof PROPERTY_TYPE_NAMES)[number];

export const CRDT_PROPERTY_TYPES = ["text", "map", "array"] as const;

export type CrdtPropertyType = (typeof CRDT_PROPERTY_TYPES)[number];

export function isCrdtPropertyType(type: PropertyTypeName): type is CrdtPropertyType {
  return (CRDT_PROPERTY_TYPES as readonly string[]).includes(type);
}

export const PROPERTY_WIDGETS = ["text", "textarea", "slider", "hidden"] as const;

export type PropertyWidget = (typeof PROPERTY_WIDGETS)[number];

export type I18nString = string | Record<string, string>;
export type I18nStringList = string[] | Record<string, string[]>;

export interface PropertyUi {
  widget?: PropertyWidget;
  label?: I18nString;
}

/**
 * How a property participates in `graph_search`'s full-text index. Written in
 * YAML as `search: true`, `search: false`, or `search: { boost: 4 }`; parsing
 * normalizes all three to this shape.
 */
export interface PropertySearch {
  index: boolean;
  boost: number;
}

/** Identity fields are what people name things by, so they outrank prose. */
export const DEFAULT_IDENTITY_BOOST = 4;
export const DEFAULT_SEARCH_BOOST = 1;

/**
 * Whether a property's text is embedded for semantic search. Written in YAML as
 * `vector: true` or `vector: false`; a sibling of `search` rather than part of
 * it, because the two are different indexes — `boost` is a lexical weight and
 * means nothing to an embedding.
 *
 * Unlike `search`, this has no implicit default: a schema that never mentions
 * `vector` gets no embeddings, and so needs no embedding model.
 */
export interface PropertyVector {
  index: boolean;
}

export interface PropertyDef {
  type: PropertyTypeName;
  required?: boolean;
  default?: unknown;
  values?: string[];
  description?: I18nString;
  min?: number;
  max?: number;
  integer?: boolean;
  maxLength?: number;
  derived?: string;
  ui?: PropertyUi;
  search?: PropertySearch;
  vector?: PropertyVector;
}

export interface UiMeta {
  label?: I18nString;
  icon?: string;
  color?: string;
}

export interface IdentityDef {
  from: string[];
}

export interface NodeTypeDef {
  description?: I18nString;
  identity?: IdentityDef;
  /**
   * At most one node of this type per workspace.
   *
   * For the state a workspace *has* rather than the things it *contains* — a
   * settings node, a status node, a board's configuration. Every write lands on
   * the same node, whether or not the writer knows its id, and the id is derived
   * from the type so two replicas creating it at once converge on one node
   * instead of two.
   *
   * Mutually exclusive with `identity`: identity is how a type has many
   * instances told apart, and a type with one instance has nothing to tell apart.
   */
  singleton?: boolean;
  properties: Record<string, PropertyDef>;
  ui?: UiMeta;
  guidelines?: I18nStringList;
}

export interface EdgeTypeDef {
  description?: I18nString;
  from: string[];
  to: string[];
  directed: boolean;
  properties: Record<string, PropertyDef>;
  ui?: UiMeta;
  guidelines?: I18nStringList;
}

export type IdStrategy = "uuid" | "ulid" | "literal";

export const DEFAULT_HISTORY_LIMIT = 10_000;

export interface ChangeTrackingConfig {
  enabled: boolean;
  /** Last-write stamps `meta`. History also appends a durable op log. */
  mode: "last-write" | "history";
  /** Max history entries retained. Default 10000; drop oldest by at then opId. */
  historyLimit?: number;
}

export interface TagsConfig {
  enabled: boolean;
}

export interface SchemaConfig {
  schemaId: string;
  idStrategy: IdStrategy;
  display?: { title?: I18nString };
  changeTracking: ChangeTrackingConfig;
  tags?: TagsConfig;
}

export interface GraphSchema {
  name: string;
  version: number;
  description?: I18nString;
  config: SchemaConfig;
  nodes: Record<string, NodeTypeDef>;
  edges: Record<string, EdgeTypeDef>;
  schemaHash: string;
}

export class SchemaError extends Error {
  readonly path: string;

  constructor(message: string, path = "") {
    super(path ? `${path}: ${message}` : message);
    this.name = "SchemaError";
    this.path = path;
  }
}

export const PARAM_TYPE_NAMES = [
  "string",
  "number",
  "boolean",
  "array",
  "object",
  "json",
] as const;

export type ParamTypeName = (typeof PARAM_TYPE_NAMES)[number];

export interface ParamDef {
  type: ParamTypeName;
  required?: boolean;
  default?: unknown;
  description?: I18nString;
  of?: ParamTypeName;
}

export interface TemplateNodeDef {
  type: string;
  as?: string;
  id?: string;
  properties?: Record<string, unknown>;
  tags?: string[] | string;
  forEach?: string;
  itemVar?: string;
  indexVar?: string;
  when?: string;
}

export type TemplateEdgeEndpoint = string | { ref: string } | { id: string };

export interface TemplateEdgeDef {
  type: string;
  from: TemplateEdgeEndpoint;
  to: TemplateEdgeEndpoint;
  properties?: Record<string, unknown>;
  id?: string;
  as?: string;
  forEach?: string;
  itemVar?: string;
  indexVar?: string;
  when?: string;
}

export interface TemplateDef {
  nodes?: TemplateNodeDef[];
  edges?: TemplateEdgeDef[];
}

export interface LifecycleDef {
  /** Idle duration before auto-termination (e.g. '30m', '1h', or ms). */
  idleTimeout?: string | number;
  /** Maximum wall-clock lifespan before mandatory termination (e.g. '4h', '1d', or ms). */
  maxDuration?: string | number;
  /** Predicate query or expression that terminates the workspace when true. */
  endWhen?: string;
}

/**
 * One named, parameterized slice of the graph: which nodes, which of their
 * fields, and which relationships between them.
 *
 * A view is a *read projection*, deliberately weaker than a query language so
 * that it runs on every projection mode (`memory` included) and can be redacted
 * per agent role. `select` answers which nodes, `fields` answers which of their
 * properties, `edges` answers which relationships. A view carrying nothing but
 * `select.roots.types` and `fields` is a perfectly good view.
 */
export interface ViewDef {
  /** Short human label — also the tab name a UI renders it under. */
  title?: I18nString;
  /** One line. Becomes the description of the generated `view_<name>` tool. */
  description?: I18nString;
  /** What the reader should do with what it sees, in the agent's language. */
  guidance?: I18nStringList;
  /** Typed parameters, validated with the same rules as workspace params. */
  params?: Record<string, ParamDef>;
  select?: ViewSelectDef;
  /**
   * Per-node-type field projection. A type not named here keeps every property;
   * `*` is the fallback for types not named. `id` and `type` are always
   * available as pseudo-fields.
   */
  fields?: Record<string, string[]>;
  /** Render the relationships between selected nodes. Defaults to true. */
  edges?: boolean;
  /** Cap on selected nodes. Defaults to 100. */
  maxNodes?: number;
  /** Default rendering. `markdown` suits prompts, `json` suits UIs. */
  format?: ViewFormat;
}

export type ViewFormat = "markdown" | "json";

export interface ViewSelectDef {
  roots?: ViewRootsDef;
  traverse?: ViewTraverseDef;
  /** Whole node types pulled in regardless of whether a root reaches them. */
  include?: string[];
}

export interface ViewRootsDef {
  /** Node types the selection starts from. Omit for every visible type. */
  types?: string[];
  /**
   * Expression filtering the roots. Evaluated against
   * `{ ...node.properties, id, type, params }` — bare identifiers are node
   * properties, view parameters live under `params.`. Because `==` is loose,
   * `params.x == null` is the idiomatic "parameter not supplied" test.
   */
  where?: string;
}

export interface ViewTraverseDef {
  /** Edge types to follow. Omit to follow every edge type. */
  edges?: string[];
  /** Defaults to `out`. */
  direction?: ViewDirection;
  /** Hops from each root. Defaults to 1. */
  depth?: number;
  /** Expression filtering the nodes reached, same context as `roots.where`. */
  where?: string;
}

export type ViewDirection = "in" | "out" | "both";

export interface NamedToolDef {
  description?: I18nString;
  creates?: string;
  into?: string;
  properties?: Record<string, PropertyDef>;
  parameters?: Record<string, unknown>;
}

/**
 * What one agent role may do with each node type. Two separate powers, because
 * "may not write it" and "may not know it exists" are different requirements:
 * a reviewer that must read decisions without editing them is `readOnly`, while
 * a note the facilitator keeps off an outside agent's map is `hidden`.
 *
 * Both lists name node types, and `*` stands for every node type in the schema,
 * so a fully passive observer is `readOnly: ["*"]`. Hidden wins wherever the two
 * overlap — there is nothing left to read.
 */
export interface AgentNodePolicy {
  /** Readable, never writable: no upsert tool, no delete, no template of one. */
  readOnly?: string[];
  /**
   * Absent from the agent's world: struck from its schema view, prompts,
   * resources and tool surface, and filtered out of every read result. Ids of
   * hidden nodes resolve as `unknown id`, the same answer an id that never
   * existed gets, so absence and denial are indistinguishable.
   */
  hidden?: string[];
}

export interface AgentDef {
  role: string;
  actorId: string;
  description?: I18nString;
  systemPrompt?: I18nString;
  /**
   * Allowlist of tool names this role may call. `*` keeps every tool that
   * survived `tools.expose`; omit or leave empty for the same default.
   */
  tools?: string[];
  /**
   * Allowlist of view names this role is granted. `*`, or omitting the list,
   * grants every declared view. Views are filtered by this list first, then by
   * `tools` like any other tool.
   */
  views?: string[];
  /** Per-node-type read/write reach for this role. */
  nodes?: AgentNodePolicy;
  /** Whether to enable internal task planning / todo list for this agent. */
  internalPlanning?: boolean;
}

/**
 * Generated tools that are off unless a workspace names them in
 * `tools.advanced`.
 *
 * Each one asks the model to hold the whole graph in its head: `graph_snapshot`
 * returns it, `graph_diff_since` takes a previous copy of it back as an
 * argument, `graph_query` needs Cypher to address it, and `graph_apply_batch`
 * writes a pile of it at once — which also delays every one of those writes
 * reaching the other participants until the batch lands. Declared `views:` and
 * the targeted reads (`graph_list`, `graph_get`, `graph_neighbors`) answer the
 * same questions in far fewer tokens, so the default surface leaves these out.
 */
export const ADVANCED_TOOLS = [
  "graph_snapshot",
  "graph_query",
  "graph_diff_since",
  "graph_apply_batch",
] as const;

export type AdvancedTool = (typeof ADVANCED_TOOLS)[number];

export interface ToolsPolicyDef {
  /**
   * Allowlist of generated MCP tool names (`graph_*`, `upsert_node_*`,
   * `upsert_edge_*`, …). `*` exposes every generated tool — the same default
   * as omitting the list. Named tools in `named` are always added on top.
   */
  expose?: string[];
  /**
   * Opt back in to tools from `ADVANCED_TOOLS`, which are not generated
   * otherwise. Unlike `expose`, this is additive: it never removes anything.
   */
  advanced?: AdvancedTool[];
  named?: Record<string, NamedToolDef>;
  agents?: AgentDef[];
}

export type ProjectionMode = "none" | "memory" | "shared";

export type RetentionOnEnd = "delete" | "keep" | "archive";
export type ArtifactRequirement = "required" | "optional" | "none";

export interface RetentionDef {
  onEnd?: RetentionOnEnd;
  artifact?: ArtifactRequirement;
}

export interface WorkspaceType {
  name: string;
  version: number;
  description?: I18nString;
  schema: GraphSchema;
  params?: Record<string, ParamDef>;
  template?: TemplateDef;
  lifecycle?: LifecycleDef;
  tools?: ToolsPolicyDef;
  /** Named graph slices, shared by the agent tool surface and the UI. */
  views?: Record<string, ViewDef>;
  projection?: ProjectionMode;
  retention?: RetentionDef;
}

export type NodeRef = string | { ref: string };

interface UpsertNodeOf<S extends GraphTypeMap, T extends NodeNameOf<S>> {
  type: T;
  properties: S["nodes"][T]["input"];
  id?: string;
  tags?: string[];
}

/**
 * One node write.
 *
 * Over a known schema this distributes into a union discriminated on `type`, so
 * `properties` is checked against the node type actually named — and an editor
 * offers only that type's properties once `type` is filled in.
 */
export type UpsertNodeInput<
  S extends GraphTypeMap = AnyGraph,
  T extends NodeNameOf<S> = NodeNameOf<S>,
> = T extends unknown ? UpsertNodeOf<S, T> : never;

interface UpsertEdgeOf<S extends GraphTypeMap, T extends EdgeNameOf<S>> {
  type: T;
  from: string;
  to: string;
  properties?: S["edges"][T]["input"];
  id?: string;
}

export type UpsertEdgeInput<
  S extends GraphTypeMap = AnyGraph,
  T extends EdgeNameOf<S> = EdgeNameOf<S>,
> = T extends unknown ? UpsertEdgeOf<S, T> : never;

interface BatchEdgeOf<S extends GraphTypeMap, T extends EdgeNameOf<S>> {
  op: "upsertEdge";
  type: T;
  from: NodeRef;
  to: NodeRef;
  properties?: S["edges"][T]["input"];
  id?: string;
}

export type GraphOpInput<S extends GraphTypeMap = AnyGraph> =
  | ({ op: "upsertNode"; ref?: string } & UpsertNodeInput<S>)
  | { op: "deleteNode"; id: string }
  | { [T in EdgeNameOf<S>]: BatchEdgeOf<S, T> }[EdgeNameOf<S>]
  | { op: "deleteEdge"; id: string };
