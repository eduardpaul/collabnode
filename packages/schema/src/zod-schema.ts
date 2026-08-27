import { z } from "zod";
import { PROPERTY_TYPE_NAMES, PROPERTY_WIDGETS } from "./types.js";

const i18nString = z.union([z.string(), z.record(z.string(), z.string())]);
const i18nStringList = z.union([
  z.array(z.string()),
  z.record(z.string(), z.array(z.string())),
]);

const propertyUi = z.strictObject({
  widget: z.enum(PROPERTY_WIDGETS).optional(),
  label: i18nString.optional(),
});

/** `search: true | false | { boost }` — normalized to PropertySearch at parse time. */
const propertySearch = z.union([
  z.boolean(),
  z.strictObject({
    index: z.boolean().optional(),
    boost: z.number().positive().optional(),
  }),
]);

/** `vector: true | false | {}` — normalized to PropertyVector at parse time. */
const propertyVector = z.union([
  z.boolean(),
  z.strictObject({
    index: z.boolean().optional(),
  }),
]);

const propertyDef = z
  .strictObject({
    type: z.enum(PROPERTY_TYPE_NAMES),
    required: z.boolean().optional(),
    default: z.unknown().optional(),
    values: z.array(z.string().min(1)).min(1).optional(),
    description: i18nString.optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    integer: z.boolean().optional(),
    maxLength: z.number().int().positive().optional(),
    derived: z.string().min(1).optional(),
    ui: propertyUi.optional(),
    search: propertySearch.optional(),
    vector: propertyVector.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.type === "enum" && (value.values === undefined || value.values.length === 0)) {
      ctx.addIssue({
        code: "custom",
        message: "enum properties require a non-empty `values` list",
        path: ["values"],
      });
    }
    if (value.type !== "enum" && value.values !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "`values` is only valid on enum properties",
        path: ["values"],
      });
    }
    if (value.type !== "number") {
      if (value.min !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: "`min` is only valid on number properties",
          path: ["min"],
        });
      }
      if (value.max !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: "`max` is only valid on number properties",
          path: ["max"],
        });
      }
      if (value.integer !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: "`integer` is only valid on number properties",
          path: ["integer"],
        });
      }
      if (value.derived !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: "`derived` is only valid on number properties",
          path: ["derived"],
        });
      }
    }
    // An embedding of a boolean or a timestamp carries no meaning to retrieve
    // by, so asking for one is a mistake worth reporting at parse time.
    const vectorable = value.type === "string" || value.type === "text" || value.type === "enum";
    if (!vectorable && value.vector !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "`vector` is only valid on string, text, and enum properties",
        path: ["vector"],
      });
    }
    if (value.min !== undefined && value.max !== undefined && value.min > value.max) {
      ctx.addIssue({
        code: "custom",
        message: "`min` must be <= `max`",
        path: ["min"],
      });
    }
    if (value.integer) {
      if (value.min !== undefined && !Number.isInteger(value.min)) {
        ctx.addIssue({
          code: "custom",
          message: "`min` must be an integer when `integer` is true",
          path: ["min"],
        });
      }
      if (value.max !== undefined && !Number.isInteger(value.max)) {
        ctx.addIssue({
          code: "custom",
          message: "`max` must be an integer when `integer` is true",
          path: ["max"],
        });
      }
    }
    if (value.maxLength !== undefined && value.type !== "string") {
      ctx.addIssue({
        code: "custom",
        message: "`maxLength` is only valid on string properties",
        path: ["maxLength"],
      });
    }
    if (value.derived !== undefined) {
      if (value.required) {
        ctx.addIssue({
          code: "custom",
          message: "`required` cannot be combined with `derived`",
          path: ["required"],
        });
      }
      if (value.default !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: "`default` cannot be combined with `derived`",
          path: ["default"],
        });
      }
    }
    issueForDefault(value, ctx);
  });

