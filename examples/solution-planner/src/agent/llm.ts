import { AzureChatOpenAI, ChatOpenAI } from "@langchain/openai";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { PlannerLanguage } from "./types.ts";

/**
 * Which model this app talks to, and how it guesses the user's language.
 *
 * The structured-output machinery this used to hold — the tool loop, the
 * provider schema sanitising, `invokeStructured` — moved to
 * `@collabnode/deepagents`, which is where the tools it filters are built. What
 * is left is genuinely this app's: its credentials, its deployment names, its
 * two languages.
 */

/**
 * Detect language from text input.
 */
export function detectLanguage(text: string, defaultLang: PlannerLanguage = "en"): PlannerLanguage {
  if (!text) return defaultLang;
  const spanishPattern = /\b(el|la|los|las|un|una|unos|unas|de|del|en|para|con|por|que|como|es|son|sistema|aplicacion|gestor|usuario|desarrollar|crear|tablero|arquitectura|servicio)\b/i;
  return spanishPattern.test(text) ? "es" : "en";
}

/**
 * Provider factories. Each returns null when its credentials are absent, so
 * `LLM_PROVIDER` can name one explicitly and auto-detection can walk the list.
 */
function makeGemini(): BaseChatModel | null {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) return null;
  return new ChatGoogleGenerativeAI({
    apiKey,
    model: process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
    temperature: 0.2,
  });
}

function makeAzure(): BaseChatModel | null {
  const azureKey = process.env.AZURE_OPENAI_API_KEY || process.env.AZURE_AI_FOUNDRY_KEY;
  const azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT || process.env.AZURE_AI_FOUNDRY_ENDPOINT;
  if (!azureKey || !azureEndpoint) return null;

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

  return new AzureChatOpenAI({
    model: deployment,
    azureOpenAIApiKey: azureKey,
    azureOpenAIEndpoint: cleanEndpoint,
    azureOpenAIApiDeploymentName: deployment,
    azureOpenAIApiVersion: process.env.AZURE_OPENAI_API_VERSION || "2024-08-01-preview",
  });
}

function makeOpenAI(): BaseChatModel | null {
  if (!process.env.OPENAI_API_KEY) return null;
  return new ChatOpenAI({
    model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
    temperature: 0.2,
  });
}

const PROVIDERS: Record<string, () => BaseChatModel | null> = {
  gemini: makeGemini,
  google: makeGemini,
  azure: makeAzure,
  openai: makeOpenAI,
};

/** Auto-detect order when LLM_PROVIDER is unset. */
const AUTO_DETECT_ORDER = [makeAzure, makeOpenAI, makeGemini];

/**
 * Create a chat model instance if API keys are present.
 *
 * `LLM_PROVIDER` (azure | openai | gemini) picks the provider outright — an
 * ambient key for another provider never overrides it. With it unset, the
 * providers are tried in AUTO_DETECT_ORDER.
 */
export function getChatModel(): BaseChatModel | null {
  const provider = process.env.LLM_PROVIDER?.trim().toLowerCase();
  if (provider) {
    const factory = PROVIDERS[provider];
    if (!factory) {
      console.warn(`Unknown LLM_PROVIDER "${provider}"; falling back to auto-detection.`);
    } else {
      const model = factory();
      if (model) return model;
      console.warn(`LLM_PROVIDER=${provider} but its credentials are missing; no model configured.`);
      return null;
    }
  }

  for (const factory of AUTO_DETECT_ORDER) {
    const model = factory();
    if (model) return model;
  }
  return null;
}

