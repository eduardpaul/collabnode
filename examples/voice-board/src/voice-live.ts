import { WebSocket } from "ws";
import type { VoiceLiveConfig } from "./env.ts";
import { parseToolArgs, type VoiceToolset } from "./voice-tools.ts";

const SDP_TIMEOUT_MS = 30_000;

export interface CallLog {
  kind: "tool" | "info" | "error";
  text: string;
  tool?: string;
  at: number;
}

export interface StartCallOptions {
  config: VoiceLiveConfig;
  toolset: VoiceToolset;
  instructions: string;
  /** ISO-639-1 code, so transcription stops guessing which language it heard. */
  language?: string;
  sdpOffer: string;
  onLog(entry: CallLog): void;
}

/**
 * One Voice Live WebRTC call.
 *
 * The browser owns the RTCPeerConnection — microphone audio and the model's
 * spoken reply travel peer-to-peer over RTP, and transcripts arrive on the
 * `voice-live-events` data channel. This class owns the *other* channel: the
 * WebSocket that negotiates SDP and then carries tool calls, which is exactly
 * why it lives on the server. The API key never reaches the browser, and every
 * graph write goes through the same CollabSession the HTTP and MCP paths use.
 */
export class VoiceCall {
  readonly id: string;
  #ws: WebSocket;
  #toolset: VoiceToolset;
  #onLog: (entry: CallLog) => void;
  #closed = false;
  /** Serializes tool calls so two graph writes never interleave. */
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(
    id: string,
    ws: WebSocket,
    toolset: VoiceToolset,
    onLog: (entry: CallLog) => void,
  ) {
    this.id = id;
    this.#ws = ws;
    this.#toolset = toolset;
    this.#onLog = onLog;
  }

  static async start(options: StartCallOptions): Promise<{ call: VoiceCall; sdpAnswer: string }> {
    const ws = await openControlChannel(options.config);
    const answer = await new Promise<{ sdp: string; callId: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Voice Live did not answer the SDP offer within 30s"));
      }, SDP_TIMEOUT_MS);

      const onMessage = (data: unknown) => {
        const message = decode(data);
        if (!message) {
          return;
        }
        if (message.type === "rtc.call.sdp.created" && typeof message.sdp_answer === "string") {
          clearTimeout(timer);
          ws.off("message", onMessage);
          resolve({
            sdp: message.sdp_answer,
            callId: typeof message.rtc_call_id === "string" ? message.rtc_call_id : "call",
          });
        } else if (message.type === "rtc.call.error" || message.type === "error") {
          clearTimeout(timer);
          ws.off("message", onMessage);
          reject(new Error(errorText(message)));
        }
      };

      ws.on("message", onMessage);
      ws.once("close", () => {
        clearTimeout(timer);
        reject(new Error("Voice Live closed the control channel during negotiation"));
      });

