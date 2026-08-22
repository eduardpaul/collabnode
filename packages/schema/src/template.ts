import { evaluateExpression, evaluateValue, interpolateTemplate } from "./expr.js";
import type {
  GraphOpInput,
  GraphSchema,
  NodeRef,
  ParamDef,
  TemplateDef,
  TemplateEdgeDef,
  WorkspaceType,
} from "./types.js";
import { SchemaError } from "./types.js";

/**
 * Validates parameter values against their definitions, applying defaults.
 */
export function validateParams(
  paramDefs: Record<string, ParamDef> = {},
  params: Record<string, unknown> = {},
  path = "params",
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...params };
  for (const [name, def] of Object.entries(paramDefs)) {
    let value = result[name];
    if (value === undefined) {
      if (def.default !== undefined) {
        value = def.default;
        result[name] = value;
      } else if (def.required) {
        throw new SchemaError(`missing required parameter '${name}'`, `${path}.${name}`);
      } else {
        continue;
      }
    }
    validateParamValue(def, value, `${path}.${name}`);
  }
  return result;
}

function validateParamValue(def: ParamDef, value: unknown, path: string): void {
  switch (def.type) {
    case "string":
      if (typeof value !== "string") {
        throw new SchemaError(`parameter must be a string`, path);
      }
      break;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new SchemaError(`parameter must be a finite number`, path);
      }
      break;
    case "boolean":
      if (typeof value !== "boolean") {
        throw new SchemaError(`parameter must be a boolean`, path);
      }
      break;
    case "array":
      if (!Array.isArray(value)) {
        throw new SchemaError(`parameter must be an array`, path);
      }
      if (def.of) {
        for (let i = 0; i < value.length; i++) {
          validateParamValue({ type: def.of }, value[i], `${path}[${i}]`);
        }
      }
      break;
    case "object":
    case "json":
      if (value === null || typeof value !== "object") {
        throw new SchemaError(`parameter must be an object`, path);
      }
      break;
  }
}

function evaluateCondition(
  condition: string | undefined,
  context: Record<string, unknown>,
  path: string,
): boolean {
  if (!condition || !condition.trim()) {
    return true;
  }
  const result = evaluateExpression(condition, context, path);
  return Boolean(result);
}

function evaluateTags(
  tags: string[] | string | undefined,
  context: Record<string, unknown>,
  path: string,
): string[] | undefined {
  if (tags === undefined) {
    return undefined;
  }
  if (typeof tags === "string") {
    const interpolated = interpolateTemplate(tags, context, path);
    return interpolated.split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (Array.isArray(tags)) {
    return tags
      .map((tag) => interpolateTemplate(tag, context, path))
      .filter(Boolean);
  }
  return undefined;
}

function evaluatePropertyMap(
  properties: Record<string, unknown> | undefined,
  context: Record<string, unknown>,
  path: string,
): Record<string, unknown> {
  if (!properties) {
    return {};
  }
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(properties)) {
    result[key] = evaluateValue(val, context, `${path}.${key}`);
  }
  return result;
}

function resolveEdgeEndpoint(
  endpoint: TemplateEdgeDef["from"],
  context: Record<string, unknown>,
  declaredRefs: Set<string>,
  path: string,
): NodeRef {
  if (typeof endpoint === "object" && endpoint !== null) {
    if ("ref" in endpoint) {
      const refName = interpolateTemplate(endpoint.ref, context, path);
      return { ref: refName };
    }
    if ("id" in endpoint) {
      return interpolateTemplate(endpoint.id, context, path);
    }
  }
  if (typeof endpoint === "string") {
    const trimmed = endpoint.trim();
    const refMatch = trimmed.match(/^\{\s*ref:\s*['"]?([^'"}\s]+)['"]?\s*\}$/i);
    if (refMatch) {
      const refName = interpolateTemplate(refMatch[1]!, context, path);
      return { ref: refName };
    }
    const idMatch = trimmed.match(/^\{\s*id:\s*['"]?([^'"}\s]+)['"]?\s*\}$/i);
    if (idMatch) {
      return interpolateTemplate(idMatch[1]!, context, path);
    }
    const str = interpolateTemplate(endpoint, context, path);
    if (declaredRefs.has(str)) {
      return { ref: str };
    }
    return str;
  }
  throw new SchemaError(`invalid edge endpoint`, path);
}

function resolveIterable(
  expr: string,
  context: Record<string, unknown>,
  path: string,
): unknown[] {
  if (expr in context) {
    const val = context[expr];
    if (Array.isArray(val)) {
      return val;
    }
    throw new SchemaError(`forEach parameter '${expr}' must be an array`, path);
  }
  const evaluated = evaluateExpression(expr, context, path);
  if (Array.isArray(evaluated)) {
    return evaluated;
  }
  throw new SchemaError(`forEach expression must evaluate to an array`, path);
}

/**
 * Compiles a WorkspaceType's template (or a standalone TemplateDef) into a list
 * of GraphOpInput operations ready to be passed to session.applyOps().
 */
