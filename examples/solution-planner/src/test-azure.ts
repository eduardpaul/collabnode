import { AzureChatOpenAI, ChatOpenAI } from "@langchain/openai";
import { HumanMessage } from "@langchain/core/messages";
import { config as loadDotEnv } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
loadDotEnv({ path: join(root, ".env") });

async function testLangChain() {
  console.log("▶ Testing Azure OpenAI / Foundry integration in LangChain...");

  const key = process.env.AZURE_OPENAI_API_KEY || process.env.AZURE_AI_FOUNDRY_KEY || process.env.OPENAI_API_KEY;
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT || process.env.AZURE_AI_FOUNDRY_ENDPOINT;
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT_NAME || process.env.AZURE_OPENAI_MODEL || "gpt-5.6-luna";

  console.log("Configuration:", {
    endpoint,
    deployment,
    hasKey: Boolean(key),
  });

  if (!key || !endpoint) {
    throw new Error("Missing AZURE_OPENAI_API_KEY or AZURE_OPENAI_ENDPOINT in .env");
  }

  // Normalize endpoint
  let azureEndpoint = endpoint;
  if (azureEndpoint.includes("/api/projects/")) {
    const parsed = new URL(azureEndpoint);
    azureEndpoint = `${parsed.protocol}//${parsed.host}`;
  }

  try {
    console.log("Invoking AzureChatOpenAI with endpoint:", azureEndpoint);
    const azureModel = new AzureChatOpenAI({
      azureOpenAIApiKey: key,
      azureOpenAIEndpoint: azureEndpoint,
      azureOpenAIApiDeploymentName: deployment,
      azureOpenAIApiVersion: process.env.AZURE_OPENAI_API_VERSION || "2024-08-01-preview",
    });

    const res = await azureModel.invoke([
      new HumanMessage("Respond concisely with: 'Azure OpenAI Foundry model connected successfully!'"),
    ]);

    console.log("✓ Model response:", res.content);
    console.log("🎉 Azure AI Foundry connection verified!");
  } catch (err) {
    console.error("AzureChatOpenAI failed, trying Foundry models client...", err);

    const foundryModel = new ChatOpenAI({
      apiKey: key,
      model: deployment,
      configuration: {
        baseURL: `${azureEndpoint}/models`,
        defaultHeaders: { "api-key": key },
      },
      temperature: 0.2,
    });

    const res2 = await foundryModel.invoke([
      new HumanMessage("Respond with: 'Foundry ChatOpenAI connected successfully!'"),
    ]);
    console.log("✓ Foundry ChatOpenAI response:", res2.content);
  }
}

testLangChain().catch((e) => {
  console.error("Test failed:", e);
  process.exit(1);
});
