import { strings } from "./i18n.ts";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export function loadDotEnv(): void {
  try {
    const text = readFileSync(join(here, "../.env"), "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const eq = trimmed.indexOf("=");
      if (eq < 1) {
        continue;
      }
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    /* no .env file */
  }
}

function firstEnv(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key];
    if (value && value.trim() && !value.includes("<resource>")) {
      return value.trim();
    }
  }
  return undefined;
}

export interface VoiceLiveConfig {
  /** `wss://<resource>.services.ai.azure.com/voice-live/realtime/calls` */
  callsUrl: string;
  apiVersion: string;
  model: string;
  voice: string;
  apiKey?: string;
  token?: string;
}

/**
 * Voice Live negotiates WebRTC over a WebSocket control channel at
 * `voice-live/realtime/calls` — note the `/calls` suffix, which is what
 * separates it from the plain WebSocket transport at `voice-live/realtime`.
 */
export function voiceLiveConfig(language?: string): VoiceLiveConfig | undefined {
  const endpoint = firstEnv(
    "AZURE_VOICE_LIVE_ENDPOINT",
    "AZURE_AI_ENDPOINT",
    "AZURE_OPENAI_ENDPOINT",
  );
  const apiKey = firstEnv("AZURE_VOICE_LIVE_API_KEY", "AZURE_AI_API_KEY", "AZURE_OPENAI_API_KEY");
  const token = firstEnv("AZURE_VOICE_LIVE_TOKEN");
  if (!endpoint || (!apiKey && !token)) {
    return undefined;
  }
  // gpt-realtime is the default because the azure-realtime preview leaks
  // harmony control tokens into tool-call names and arguments, which breaks
  // every graph write. See normalizeToolName / parseToolArgs.
  const model = firstEnv("AZURE_VOICE_LIVE_MODEL") ?? "gpt-realtime";
  return {
    callsUrl: callsUrl(endpoint),
    apiVersion: firstEnv("AZURE_VOICE_LIVE_API_VERSION") ?? "2026-01-01-preview",
    model,
    voice: firstEnv("AZURE_VOICE_LIVE_VOICE") ?? defaultVoice(model, language),
    apiKey,
    token,
  };
}

/**
 * The two model families take different voice catalogs, so the default has to
 * follow the model — an `azure-realtime` name like `ava` is not a valid
 * `azure-standard` voice, and vice versa. Only the `azure-standard` catalog is
 * per-locale, so that is the one the language moves; `azure-realtime` native
 * voices speak whatever the instructions tell them to.
 */
export function defaultVoice(model: string, language?: string): string {
  return model === "azure-realtime" ? "ava" : strings(language).speechVoice;
}

export function voiceLiveReady(): boolean {
  return voiceLiveConfig() !== undefined;
}

/** Accepts a bare resource host, an https:// endpoint, or a full wss:// calls URL. */
function callsUrl(endpoint: string): string {
  const withScheme = /^[a-z]+:\/\//i.test(endpoint) ? endpoint : `https://${endpoint}`;
  const url = new URL(withScheme);
  url.protocol = url.protocol === "http:" ? "ws:" : url.protocol === "https:" ? "wss:" : url.protocol;
  url.search = "";
  if (!url.pathname.includes("/voice-live/realtime")) {
    url.pathname = "/voice-live/realtime/calls";
  } else if (!url.pathname.endsWith("/calls")) {
    url.pathname = url.pathname.replace(/\/+$/, "") + "/calls";
  }
  return url.toString();
}

/**
 * The instructions the voice agent runs with, on top of the generated graph
 * contract. Voice output is spoken, so it has to stay short.
 */
export function voicePersona(): string {
  return [
    "You are Echo, a note-taking partner on a shared graph of notes.",
    "The user is talking to you out loud while other people edit the same notes in a browser.",
    "Dictation is messy: drop filler words, keep the speaker's own phrasing, and write clean markdown.",
    "Use the graph tools for every read and write — never invent node ids, and prefer updating an existing note over creating a near-duplicate.",
    "graph_search tolerates misheard spelling, so trust its top hit; when you update a note it found, pass that result's id rather than retyping the title.",
    "It also matches meaning, so ask it the user's actual question rather than guessing keywords; a hit marked match: 'vector' is about that subject but is probably not called that, so say what it is called before reading from it.",
    "When the user dictates note content, call upsert_node_Note with the full new body; the body property replaces what is there, so include the text you want to keep.",
    "Speak in one or two short sentences. Confirm what you changed. Never read a whole note back unless asked.",
  ].join(" ");
}

/**
 * The two hosted services this copy of the board runs against.
 *
 * Both are read once, at boot, and both throw rather than falling back: a board
 * that quietly degrades to Tinylicious and an in-process registry looks like it
 * works right up until the second replica disagrees with the first about what
 * exists.
 */

export interface AzureFluidConfig {
  tenantId: string;
  endpoint: string;
  key: string;
}

export function azureFluidConfig(): AzureFluidConfig {
  const tenantId = firstEnv("AZURE_FLUID_TENANT_ID");
  const endpoint = firstEnv("AZURE_FLUID_ENDPOINT");
  const key = firstEnv("AZURE_FLUID_KEY");
  if (!tenantId || !endpoint || !key) {
    throw new Error(
      "Azure Fluid Relay is not configured. Set AZURE_FLUID_TENANT_ID, AZURE_FLUID_ENDPOINT, " +
        "and AZURE_FLUID_KEY in examples/voice-board-azure/.env (see .env.example).",
    );
  }
  return { tenantId, endpoint, key };
}

/**
 * `rediss://` — Azure Managed Redis speaks TLS on 10000 and Azure Cache for
 * Redis on 6380; neither accepts a plaintext connection. The access key is the
 * password, with no username in front of it.
 */
export function redisUrl(): string {
  const url = firstEnv("REDIS_URL");
  if (!url) {
    throw new Error(
      "REDIS_URL is not set. Use rediss://:<access-key>@<host>:10000 for Azure Managed Redis " +
        "(see examples/voice-board-azure/.env.example).",
    );
  }
  if (url.startsWith("redis://") && !url.includes("127.0.0.1") && !url.includes("localhost")) {
    throw new Error(
      `REDIS_URL uses plaintext redis:// against a remote host. Azure requires TLS: use rediss://`,
    );
  }
  return url;
}

/** Key namespace, so two deployments can share one Redis without colliding. */
export function redisPrefix(): string {
  return firstEnv("REDIS_PREFIX") ?? "voice-board";
}