export function compileTemplate(
  typeOrTemplate: WorkspaceType | TemplateDef,
  paramsInput?: Record<string, unknown>,
  _schemaOverride?: GraphSchema,
): GraphOpInput[] {
  let template: TemplateDef;
  let paramDefs: Record<string, ParamDef> = {};

  if ("schema" in typeOrTemplate) {
    const ws = typeOrTemplate as WorkspaceType;
    template = ws.template ?? { nodes: [], edges: [] };
    paramDefs = ws.params ?? {};
  } else {
    template = typeOrTemplate as TemplateDef;
    paramDefs = {};
  }


  const params = validateParams(paramDefs, paramsInput ?? {});
  const ops: GraphOpInput[] = [];
  const declaredRefs = new Set<string>();

  // Pass 1: Collect static aliases to support forward references in edges
  for (const nodeDef of template.nodes ?? []) {
    if (!nodeDef.forEach && nodeDef.as && !nodeDef.as.includes("{")) {
      declaredRefs.add(nodeDef.as);
    }
  }

  // Pass 2: Compile nodes
  for (let i = 0; i < (template.nodes ?? []).length; i++) {
    const nodeDef = template.nodes![i]!;
    const nodePath = `template.nodes[${i}]`;

    if (nodeDef.forEach) {
      const items = resolveIterable(nodeDef.forEach, params, `${nodePath}.forEach`);
      const itemVar = nodeDef.itemVar ?? "item";
      const indexVar = nodeDef.indexVar ?? "index";

      for (let idx = 0; idx < items.length; idx++) {
        const item = items[idx];
        const itemContext: Record<string, unknown> = {
          ...params,
          [itemVar]: item,
          [indexVar]: idx,
          idx,
        };
        if (item !== null && typeof item === "object" && !Array.isArray(item)) {
          Object.assign(itemContext, item);
        }

        const condition = nodeDef.when ?? (nodeDef as { if?: string }).if;
        if (!evaluateCondition(condition, itemContext, `${nodePath}.when`)) {
          continue;
        }

        const ref = nodeDef.as ? interpolateTemplate(nodeDef.as, itemContext, `${nodePath}.as`) : undefined;
        if (ref) {
          declaredRefs.add(ref);
        }
        const id = nodeDef.id ? interpolateTemplate(nodeDef.id, itemContext, `${nodePath}.id`) : undefined;
        const properties = evaluatePropertyMap(nodeDef.properties, itemContext, `${nodePath}.properties`);
        const tags = evaluateTags(nodeDef.tags, itemContext, `${nodePath}.tags`);

        ops.push({
          op: "upsertNode",
          type: nodeDef.type,
          ...(ref !== undefined ? { ref } : {}),
          ...(id !== undefined ? { id } : {}),
          properties,
          ...(tags !== undefined ? { tags } : {}),
        });
      }
    } else {
      const condition = nodeDef.when ?? (nodeDef as { if?: string }).if;
      if (!evaluateCondition(condition, params, `${nodePath}.when`)) {
        continue;
      }

      const ref = nodeDef.as ? interpolateTemplate(nodeDef.as, params, `${nodePath}.as`) : undefined;
      if (ref) {
        declaredRefs.add(ref);
      }
      const id = nodeDef.id ? interpolateTemplate(nodeDef.id, params, `${nodePath}.id`) : undefined;
      const properties = evaluatePropertyMap(nodeDef.properties, params, `${nodePath}.properties`);
      const tags = evaluateTags(nodeDef.tags, params, `${nodePath}.tags`);

      ops.push({
        op: "upsertNode",
        type: nodeDef.type,
        ...(ref !== undefined ? { ref } : {}),
        ...(id !== undefined ? { id } : {}),
        properties,
        ...(tags !== undefined ? { tags } : {}),
      });
    }
  }

  // Pass 3: Compile edges
  for (let i = 0; i < (template.edges ?? []).length; i++) {
    const edgeDef = template.edges![i]!;
    const edgePath = `template.edges[${i}]`;

    if (edgeDef.forEach) {
      const items = resolveIterable(edgeDef.forEach, params, `${edgePath}.forEach`);
      const itemVar = edgeDef.itemVar ?? "item";
      const indexVar = edgeDef.indexVar ?? "index";

      for (let idx = 0; idx < items.length; idx++) {
        const item = items[idx];
        const itemContext: Record<string, unknown> = {
          ...params,
          [itemVar]: item,
          [indexVar]: idx,
          idx,
        };
        if (item !== null && typeof item === "object" && !Array.isArray(item)) {
          Object.assign(itemContext, item);
        }

        const condition = edgeDef.when ?? (edgeDef as { if?: string }).if;
        if (!evaluateCondition(condition, itemContext, `${edgePath}.when`)) {
          continue;
        }

        const from = resolveEdgeEndpoint(edgeDef.from, itemContext, declaredRefs, `${edgePath}.from`);
        const to = resolveEdgeEndpoint(edgeDef.to, itemContext, declaredRefs, `${edgePath}.to`);
        const properties = evaluatePropertyMap(edgeDef.properties, itemContext, `${edgePath}.properties`);
        const id = edgeDef.id ? interpolateTemplate(edgeDef.id, itemContext, `${edgePath}.id`) : undefined;

        ops.push({
          op: "upsertEdge",
          type: edgeDef.type,
          from,
          to,
          properties,
          ...(id !== undefined ? { id } : {}),
        });
      }
    } else {
      const condition = edgeDef.when ?? (edgeDef as { if?: string }).if;
      if (!evaluateCondition(condition, params, `${edgePath}.when`)) {
        continue;
      }

      const from = resolveEdgeEndpoint(edgeDef.from, params, declaredRefs, `${edgePath}.from`);
      const to = resolveEdgeEndpoint(edgeDef.to, params, declaredRefs, `${edgePath}.to`);
      const properties = evaluatePropertyMap(edgeDef.properties, params, `${edgePath}.properties`);
      const id = edgeDef.id ? interpolateTemplate(edgeDef.id, params, `${edgePath}.id`) : undefined;

      ops.push({
        op: "upsertEdge",
        type: edgeDef.type,
        from,
        to,
        properties,
        ...(id !== undefined ? { id } : {}),
      });
    }
  }

  return ops;
}
