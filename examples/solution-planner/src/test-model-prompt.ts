import { getChatModel } from "./agent/llm.ts";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { config as loadDotEnv } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
loadDotEnv({ path: join(root, ".env") });

async function testModelDirectly() {
  console.log("▶ Testing real Azure Foundry Model with Manager Prompt...");
  const model = getChatModel();
  if (!model) throw new Error("Model is null");

  const prompt = `You are an AI Product Manager. Analyze this product description and produce:
1. 2-3 Business Epics with 2 Features each.
2. 1-2 Business Risks with severity and mitigation.
3. If iteration 1 === 1, raise ONE critical assumption (e.g. cloud provider, auth provider, storage tier) for human validation.

Description: "Collaborative Notion-style document editor with offline sync & AI summaries"

Respond in JSON with this structure:
{
  "epics": [{"title": "...", "description": "...", "priority": "high", "features": [{"title": "...", "description": "..."}]}],
  "businessRisks": [{"title": "...", "description": "...", "severity": "medium", "mitigation": "..."}],
  "assumption": {"title": "...", "description": "..."}
}`;

  const res = await model.invoke([
    new SystemMessage("Respond only with valid JSON."),
    new HumanMessage(prompt),
  ]);

  console.log("✓ Raw response from gpt-5.6-luna:\n", res.content);
}

testModelDirectly().catch(console.error);
