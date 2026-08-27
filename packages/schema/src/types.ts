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
  /** Per-node-type read/write reach for this role. */
  nodes?: AgentNodePolicy;
  /** Whether to enable internal task planning / todo list for this agent. */
  internalPlanning?: boolean;
}

export interface ToolsPolicyDef {
  /**
   * Allowlist of generated MCP tool names (`graph_*`, `upsert_node_*`,
   * `upsert_edge_*`, …). `*` exposes every generated tool — the same default
   * as omitting the list. Named tools in `named` are always added on top.
   */
  expose?: string[];
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
  projection?: ProjectionMode;
  retention?: RetentionDef;
}

export type NodeRef = string | { ref: string };

export interface UpsertNodeInput {
  type: string;
  properties: Record<string, unknown>;
  id?: string;
  tags?: string[];
}

export interface UpsertEdgeInput {
  type: string;
  from: string;
  to: string;
  properties?: Record<string, unknown>;
  id?: string;
}

export type GraphOpInput =
  | ({ op: "upsertNode"; ref?: string } & UpsertNodeInput)
  | { op: "deleteNode"; id: string }
  | {
      op: "upsertEdge";
      type: string;
      from: NodeRef;
      to: NodeRef;
      properties?: Record<string, unknown>;
      id?: string;
    }
  | { op: "deleteEdge"; id: string };
