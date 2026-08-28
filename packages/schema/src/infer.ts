import type { CrdtPropertyType } from "./types.js";
import type {
  EdgeTypeDefLiteral,
  GraphSchemaLiteral,
  NodeTypeDefLiteral,
  PropertyDefLiteral,
  WorkspaceTypeLiteral,
} from "./literal.js";

/**
 * The workspace schema, as types.
 *
 * Everything here mirrors what the runtime actually does in
 * `coerceProperty`/`coerceProperties` (`@collabnode/runtime`'s `validate.ts`)
 * and `hydrateNode` (`@collabnode/collab`). That is deliberate: a type that
 * merely looks plausible is worse than no type, because it fails at the point
 * where someone trusted it. Where the two could drift, a test pins them —
 * `nodeZod` is generated from the same `PropertyDef`, so a value typed here is
 * parsed there.
 *
 * These take the workspace *literal* (`typeof myWorkspace`, from a generated
 * module) rather than a `GraphSchema` value: a runtime `GraphSchema` has no
 * literal types left to read.
 */

/** Flattens an intersection so hovers show fields instead of `A & B & C`. */
type Simplify<T> = { [K in keyof T]: T[K] } & {};

/** Accepts either a whole workspace literal or a bare graph schema literal. */
export type SchemaOf<W> = W extends { readonly schema: GraphSchemaLiteral }
  ? W["schema"]
  : W extends GraphSchemaLiteral
    ? W
    : never;

type NodeDefs<W> = SchemaOf<W>["nodes"];
type EdgeDefs<W> = SchemaOf<W>["edges"];

type PropsOfDef<D> = D extends { readonly properties: infer P } ? P : never;

export type NodeTypeNames<W> = keyof NodeDefs<W> & string;
export type EdgeTypeNames<W> = keyof EdgeDefs<W> & string;

/**
 * What one property is worth reading back.
 *
 * `json` is `string` because the runtime stringifies whatever it is given
 * (`coerceProperty`, `case "json"`), which is easy to get wrong in the other
 * direction — see `WriteValue`.
 */
type ReadValue<D extends PropertyDefLiteral> = D["type"] extends "enum"
  ? D["values"] extends readonly (infer V extends string)[]
    ? V
    : string
  : D["type"] extends "number"
    ? number
    : D["type"] extends "boolean"
      ? boolean
      : D["type"] extends "map"
        ? Record<string, unknown>
        : D["type"] extends "array"
          ? unknown[]
          : string;

/** The same, for writes: `json` accepts any value and is serialized on the way in. */
type WriteValue<D extends PropertyDefLiteral> = D["type"] extends "json"
  ? unknown
  : ReadValue<D>;

type IsDerived<D> = D extends { readonly derived: string } ? true : false;
type IsCrdt<D extends PropertyDefLiteral> = D["type"] extends CrdtPropertyType ? true : false;
type HasDefault<D> = D extends { readonly default: unknown } ? true : false;
type IsRequired<D> = D extends { readonly required: true } ? true : false;

/**
 * Present on every read: declared `required`, carrying a `default` (filled in
 * on create), or a CRDT field — `hydrateNode` materializes those as `""`, `{}`
 * or `[]` on every snapshot, so they are never missing.
 */
type ReadRequiredKeys<P> = {
  [K in keyof P]-?: IsDerived<P[K]> extends true
    ? never
    : P[K] extends PropertyDefLiteral
      ? IsCrdt<P[K]> extends true
        ? K
        : IsRequired<P[K]> extends true
          ? K
          : HasDefault<P[K]> extends true
            ? K
            : never
      : never;
}[keyof P];

type DerivedKeys<P> = {
  [K in keyof P]-?: IsDerived<P[K]> extends true ? K : never;
}[keyof P];

type ReadOptionalKeys<P> = Exclude<keyof P, ReadRequiredKeys<P> | DerivedKeys<P>>;

