import type { PropertyMap } from "@collabnode/graph";
import {
  arithmeticIdentifiers,
  evaluateExpression,
  parseArithmeticExpression,
  SchemaError,
  type PropertyDef,
} from "@collabnode/schema";
import { coerceProperty } from "./validate.js";

export function applyDerivedProperties(
  defs: Record<string, PropertyDef>,
  properties: PropertyMap,
  path: string,
): PropertyMap {
  const result: PropertyMap = { ...properties };
  for (const [name, def] of Object.entries(defs)) {
    if (def.derived === undefined) {
      continue;
    }
    const exprPath = `${path}.${name}.derived`;
    const expr = parseArithmeticExpression(def.derived, exprPath);
    const values: Record<string, number> = {};
    let missing = false;
    for (const ident of arithmeticIdentifiers(expr)) {
      const value = properties[ident];
      if (value === undefined || value === null) {
        missing = true;
        break;
      }
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new SchemaError(
          `derived expression expected a finite number for '${ident}'`,
          exprPath,
        );
      }
      values[ident] = value;
    }
    if (missing) {
      delete result[name];
      continue;
    }
    const computed = evaluateExpression(expr, values, exprPath);
    if (typeof computed !== "number" || !Number.isFinite(computed)) {
      throw new SchemaError("derived expression did not produce a finite number", exprPath);
    }
    result[name] = coerceProperty(def, computed, `${path}.${name}`);
  }
  return result;
}

