import { tool as createLangChainTool, type StructuredToolInterface } from "@langchain/core/tools";
import { buildTools, toolJsonSchema, type BoundTool } from "@collabnode/mcp";
import type { CollabSession } from "@collabnode/runtime";
import {
  toolListAllowsAll,
  type AgentDef,
  type GraphSchema,
  type ToolsPolicyDef,
  type ViewDef,
} from "@collabnode/schema";
import { toProviderJsonSchema } from "./structured.js";
import type { ToolCallEvent } from "./types.js";

export interface BindAgentToolsOptions {
  session: CollabSession;
  schema: GraphSchema;
  toolsPolicy?: ToolsPolicyDef;
  /** Named graph slices from the workspace type, exposed as `view_<name>` tools. */
  views?: Record<string, ViewDef>;
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

  // `*` is the documented wildcard for "every tool that survived the policy", so
  // it has to be honoured here too — a literal `includes("*")` test would drop
  // every tool for an agent that spelled its allowlist out as `tools: ["*"]`.
  if (!toolListAllowsAll(agentDef?.tools)) {
    return agentDef!.tools!.includes(tool.name);
  }

  return true;
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
    views,
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

  // Generate all tools supported by the schema for this session and role
  const rawTools = buildTools(boundSession.schema, boundSession, {
    language,
    graphKind: "memory",
    policy: toolsPolicy,
    views,
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
        // `toolJsonSchema` puts the YAML `required: true` flags back on upserts;
        // `toProviderJsonSchema` then strips what Gemini/Azure reject.
        schema: toProviderJsonSchema(toolJsonSchema(rawTool, schema)),
        metadata: { readOnly: rawTool.annotations?.readOnlyHint === true },
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
