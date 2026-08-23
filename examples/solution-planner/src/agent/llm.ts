import { AzureChatOpenAI, ChatOpenAI } from "@langchain/openai";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { PlannerLanguage } from "./types.ts";

/**
 * Detect language from text input.
 */
export function detectLanguage(text: string, defaultLang: PlannerLanguage = "en"): PlannerLanguage {
  if (!text) return defaultLang;
  const spanishPattern = /\b(el|la|los|las|un|una|unos|unas|de|del|en|para|con|por|que|como|es|son|sistema|aplicacion|gestor|usuario|desarrollar|crear|tablero|arquitectura|servicio)\b/i;
  return spanishPattern.test(text) ? "es" : "en";
}

/**
 * Create a chat model instance if API keys are present.
 * Supports Azure AI Foundry, Azure OpenAI, standard OpenAI, and Google Gemini.
 */
export function getChatModel(): BaseChatModel | null {
  // 1. Azure OpenAI / Azure AI Foundry Endpoints
  const azureKey = process.env.AZURE_OPENAI_API_KEY || process.env.AZURE_AI_FOUNDRY_KEY;
  const azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT || process.env.AZURE_AI_FOUNDRY_ENDPOINT;

  if (azureKey && azureEndpoint) {
    let cleanEndpoint = azureEndpoint;
    if (cleanEndpoint.includes("/api/projects/")) {
      const parsed = new URL(cleanEndpoint);
      cleanEndpoint = `${parsed.protocol}//${parsed.host}`;
    }

    const deployment =
      process.env.AZURE_OPENAI_DEPLOYMENT_NAME ||
      process.env.AZURE_AI_FOUNDRY_DEPLOYMENT ||
      process.env.AZURE_OPENAI_MODEL ||
      "gpt-5.6-luna";

    const apiVersion = process.env.AZURE_OPENAI_API_VERSION || "2024-08-01-preview";

    return new AzureChatOpenAI({
      azureOpenAIApiKey: azureKey,
      azureOpenAIEndpoint: cleanEndpoint,
      azureOpenAIApiDeploymentName: deployment,
      azureOpenAIApiVersion: apiVersion,
    });
  }

  // 2. Standard OpenAI
  if (process.env.OPENAI_API_KEY) {
    return new ChatOpenAI({
      modelName: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
      temperature: 0.2,
    });
  }

  // 3. Google Gemini
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
    return new ChatGoogleGenerativeAI({
      model: process.env.GEMINI_MODEL ?? "gemini-1.5-flash",
      temperature: 0.2,
    });
  }

  return null;
}