function issueForDefault(
  def: {
    type: (typeof PROPERTY_TYPE_NAMES)[number];
    default?: unknown;
    values?: string[];
    min?: number;
    max?: number;
    integer?: boolean;
    maxLength?: number;
  },
  ctx: z.RefinementCtx,
): void {
  if (def.default === undefined) {
    return;
  }
  if (def.default === null) {
    ctx.addIssue({
      code: "custom",
      message: "`default` cannot be null",
      path: ["default"],
    });
    return;
  }
  const value = def.default;
  switch (def.type) {
    case "string":
    case "enum":
      if (typeof value !== "string") {
        ctx.addIssue({
          code: "custom",
          message: "`default` must be a string",
          path: ["default"],
        });
        return;
      }
      if (def.type === "enum" && def.values && !def.values.includes(value)) {
        ctx.addIssue({
          code: "custom",
          message: `\`default\` must be one of ${def.values.join(", ")}`,
          path: ["default"],
        });
      }
      if (def.maxLength !== undefined && value.length > def.maxLength) {
        ctx.addIssue({
          code: "custom",
          message: `\`default\` must be at most ${def.maxLength} characters`,
          path: ["default"],
        });
      }
      return;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        ctx.addIssue({
          code: "custom",
          message: "`default` must be a finite number",
          path: ["default"],
        });
        return;
      }
      if (def.integer && !Number.isInteger(value)) {
        ctx.addIssue({
          code: "custom",
          message: "`default` must be an integer",
          path: ["default"],
        });
      }
      if (def.min !== undefined && value < def.min) {
        ctx.addIssue({
          code: "custom",
          message: `\`default\` must be >= ${def.min}`,
          path: ["default"],
        });
      }
      if (def.max !== undefined && value > def.max) {
        ctx.addIssue({
          code: "custom",
          message: `\`default\` must be <= ${def.max}`,
          path: ["default"],
        });
      }
      return;
    case "boolean":
      if (typeof value !== "boolean") {
        ctx.addIssue({
          code: "custom",
          message: "`default` must be a boolean",
          path: ["default"],
        });
      }
      return;
    case "datetime":
      if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
        ctx.addIssue({
          code: "custom",
          message: "`default` must be an ISO-8601 datetime string",
          path: ["default"],
        });
      }
      return;
    case "json":
      return;
    case "text":
      if (typeof value !== "string") {
        ctx.addIssue({
          code: "custom",
          message: "`default` must be a string",
          path: ["default"],
        });
      }
      return;
    case "map":
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        ctx.addIssue({
          code: "custom",
          message: "`default` must be an object",
          path: ["default"],
        });
      }
      return;
    case "array":
      if (!Array.isArray(value)) {
        ctx.addIssue({
          code: "custom",
          message: "`default` must be an array",
          path: ["default"],
        });
      }
      return;
    default:
      return;
  }
}
const uiMeta = z.strictObject({
  label: i18nString.optional(),
  icon: z.string().optional(),
  color: z.string().optional(),
});

const nodeType = z.strictObject({
  description: i18nString.optional(),
  identity: z
    .object({
      from: z.array(z.string().min(1)).min(1),
    })
    .optional(),
  singleton: z.boolean().optional(),
  properties: z.record(z.string().min(1), propertyDef).default({}),
  ui: uiMeta.optional(),
  guidelines: i18nStringList.optional(),
});

const edgeType = z.strictObject({
  description: i18nString.optional(),
  from: z.array(z.string().min(1)).min(1),
  to: z.array(z.string().min(1)).min(1),
  directed: z.boolean().optional(),
  properties: z.record(z.string().min(1), propertyDef).default({}),
  ui: uiMeta.optional(),
  guidelines: i18nStringList.optional(),
});

export const rawSchema = z.strictObject({
  name: z.string().min(1),
  version: z.number().int().positive(),
  description: i18nString.optional(),
  config: z.strictObject({
    schemaId: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/i, "schemaId must be alphanumeric plus hyphens"),
    idStrategy: z.enum(["uuid", "ulid", "literal"]).default("uuid"),
    display: z
      .object({
        title: i18nString.optional(),
      })
      .optional(),
    changeTracking: z
      .strictObject({
        enabled: z.boolean().default(false),
        mode: z.enum(["last-write", "history"]).default("last-write"),
        historyLimit: z.number().int().positive().optional(),
      })
      .optional(),
    tags: z
      .strictObject({
        enabled: z.boolean(),
      })
      .optional(),
  }),
  nodes: z.record(z.string().min(1), nodeType).default({}),
  edges: z.record(z.string().min(1), edgeType).default({}),
});

