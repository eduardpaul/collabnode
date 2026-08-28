import { resolveI18nString, type ParamDef, type PropertyDef } from "@collabnode/schema";
import { z, type ZodType } from "zod/v4";
import { getLocale, type SupportedLanguage } from "./i18n.js";

export function propertyZod(
  def: PropertyDef,
  language?: SupportedLanguage | string,
): ZodType {
  const t = getLocale(language);
  const desc = resolveI18nString(def.description, language);
  let schema: ZodType;
  switch (def.type) {
    case "string":
      schema = def.maxLength !== undefined ? z.string().max(def.maxLength) : z.string();
      break;
    case "number": {
      let numberSchema = z.number();
      if (def.integer) {
        numberSchema = numberSchema.int();
      }
      if (def.min !== undefined) {
        numberSchema = numberSchema.min(def.min);
      }
      if (def.max !== undefined) {
        numberSchema = numberSchema.max(def.max);
      }
      schema = numberSchema;
      break;
    }
    case "boolean":
      schema = z.boolean();
      break;
    case "datetime":
      schema = z.string().describe(t.tools.propertyDescriptions.datetime);
      break;
    case "enum": {
      const values = def.values ?? [];
      if (values.length === 0) {
        schema = z.string();
      } else {
        schema = z.enum(values as [string, ...string[]]);
      }
      break;
    }
    case "json":
    case "map":
    case "array":
      schema = z.unknown();
      break;
    case "text":
      schema = z
        .string()
        .describe(
          desc
            ? t.tools.propertyDescriptions.textWithDesc(desc)
            : t.tools.propertyDescriptions.textDefault,
        );
      break;
    default: {
      const _never: never = def.type;
      schema = z.unknown();
      void _never;
    }
  }
  if (desc && def.type !== "text" && def.type !== "datetime") {
    schema = schema.describe(desc);
  } else if (desc && def.type === "datetime") {
    schema = schema.describe(t.tools.propertyDescriptions.datetimeWithDesc(desc));
  }
  if (def.default !== undefined || !def.required) {
    schema = schema.optional().nullable();
  }
  return schema;
}

export function propertiesZod(
  properties: Record<string, PropertyDef>,
  language?: SupportedLanguage | string,
): z.ZodObject<Record<string, ZodType>> {
  const shape: Record<string, ZodType> = {};
  for (const [name, def] of Object.entries(properties)) {
    if (def.derived !== undefined) {
      continue;
    }
    shape[name] = propertyZod(def, language);
  }
  return z.object(shape);
}

/**
 * Zod for a view's parameters. Params are a smaller vocabulary than properties
 * — no enums, no CRDT types — and are optional unless declared `required`, so
 * that a parameterized view stays callable with no arguments at all.
 */
export function paramsZod(
  params: Record<string, ParamDef>,
  language?: SupportedLanguage | string,
): z.ZodObject<Record<string, ZodType>> {
  const shape: Record<string, ZodType> = {};
  for (const [name, def] of Object.entries(params)) {
    let schema: ZodType;
    switch (def.type) {
      case "number":
        schema = z.number();
        break;
      case "boolean":
        schema = z.boolean();
        break;
      case "array":
        schema = z.array(z.unknown());
        break;
      case "object":
      case "json":
        schema = z.unknown();
        break;
      default:
        schema = z.string();
        break;
    }
    const desc = resolveI18nString(def.description, language);
    if (desc) {
      schema = schema.describe(desc);
    }
    if (!def.required) {
      schema = schema.optional();
    }
    shape[name] = schema;
  }
  return z.object(shape);
}
