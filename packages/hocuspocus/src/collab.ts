import { CollabError, cloneJson, replaceText, type CollabArray, type CollabMap, type CollabText } from "@collabnode/collab";
import { crdtProperties, type GraphSchema } from "@collabnode/schema";
import * as Y from "yjs";
import { NODE_COLLAB_KEY, nodesMap, rootMap } from "./ydoc.js";

export function collabFieldsOf(node: Y.Map<unknown>): Y.Map<unknown> {
  const existing = node.get(NODE_COLLAB_KEY);
  if (existing instanceof Y.Map) {
    return existing;
  }
  const created = new Y.Map<unknown>();
  node.set(NODE_COLLAB_KEY, created);
  return created;
}

export function ensureYCollab(doc: Y.Doc, schema: GraphSchema, nodeId: string, nodeType: string): Y.Map<unknown> {
  const node = nodesMap(rootMap(doc)).get(nodeId);
  if (!(node instanceof Y.Map)) {
    throw new CollabError(`unknown node '${nodeId}'`);
  }
  const fields = collabFieldsOf(node);
  const defs = crdtProperties(schema.nodes[nodeType]);
  for (const [name, kind] of Object.entries(defs)) {
    const current = fields.get(name);
    if (kind === "text" && !(current instanceof Y.Text)) {
      fields.set(name, new Y.Text());
    } else if (kind === "map" && !(current instanceof Y.Map)) {
      fields.set(name, new Y.Map());
    } else if (kind === "array" && !(current instanceof Y.Array)) {
      fields.set(name, new Y.Array());
    }
  }
  return fields;
}

function requireField<T>(
  doc: Y.Doc,
  schema: GraphSchema,
  nodeId: string,
  field: string,
  kind: "text" | "map" | "array",
  ctor: new (...args: never[]) => T,
  label: string,
): T {
  const nodeType = nodeTypeOf(doc, nodeId);
  const fields = ensureYCollab(doc, schema, nodeId, nodeType);
  const value = fields.get(field);
  if (!(value instanceof ctor)) {
    throw new CollabError(`node '${nodeId}' has no ${label} field '${field}'`);
  }
  if (crdtProperties(schema.nodes[nodeType])[field] !== kind) {
    throw new CollabError(`node '${nodeId}' has no ${label} field '${field}'`);
  }
  return value;
}

function nodeTypeOf(doc: Y.Doc, nodeId: string): string {
  const node = nodesMap(rootMap(doc)).get(nodeId);
  if (!(node instanceof Y.Map)) {
    throw new CollabError(`unknown node '${nodeId}'`);
  }
  const type = node.get("type");
  if (typeof type !== "string" || type === "") {
    throw new CollabError(`unknown node '${nodeId}'`);
  }
  return type;
}

export class YCollabText implements CollabText {
  readonly kind = "text" as const;

  constructor(private readonly text: Y.Text) {}

  toString(): string {
    return this.text.toString();
  }

  insert(index: number, value: string): void {
    this.text.insert(index, value);
  }

  delete(index: number, length: number): void {
    this.text.delete(index, length);
  }

  replace(value: string): void {
    this.text.doc?.transact(() => {
      replaceText(this, value);
    });
  }

  observe(listener: () => void): () => void {
    const handler = (): void => {
      listener();
    };
    this.text.observe(handler);
    return () => {
      this.text.unobserve(handler);
    };
  }
}

export class YCollabMap implements CollabMap {
  readonly kind = "map" as const;

  constructor(private readonly map: Y.Map<unknown>) {}

  get(key: string): unknown {
    return cloneJson(this.map.get(key) ?? null);
  }

  set(key: string, value: unknown): void {
    this.map.set(key, cloneJson(value));
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  toJSON(): Record<string, unknown> {
    return this.map.toJSON() as Record<string, unknown>;
  }

  replace(value: Record<string, unknown>): void {
    this.map.doc?.transact(() => {
      for (const key of [...this.map.keys()]) {
        this.map.delete(key);
      }
      for (const [key, item] of Object.entries(value)) {
        this.map.set(key, cloneJson(item));
      }
    });
  }

  observe(listener: () => void): () => void {
    const handler = (): void => {
      listener();
    };
    this.map.observe(handler);
    return () => {
      this.map.unobserve(handler);
    };
  }
}

export class YCollabArray implements CollabArray {
  readonly kind = "array" as const;

  constructor(private readonly array: Y.Array<unknown>) {}

  toJSON(): unknown[] {
    return this.array.toJSON() as unknown[];
  }

  replace(value: unknown[]): void {
    this.array.doc?.transact(() => {
      if (this.array.length > 0) {
        this.array.delete(0, this.array.length);
      }
      if (value.length > 0) {
        this.array.push(value.map((item) => cloneJson(item)));
      }
    });
  }

  push(value: unknown): void {
    this.array.push([cloneJson(value)]);
  }

  observe(listener: () => void): () => void {
    const handler = (): void => {
      listener();
    };
    this.array.observe(handler);
    return () => {
      this.array.unobserve(handler);
    };
  }
}

export function yCollabText(doc: Y.Doc, schema: GraphSchema, nodeId: string, field: string): CollabText {
  return new YCollabText(requireField(doc, schema, nodeId, field, "text", Y.Text, "text"));
}

export function yCollabMap(doc: Y.Doc, schema: GraphSchema, nodeId: string, field: string): CollabMap {
  return new YCollabMap(requireField(doc, schema, nodeId, field, "map", Y.Map, "map"));
}

export function yCollabArray(doc: Y.Doc, schema: GraphSchema, nodeId: string, field: string): CollabArray {
  return new YCollabArray(requireField(doc, schema, nodeId, field, "array", Y.Array, "array"));
}
