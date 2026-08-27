import { tool as createLangChainTool, type StructuredToolInterface } from "@langchain/core/tools";
import { buildTools, type BoundTool } from "@collabnode/mcp";
import type { CollabSession } from "@collabnode/runtime";
import { resolveNodeAccess, type AgentDef, type GraphSchema, type ToolsPolicyDef } from "@collabnode/schema";
import type { ToolCallEvent } from "./types.js";

export interface BindAgentToolsOptions {
  session: CollabSession;
  schema: GraphSchema;
  toolsPolicy?: ToolsPolicyDef;
  agentDef?: AgentDef;
  actorId?: string;
  language?: string;
  extraTools?: StructuredToolInterface[];
  excludedTools?: string[];
  onToolCall?: (event: ToolCallEvent) => void;
}

/**
 * Filter bound MCP tools based on the agent's declared tools, node access policy,
 * and excluded tool names.
 */
function shouldIncludeTool(
  tool: BoundTool,
  agentDef?: AgentDef,
  excludedNames?: Set<string>,
): boolean {
  if (excludedNames?.has(tool.name)) {
    return false;
  }

  if (agentDef?.tools && agentDef.tools.length > 0) {
    return agentDef.tools.includes(tool.name);
  }

  return true;
}

import { z } from "zod";

function cleanJsonSchema(schema: unknown): Record<string, unknown> {
  let converted: Record<string, unknown>;
  try {
    converted = z.toJSONSchema(schema as z.ZodTypeAny, {
      target: "draft-7",
      unrepresentable: "any",
    }) as Record<string, unknown>;
  } catch {
    converted = { type: "object", properties: {} };
  }

  function clean(obj: any) {
    if (!obj || typeof obj !== "object") return;
    delete obj.$schema;
    delete obj.$id;
    delete obj.propertyNames;
    delete obj.patternProperties;
    if ("const" in obj) {
      obj.enum = [obj.const];
      delete obj.const;
    }
    if (obj.properties && typeof obj.properties === "object") {
      for (const val of Object.values(obj.properties)) {
        clean(val);
      }
    }
    if (obj.items) clean(obj.items);
    if (Array.isArray(obj.allOf)) obj.allOf.forEach(clean);
    if (Array.isArray(obj.anyOf)) obj.anyOf.forEach(clean);
    if (Array.isArray(obj.oneOf)) obj.oneOf.forEach(clean);
  }

  clean(converted);
  return converted;
}

/**
 * Binds Collabnode schema-driven MCP tools into native LangChain StructuredTools,
 * stamped with the target actor ID and respecting node access policies.
 */
export function bindAgentTools(options: BindAgentToolsOptions): StructuredToolInterface[] {
  const {
    session,
    schema,
    toolsPolicy,
    agentDef,
    actorId = agentDef?.actorId ?? session.actorId ?? "agent",
    language = "en",
    extraTools = [],
    excludedTools = [],
    onToolCall,
  } = options;

  const excludedSet = new Set(excludedTools);

  // Bind session to the agent's actor ID so change tracking and history attribute writes correctly
  const boundSession =
    session.schema.config.changeTracking.enabled && session.actorId !== actorId
      ? session.runAs(actorId)
      : session;

  const access = resolveNodeAccess(schema, { agents: agentDef ? [agentDef] : [] }, agentDef?.role);

  // Generate all tools supported by the schema for this session and role
  const rawTools = buildTools(boundSession.schema, boundSession, {
    language,
    graphKind: "memory",
    policy: toolsPolicy,
    agentRole: agentDef?.role,
  });

  const langchainTools: StructuredToolInterface[] = [];

  for (const rawTool of rawTools) {
    if (!shouldIncludeTool(rawTool, agentDef, excludedSet)) {
      continue;
    }

    const wrapped = createLangChainTool(
      async (args: Record<string, unknown>) => {
        const parsed = rawTool.inputSchema.parse(args ?? {}) as Record<string, unknown>;
        const res = await rawTool.handler(parsed);
        const resultText = res.content.map((entry) => entry.text).join("\n");

        if (onToolCall) {
          onToolCall({
            name: rawTool.name,
            args: parsed,
            result: res.isError ? { error: resultText } : resultText,
            actorId,
            timestamp: Date.now(),
          });
        }

        if (res.isError) {
          throw new Error(resultText);
        }

        return resultText;
      },
      {
        name: rawTool.name,
        description: rawTool.description,
        schema: cleanJsonSchema(rawTool.inputSchema) as any,
      },
    );

    langchainTools.push(wrapped);
  }

  // Append any caller-provided extra tools (e.g. Microsoft Learn MCP tools)
  for (const extra of extraTools) {
    if (!excludedSet.has(extra.name)) {
      langchainTools.push(extra);
    }
  }

  return langchainTools;
}