/**
 * Required on a write only when there is no default to fall back on. A derived
 * property is never writable — `coerceProperties` skips it — so it is absent
 * from the write type entirely rather than merely optional.
 */
type WriteRequiredKeys<P> = {
  [K in keyof P]-?: IsDerived<P[K]> extends true
    ? never
    : IsRequired<P[K]> extends true
      ? HasDefault<P[K]> extends true
        ? never
        : K
      : never;
}[keyof P];

type WriteOptionalKeys<P> = Exclude<keyof P, WriteRequiredKeys<P> | DerivedKeys<P>>;

/** A node type's properties as they come back from a snapshot. */
export type NodeProps<W, T extends NodeTypeNames<W>> = NodePropsOf<
  PropsOfDef<NodeDefs<W>[T]>
>;

type NodePropsOf<P> = Simplify<
  {
    [K in ReadRequiredKeys<P>]: P[K] extends PropertyDefLiteral ? ReadValue<P[K]> : never;
  } & {
    [K in ReadOptionalKeys<P>]?: P[K] extends PropertyDefLiteral ? ReadValue<P[K]> : never;
  } & {
    readonly [K in DerivedKeys<P>]?: P[K] extends PropertyDefLiteral ? ReadValue<P[K]> : never;
  }
>;

/**
 * A node type's properties as `upsertNode` accepts them.
 *
 * Every property is optional, because an upsert is a *merge* whenever the node
 * already exists: `mergeProperties` checks required properties against the
 * merged result, not against the write, so resending `title` to change a
 * `priority` is exactly what the runtime does not ask for. Whether a given
 * upsert creates or updates is not knowable at compile time — a singleton write
 * carries no id and still merges — so requiring them here would reject correct
 * code far more often than it caught a mistake. `NodeCreate` is the stricter
 * shape, for callers that know they are creating.
 *
 * A property that is not required also accepts `null`, which is how a stored
 * value is cleared; writing `null` to a required one throws, so it does not.
 */
export type NodeInput<W, T extends NodeTypeNames<W>> = NodeInputOf<
  PropsOfDef<NodeDefs<W>[T]>
>;

type NodeInputOf<P> = Simplify<
  {
    [K in WriteRequiredKeys<P>]?: P[K] extends PropertyDefLiteral ? WriteValue<P[K]> : never;
  } & {
    [K in WriteOptionalKeys<P>]?: P[K] extends PropertyDefLiteral
      ? WriteValue<P[K]> | null
      : never;
  }
>;

/**
 * The same, for a write that is definitely a create: required properties with
 * no default must be there, because there is no stored node to merge into.
 */
export type NodeCreate<W, T extends NodeTypeNames<W>> = NodeCreateOf<
  PropsOfDef<NodeDefs<W>[T]>
>;

type NodeCreateOf<P> = Simplify<
  {
    [K in WriteRequiredKeys<P>]: P[K] extends PropertyDefLiteral ? WriteValue<P[K]> : never;
  } & {
    [K in WriteOptionalKeys<P>]?: P[K] extends PropertyDefLiteral
      ? WriteValue<P[K]> | null
      : never;
  }
>;

/**
 * What a model answers under `planZod`'s strict mode: every key present, with
 * `null` standing in for "no value", because OpenAI/Azure `json_schema` strict
 * mode requires every key in `required`. `omitNull` is what turns one of these
 * back into a `NodeInput`.
 */
export type StrictInput<W, T extends NodeTypeNames<W>> = StrictInputOf<
  PropsOfDef<NodeDefs<W>[T]>
>;

type StrictInputOf<P> = Simplify<
  {
    [K in WriteRequiredKeys<P>]: P[K] extends PropertyDefLiteral ? WriteValue<P[K]> : never;
  } & {
    [K in WriteOptionalKeys<P>]: P[K] extends PropertyDefLiteral
      ? WriteValue<P[K]> | null
      : never;
  }
>;

