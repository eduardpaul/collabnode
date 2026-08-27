import { z } from "zod";

const prioritySchema = z.enum(["low", "medium", "high"]);
const severitySchema = z.enum(["low", "medium", "high", "critical"]);
const categorySchema = z.enum(["business", "technical"]);

export const managerPlanSchema = z.object({
  epics: z.array(
    z.object({
      title: z.string(),
      description: z.string(),
      priority: prioritySchema,
      features: z.array(
        z.object({
          title: z.string(),
          description: z.string(),
        }),
      ),
    }),
  ),
  businessRisks: z.array(
    z.object({
      title: z.string(),
      description: z.string(),
      severity: severitySchema,
      mitigation: z.string(),
    }),
  ),
  assumption: z
    .object({
      title: z.string(),
      description: z.string(),
    })
    .nullable(),
});

export type ManagerPlan = z.infer<typeof managerPlanSchema>;

export const architectPlanSchema = z.object({
  c4Models: z.array(
    z.object({
      title: z.string(),
      level: z.enum(["context", "container", "component"]),
      markdown: z.string(),
    }),
  ),
  tasks: z.array(
    z.object({
      title: z.string(),
      description: z.string(),
      featureTitle: z.string(),
      functionalPoints: z.string(),
      technicalPoints: z.string(),
      complexity: z.number(),
      uncertainty: z.number(),
      friction: z.number(),
      nfrScale: z.number(),
      status: z.enum(["todo", "doing", "done"]),
    }),
  ),
  techRisks: z.array(
    z.object({
      title: z.string(),
      description: z.string(),
      severity: severitySchema,
      mitigation: z.string(),
    }),
  ),
});

export type ArchitectPlan = z.infer<typeof architectPlanSchema>;

const revisionPropertiesSchema = z.object({
  title: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  priority: prioritySchema.nullable().optional(),
  epicTitle: z.string().nullable().optional(),
  featureTitle: z.string().nullable().optional(),
  markdown: z.string().nullable().optional(),
  level: z.enum(["context", "container", "component"]).nullable().optional(),
  functionalPoints: z.string().nullable().optional(),
  technicalPoints: z.string().nullable().optional(),
  complexity: z.number().nullable().optional(),
  uncertainty: z.number().nullable().optional(),
  friction: z.number().nullable().optional(),
  nfrScale: z.number().nullable().optional(),
  status: z.enum(["todo", "doing", "done"]).nullable().optional(),
  severity: severitySchema.nullable().optional(),
  category: categorySchema.nullable().optional(),
  mitigation: z.string().nullable().optional(),
});

const revisionLinkSchema = z
  .object({
    type: z.string(),
    from: z.string(),
  })
  .nullable();

export const managerRevisionSchema = z.object({
  review: z.string(),
  updates: z.array(
    z.object({
      id: z.string(),
      properties: revisionPropertiesSchema,
    }),
  ),
  creates: z.array(
    z.object({
      type: z.enum(["Epic", "Feature", "C4Model", "Task", "Risk", "Assumption"]),
      properties: revisionPropertiesSchema,
      link: revisionLinkSchema,
    }),
  ),
  risks: z.array(
    z.object({
      title: z.string(),
      description: z.string(),
      severity: severitySchema,
      category: categorySchema.nullable().optional(),
      mitigation: z.string(),
      linkFrom: z.string().nullable().optional(),
    }),
  ),
  assumption: z
    .object({
      title: z.string(),
      description: z.string(),
    })
    .nullable(),
  agrees: z.boolean(),
});

export type ManagerRevision = z.infer<typeof managerRevisionSchema>;

export const architectRevisionSchema = z.object({
  review: z.string(),
  updates: z.array(
    z.object({
      id: z.string(),
      properties: revisionPropertiesSchema,
    }),
  ),
  creates: z.array(
    z.object({
      type: z.enum(["Epic", "Feature", "C4Model", "Task", "Risk", "Assumption"]),
      properties: revisionPropertiesSchema,
      link: revisionLinkSchema,
    }),
  ),
  risks: z.array(
    z.object({
      title: z.string(),
      description: z.string(),
      severity: severitySchema,
      category: categorySchema.nullable().optional(),
      mitigation: z.string(),
      linkFrom: z.string().nullable().optional(),
    }),
  ),
  agrees: z.boolean(),
});

export type ArchitectRevision = z.infer<typeof architectRevisionSchema>;

export function omitNullish(properties: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value !== null && value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}
