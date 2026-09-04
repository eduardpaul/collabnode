import {
  CollabError,
  cloneJson,
  replaceText,
  type CollabArray,
  type CollabMap,
  type CollabText,
} from "@collabnode/collab";
import { crdtProperties, type GraphSchema } from "@collabnode/schema";
import type { LoroDoc, LoroMap, LoroMovableList, LoroText } from "loro-crdt";
import {
  asValue,
  entityAt,
  isListLike,
  isLoroMap,
  isLoroText,
  nodesMap,
  rootMap,
  stringField,
  type Entity,
} from "./doc.js";

/**
 * Create this node's live fields, in mergeable form.
 *
 * `ensureMergeable*` rather than `setContainer` for the same reason the entity
 * maps use it: two peers can call `ensureCollab` for the same node at the same
 * time, and plain container creation would hand each of them a container the
 * other never sees.
 */
export function ensureLoroCollab(
  doc: LoroDoc,
  schema: GraphSchema,
  nodeId: string,
  nodeType: string,
): LoroMap<Record<string, unknown>> {
  const entity = entityAt(nodesMap(rootMap(doc)), nodeId);
  if (!entity) {
    throw new CollabError(`unknown node '${nodeId}'`);
  }
  const fields = entity.ensureMergeableMap("_collab");
  for (const [name, kind] of Object.entries(crdtProperties(schema.nodes[nodeType]))) {
    if (kind === "text") {
      fields.ensureMergeableText(name);
    } else if (kind === "map") {
      fields.ensureMergeableMap(name);
    } else {
      // A movable list, not a plain one: an ordered field whose items get
      // reordered is exactly what `MovableList` exists for, and concurrent
      // reorders on a plain list duplicate the moved item.
      fields.ensureMergeableMovableList(name);
    }
  }
  return fields;
}

function nodeTypeOf(doc: LoroDoc, nodeId: string): string {
  const entity: Entity | undefined = entityAt(nodesMap(rootMap(doc)), nodeId);
  const type = entity ? stringField(entity, "type") : "";
  if (type === "") {
    throw new CollabError(`unknown node '${nodeId}'`);
  }
  return type;
}

function requireField(
  doc: LoroDoc,
  schema: GraphSchema,
  nodeId: string,
  field: string,
  kind: "text" | "map" | "array",
): unknown {
  const nodeType = nodeTypeOf(doc, nodeId);
  if (crdtProperties(schema.nodes[nodeType])[field] !== kind) {
    throw new CollabError(`node '${nodeId}' has no ${kind} field '${field}'`);
  }
  return ensureLoroCollab(doc, schema, nodeId, nodeType).get(field);
}

export class LoroCollabText implements CollabText {
  readonly kind = "text" as const;

  constructor(
    private readonly text: LoroText,
    private readonly doc: LoroDoc,
  ) {}

  toString(): string {
    return this.text.toString();
  }

  insert(index: number, value: string): void {
    this.text.insert(index, value);
    this.doc.commit();
  }

  delete(index: number, length: number): void {
    this.text.delete(index, length);
    this.doc.commit();
  }

  replace(value: string): void {
    replaceText(
      {
        toString: () => this.text.toString(),
        insert: (i, v) => this.text.insert(i, v),
        delete: (i, n) => this.text.delete(i, n),
      },
      value,
    );
    this.doc.commit();
  }

  observe(listener: () => void): () => void {
    return this.text.subscribe(() => {
      listener();
    });
  }
}

export class LoroCollabMap implements CollabMap {
  readonly kind = "map" as const;

  constructor(
    private readonly map: LoroMap<Record<string, unknown>>,
    private readonly doc: LoroDoc,
  ) {}

  get(key: string): unknown {
    return cloneJson(this.map.get(key) ?? null);
  }

  set(key: string, value: unknown): void {
    this.map.set(key, asValue(cloneJson(value)));
    this.doc.commit();
  }

  delete(key: string): void {
    this.map.delete(key);
    this.doc.commit();
  }

  toJSON(): Record<string, unknown> {
    return this.map.toJSON() as Record<string, unknown>;
  }

  replace(value: Record<string, unknown>): void {
    for (const key of this.map.keys()) {
      this.map.delete(String(key));
    }
    for (const [key, item] of Object.entries(value)) {
      this.map.set(key, asValue(cloneJson(item)));
    }
    this.doc.commit();
  }

  observe(listener: () => void): () => void {
    return this.map.subscribe(() => {
      listener();
    });
  }
}

export class LoroCollabArray implements CollabArray {
  readonly kind = "array" as const;

  constructor(
    private readonly list: LoroMovableList,
    private readonly doc: LoroDoc,
  ) {}

  toJSON(): unknown[] {
    return this.list.toJSON() as unknown[];
  }

  replace(value: unknown[]): void {
    for (let i = this.list.length - 1; i >= 0; i -= 1) {
      this.list.delete(i, 1);
    }
    for (const item of value) {
      this.list.push(asValue(cloneJson(item)));
    }
    this.doc.commit();
  }

  push(value: unknown): void {
    this.list.push(asValue(cloneJson(value)));
    this.doc.commit();
  }

  observe(listener: () => void): () => void {
    return this.list.subscribe(() => {
      listener();
    });
  }
}

export function loroCollabText(
  doc: LoroDoc,
  schema: GraphSchema,
  nodeId: string,
  field: string,
): CollabText {
  const value = requireField(doc, schema, nodeId, field, "text");
  if (!isLoroText(value)) {
    throw new CollabError(`node '${nodeId}' has no text field '${field}'`);
  }
  return new LoroCollabText(value, doc);
}

export function loroCollabMap(
  doc: LoroDoc,
  schema: GraphSchema,
  nodeId: string,
  field: string,
): CollabMap {
  const value = requireField(doc, schema, nodeId, field, "map");
  if (!isLoroMap(value)) {
    throw new CollabError(`node '${nodeId}' has no map field '${field}'`);
  }
  return new LoroCollabMap(value, doc);
}

export function loroCollabArray(
  doc: LoroDoc,
  schema: GraphSchema,
  nodeId: string,
  field: string,
): CollabArray {
  const value = requireField(doc, schema, nodeId, field, "array");
  if (!isListLike(value)) {
    throw new CollabError(`node '${nodeId}' has no array field '${field}'`);
  }
  return new LoroCollabArray(value as LoroMovableList, doc);
}