export type RawSchema = z.infer<typeof rawSchema>;

/** One property exactly as YAML spells it, before `search` is normalized. */
export type RawProperty = z.infer<typeof propertyDef>;

export const rawParamDef = z.strictObject({
  type: z.enum(["string", "number", "boolean", "array", "object", "json"]),
  required: z.boolean().optional(),
  default: z.unknown().optional(),
  description: i18nString.optional(),
  of: z.enum(["string", "number", "boolean", "array", "object", "json"]).optional(),
});

export const rawTemplateNode = z.strictObject({
  type: z.string().min(1),
  as: z.string().optional(),
  id: z.string().optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  tags: z.union([z.array(z.string()), z.string()]).optional(),
  forEach: z.string().optional(),
  itemVar: z.string().optional(),
  indexVar: z.string().optional(),
  when: z.string().optional(),
  if: z.string().optional(),
});

const edgeEndpoint = z.union([
  z.string(),
  z.strictObject({ ref: z.string() }),
  z.strictObject({ id: z.string() }),
]);

export const rawTemplateEdge = z.strictObject({
  type: z.string().min(1),
  from: edgeEndpoint,
  to: edgeEndpoint,
  properties: z.record(z.string(), z.unknown()).optional(),
  id: z.string().optional(),
  as: z.string().optional(),
  forEach: z.string().optional(),
  itemVar: z.string().optional(),
  indexVar: z.string().optional(),
  when: z.string().optional(),
  if: z.string().optional(),
});

export const rawTemplate = z.strictObject({
  nodes: z.array(rawTemplateNode).optional().default([]),
  edges: z.array(rawTemplateEdge).optional().default([]),
});

export const rawLifecycle = z.strictObject({
  idleTimeout: z.union([z.string(), z.number().positive()]).optional(),
  maxDuration: z.union([z.string(), z.number().positive()]).optional(),
  endWhen: z.string().optional(),
});

export const rawNamedTool = z.strictObject({
  description: i18nString.optional(),
  creates: z.string().optional(),
  into: z.string().optional(),
  properties: z.record(z.string(), propertyDef).optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
});

export const rawAgentNodes = z.strictObject({
  readOnly: z.array(z.string().min(1)).optional(),
  hidden: z.array(z.string().min(1)).optional(),
});

export const rawAgent = z.strictObject({
  role: z.string().min(1),
  actorId: z.string().min(1),
  description: i18nString.optional(),
  systemPrompt: i18nString.optional(),
  tools: z.array(z.string()).optional(),
  nodes: rawAgentNodes.optional(),
  internalPlanning: z.boolean().optional(),
});

export const rawTools = z.strictObject({
  expose: z.array(z.string()).optional(),
  named: z.record(z.string(), rawNamedTool).optional(),
  agents: z.array(rawAgent).optional(),
});

export const rawRetention = z.strictObject({
  onEnd: z.enum(["delete", "keep", "archive"]).optional(),
  artifact: z.enum(["required", "optional", "none"]).optional(),
});

export const rawWorkspaceType = z.strictObject({
  type: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  version: z.number().int().positive(),
  description: i18nString.optional(),
  schema: z
    .strictObject({
      name: z.string().optional(),
      version: z.number().int().positive().optional(),
      description: i18nString.optional(),
      config: rawSchema.shape.config.optional(),
      nodes: z.record(z.string().min(1), nodeType).default({}),
      edges: z.record(z.string().min(1), edgeType).default({}),
    })
    .optional(),
  nodes: z.record(z.string().min(1), nodeType).optional(),
  edges: z.record(z.string().min(1), edgeType).optional(),
  config: rawSchema.shape.config.optional(),
  params: z.record(z.string().min(1), rawParamDef).optional(),
  template: rawTemplate.optional(),
  lifecycle: rawLifecycle.optional(),
  tools: rawTools.optional(),
  projection: z.enum(["none", "memory", "shared"]).optional(),
  retention: rawRetention.optional(),
});

export type RawWorkspaceType = z.infer<typeof rawWorkspaceType>;