      // Session config rides along with the offer, so the very first spoken
      // turn already knows the graph contract and the tool catalog.
      ws.send(
        JSON.stringify({
          type: "rtc.call.sdp.create",
          sdp_offer: options.sdpOffer,
          session: sessionConfig(
            options.config,
            options.instructions,
            options.toolset,
            options.language,
          ),
        }),
      );
    }).catch((error: unknown) => {
      ws.close();
      throw error;
    });

    const call = new VoiceCall(answer.callId, ws, options.toolset, options.onLog);
    call.#listen();
    return { call, sdpAnswer: answer.sdp };
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#ws.close();
  }

  #listen(): void {
    this.#ws.on("message", (data) => {
      const message = decode(data);
      if (!message) {
        return;
      }
      switch (message.type) {
        // Tool calls are routed to the control channel precisely so a backend
        // can run them. Everything else (VAD, transcripts) goes straight to the
        // browser on the data channel and never touches this process.
        case "response.function_call_arguments.done":
          this.#dispatch(message);
          break;
        case "rtc.call.error":
        case "error":
          this.#onLog({ kind: "error", text: errorText(message), at: Date.now() });
          break;
        case "session.updated":
          this.#onLog({ kind: "info", text: "Voice Live session ready", at: Date.now() });
          break;
        default:
          break;
      }
    });
    this.#ws.on("close", () => {
      this.#closed = true;
      this.#onLog({ kind: "info", text: "Control channel closed", at: Date.now() });
    });
    this.#ws.on("error", (error: Error) => {
      this.#onLog({ kind: "error", text: error.message, at: Date.now() });
    });
  }

  #dispatch(message: Record<string, unknown>): void {
    const name = typeof message.name === "string" ? message.name : undefined;
    const callId = typeof message.call_id === "string" ? message.call_id : undefined;
    if (!name || !callId) {
      return;
    }
    const args = parseToolArgs(message.arguments);
    if (process.env.VOICE_DEBUG) {
      console.log("[voice] call", JSON.stringify({ name, raw: message.arguments, parsed: args }));
    }
    this.#queue = this.#queue.then(async () => {
      let output: string;
      try {
        output = await this.#toolset.call(name, args);
        this.#onLog({ kind: "tool", tool: name, text: summarize(name, args), at: Date.now() });
      } catch (error: unknown) {
        output = JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
        this.#onLog({ kind: "error", tool: name, text: `${name} failed`, at: Date.now() });
      }
      if (this.#closed) {
        return;
      }
      // Hand the result back, then ask for the spoken follow-up.
      this.#send({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: callId, output },
      });
      this.#send({ type: "response.create" });
    });
  }

  #send(payload: unknown): void {
    if (this.#ws.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify(payload));
    }
  }
}

function sessionConfig(
  config: VoiceLiveConfig,
  instructions: string,
  toolset: VoiceToolset,
  language?: string,
): Record<string, unknown> {
  return {
    modalities: ["text", "audio"],
    instructions,
    voice: voiceConfig(config),
    // Azure semantic VAD reads meaning rather than volume, so dictating a note
    // with pauses in it does not end the turn halfway through a sentence.
    turn_detection: {
      type: "azure_semantic_vad",
      threshold: 0.5,
      prefix_padding_ms: 300,
      silence_duration_ms: 500,
      remove_filler_words: true,
    },
    input_audio_noise_reduction: { type: "azure_deep_noise_suppression" },
    input_audio_echo_cancellation: { type: "server_echo_cancellation" },
    // Without this the service never emits
    // `conversation.item.input_audio_transcription.*`, so the panel shows the
    // agent's side of the conversation but never the speaker's own words.
    // Pinning the language matters more than it looks: left to guess, whisper
    // reads short Spanish utterances as Italian or Portuguese often enough that
    // the transcript panel and the model's own context disagree with the caller.
    input_audio_transcription: language
      ? { model: "whisper-1", language }
      : { model: "whisper-1" },
    tools: toolset.definitions,
    tool_choice: "auto",
  };
}

/** The `azure-realtime` model takes native voice names; other models take Azure TTS names. */
function voiceConfig(config: VoiceLiveConfig): Record<string, unknown> {
  return config.model === "azure-realtime"
    ? { type: "azure-realtime-native", name: config.voice }
    : { type: "azure-standard", name: config.voice };
}

async function openControlChannel(config: VoiceLiveConfig): Promise<WebSocket> {
  const url = new URL(config.callsUrl);
  url.searchParams.set("api-version", config.apiVersion);
  url.searchParams.set("model", config.model);

  const headers: Record<string, string> = config.apiKey
    ? { "api-key": config.apiKey }
    : { authorization: `Bearer ${config.token ?? ""}` };

  const ws = new WebSocket(url, { headers });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Voice Live control channel timed out")), 10_000);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      reject(new Error(`Voice Live rejected the connection (${res.statusCode})`));
    });
    ws.once("error", (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return ws;
}

function decode(data: unknown): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(String(data));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function errorText(message: Record<string, unknown>): string {
  const error = message.error;
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return `Voice Live error (${String(message.type)})`;
}

/** A short, speakable-free line for the activity feed. */
function summarize(name: string, args: Record<string, unknown>): string {
  const label = args.title ?? args.name ?? args.q ?? args.id;
  return typeof label === "string" && label ? `${name} — ${label}` : name;
}
