import type { PropertyTypeName } from "./types.js";

/**
 * Readonly mirrors of the schema interfaces, for a workspace written as a TS
 * literal rather than parsed from YAML.
 *
 * `as const` makes every array and property readonly, so a generated literal
 * cannot `satisfies WorkspaceType` — the mutable `values: string[]` in
 * `PropertyDef` alone rules it out. These are the same shapes with the mutation
 * removed, and they exist for one reason: `satisfies` has to accept the literal
 * *without widening it*, because the literal's own narrow type is the whole
 * point. Every field the derived types never read is left optional and loose,
 * so a trimmed emit (the default) checks as readily as a full one.
 */

export interface PropertyDefLiteral {
  readonly type: PropertyTypeName;
  readonly required?: boolean;
  readonly default?: unknown;
  readonly values?: readonly string[];
  readonly derived?: string;
  readonly description?: unknown;
  readonly min?: number;
  readonly max?: number;
  readonly integer?: boolean;
  readonly maxLength?: number;
  readonly ui?: unknown;
  readonly search?: unknown;
  readonly vector?: unknown;
}

export interface NodeTypeDefLiteral {
  readonly properties: { readonly [name: string]: PropertyDefLiteral };
  readonly description?: unknown;
  readonly identity?: unknown;
  readonly singleton?: boolean;
  readonly ui?: unknown;
  readonly guidelines?: unknown;
}

export interface EdgeTypeDefLiteral {
  readonly from: readonly string[];
  readonly to: readonly string[];
  readonly properties: { readonly [name: string]: PropertyDefLiteral };
  readonly directed?: boolean;
  readonly description?: unknown;
  readonly ui?: unknown;
  readonly guidelines?: unknown;
}

export interface GraphSchemaLiteral {
  readonly nodes: { readonly [name: string]: NodeTypeDefLiteral };
  readonly edges: { readonly [name: string]: EdgeTypeDefLiteral };
  readonly name?: string;
  readonly version?: number;
  readonly description?: unknown;
  readonly config?: unknown;
  readonly schemaHash?: string;
}

export interface WorkspaceTypeLiteral {
  readonly schema: GraphSchemaLiteral;
  readonly name?: string;
  readonly version?: number;
  readonly description?: unknown;
  readonly params?: unknown;
  readonly template?: unknown;
  readonly lifecycle?: unknown;
  readonly tools?: unknown;
  readonly views?: unknown;
  readonly projection?: unknown;
  readonly retention?: unknown;
}