/** The node types an edge type is allowed to run between. */
export type EdgeEndpoints<W, T extends EdgeTypeNames<W>> = {
  from: EdgeDefs<W>[T] extends { readonly from: readonly (infer F extends string)[] }
    ? F
    : string;
  to: EdgeDefs<W>[T] extends { readonly to: readonly (infer O extends string)[] } ? O : string;
};

export type EdgeProps<W, T extends EdgeTypeNames<W>> = NodePropsOf<
  PropsOfDef<EdgeDefs<W>[T]>
>;

export type EdgeInput<W, T extends EdgeTypeNames<W>> = NodeInputOf<
  PropsOfDef<EdgeDefs<W>[T]>
>;

/**
 * One node type's read and write shapes, carried together.
 *
 * Downstream packages are generic over the *type map*, never over the workspace
 * literal, so `@collabnode/graph` and `@collabnode/runtime` need no knowledge of
 * how a `PropertyDef` becomes a type.
 */
export interface NodeTypeShape {
  props: Record<string, unknown>;
  input: Record<string, unknown>;
  /** What a model answers under structured output's strict mode. */
  strict: Record<string, unknown>;
}

export interface EdgeTypeShape {
  from: string;
  to: string;
  props: Record<string, unknown>;
  input: Record<string, unknown>;
}

export interface GraphTypeMap {
  nodes: Record<string, NodeTypeShape>;
  edges: Record<string, EdgeTypeShape>;
}

/** What a property can hold once the runtime has coerced it. */
export type PropertyValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: unknown }
  | unknown[];

export type PropertyMap = Record<string, PropertyValue>;

/**
 * A graph whose types are not known statically — the default for every generic
 * in the runtime.
 *
 * Instantiating any of them with this reproduces the shapes they had before
 * they were generic, which is what lets the implementation stay untouched while
 * a caller that knows its schema gets the narrow version. Note the asymmetry:
 * a read comes back coerced, so it is a `PropertyMap`, while a write is
 * whatever the caller has to hand and is coerced on the way in. That is what
 * the untyped signatures always said, and reproducing it exactly is the point.
 */
export interface AnyGraph {
  nodes: Record<
    string,
    { props: PropertyMap; input: Record<string, unknown>; strict: Record<string, unknown> }
  >;
  edges: Record<
    string,
    { from: string; to: string; props: PropertyMap; input: Record<string, unknown> }
  >;
}

/** Everything one workspace contributes to the type system, in one map. */
export type GraphTypes<W> = {
  nodes: {
    [T in NodeTypeNames<W>]: {
      props: NodeProps<W, T>;
      input: NodeInput<W, T>;
      strict: StrictInput<W, T>;
    };
  };
  edges: {
    [T in EdgeTypeNames<W>]: {
      from: EdgeEndpoints<W, T>["from"];
      to: EdgeEndpoints<W, T>["to"];
      props: EdgeProps<W, T>;
      input: EdgeInput<W, T>;
    };
  };
};

export type NodeNameOf<S extends GraphTypeMap> = keyof S["nodes"] & string;
export type EdgeNameOf<S extends GraphTypeMap> = keyof S["edges"] & string;
export type PropsOf<S extends GraphTypeMap, T extends NodeNameOf<S>> = S["nodes"][T]["props"];
export type InputOf<S extends GraphTypeMap, T extends NodeNameOf<S>> = S["nodes"][T]["input"];
export type StrictOf<S extends GraphTypeMap, T extends NodeNameOf<S>> = S["nodes"][T]["strict"];
export type EdgePropsOf<S extends GraphTypeMap, T extends EdgeNameOf<S>> = S["edges"][T]["props"];
export type EdgeInputOf<S extends GraphTypeMap, T extends EdgeNameOf<S>> = S["edges"][T]["input"];

/** Compile-time equality, for the assertions the generator emits. */
export type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

export type Expect<T extends true> = T;

export type { PropertyDefLiteral, NodeTypeDefLiteral, EdgeTypeDefLiteral, GraphSchemaLiteral, WorkspaceTypeLiteral };
