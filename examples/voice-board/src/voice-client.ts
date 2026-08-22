/**
 * Browser half of the Voice Live WebRTC call.
 *
 * The negotiation is deliberately split: this file gathers ICE and produces an
 * SDP offer, but posts it to our own server, which holds the credentials and
 * the WebSocket control channel. Once the answer comes back, microphone audio
 * and the model's voice flow directly between this tab and Azure over RTP —
 * no audio is relayed through the Node process.
 */

export type VoiceState = "idle" | "connecting" | "listening" | "thinking" | "speaking" | "error";

export interface VoiceEvents {
  onState(state: VoiceState, detail?: string): void;
  /**
   * Running text for the turn in progress. `id` identifies the turn, so the UI
   * can rewrite one bubble in place instead of appending a new one per delta.
   */
  onPartial(role: "user" | "agent", id: string, text: string): void;
  /** The turn is finished. Same `id` as its partials — replace, do not append. */
  onFinal(role: "user" | "agent", id: string, text: string): void;
  /**
   * Microphone loudness, 0–1, roughly every animation frame. Drives the ring
   * around the mic button: a caption saying "Listening" is a promise, a ring
   * that moves with your voice is proof.
   */
  onLevel?(level: number): void;
}

export interface VoiceHandle {
  stop(): Promise<void>;
}

const ICE_TIMEOUT_MS = 3000;

export async function startVoice(
  events: VoiceEvents,
  options?: { workspaceId?: string; language?: string },
): Promise<VoiceHandle> {
  events.onState("connecting");

  const pc = new RTCPeerConnection();
  let stream: MediaStream | undefined;
  let audio: HTMLAudioElement | undefined;
  let callId: string | undefined;
  let stopped = false;
  let stopMeter: (() => void) | undefined;

  const cleanup = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    stopped = true;
    stopMeter?.();
    stream?.getTracks().forEach((track) => track.stop());
    pc.close();
    audio?.remove();
    if (callId) {
      const hangupUrl = options?.workspaceId
        ? `/api/voice/hangup?workspace=${encodeURIComponent(options.workspaceId)}`
        : "/api/voice/hangup";
      await fetch(hangupUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callId, workspaceId: options?.workspaceId }),
      }).catch(() => undefined);
    }
    events.onState("idle");
  };

  try {
    // Remote audio: the model's spoken reply arrives as an RTP track.
    audio = document.createElement("audio");
    audio.autoplay = true;
    document.body.append(audio);
    pc.ontrack = (event) => {
      audio!.srcObject = event.streams[0] ?? null;
    };

    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) {
      pc.addTrack(track, stream);
    }
    if (events.onLevel) {
      stopMeter = meterLevel(stream, events.onLevel);
    }

    // Non-audio events (VAD, transcripts) ride this data channel rather than
    // the control WebSocket, which keeps them at RTP latency.
    const partials = new Map<string, string>();
    const channel = pc.createDataChannel("voice-live-events");
    channel.onmessage = (event) => {
      handleEvent(String(event.data), events, partials);
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        events.onState("listening");
      } else if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        events.onState("error", `WebRTC ${pc.connectionState}`);
        void cleanup();
      }
    };

    await pc.setLocalDescription(await pc.createOffer());
    await waitForIce(pc);

    const offerUrl = options?.workspaceId
      ? `/api/voice/offer?workspace=${encodeURIComponent(options.workspaceId)}`
      : "/api/voice/offer";
    const response = await fetch(offerUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sdp: pc.localDescription?.sdp,
        workspaceId: options?.workspaceId,
        language: options?.language,
      }),
    });
    const body = (await response.json()) as { sdpAnswer?: string; callId?: string; error?: string };
    if (!response.ok || !body.sdpAnswer) {
      throw new Error(body.error ?? `offer rejected (${response.status})`);
    }

    callId = body.callId;

    // Audio starts flowing the moment the remote description is applied.
    await pc.setRemoteDescription({ type: "answer", sdp: body.sdpAnswer });
  } catch (error) {
    events.onState("error", error instanceof Error ? error.message : String(error));
    await cleanup();
    throw error;
  }

  return { stop: cleanup };
}

function handleEvent(raw: string, events: VoiceEvents, partials: Map<string, string>): void {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }
  const type = String(message.type ?? "");
  // The turn id. One bubble per item, whichever events describe it.
  const id = String(message.item_id ?? message.response_id ?? "current");
  const delta = typeof message.delta === "string" ? message.delta : "";
  const transcript = typeof message.transcript === "string" ? message.transcript : "";

  switch (type) {
    case "input_audio_buffer.speech_started":
      events.onState("listening");
      partials.delete(`user:${id}`);
      break;
    case "input_audio_buffer.speech_stopped":
      events.onState("thinking");
      break;

    case "conversation.item.input_audio_transcription.delta": {
      const text = (partials.get(`user:${id}`) ?? "") + delta;
      partials.set(`user:${id}`, text);
      events.onPartial("user", id, text);
      break;
    }
    case "conversation.item.input_audio_transcription.completed":
      partials.delete(`user:${id}`);
      events.onFinal("user", id, transcript || "(unintelligible)");
      break;

    case "response.created":
      events.onState("thinking");
      break;
    // A spoken turn streams as `audio_transcript`; a text-only one streams as
    // `text`. Buffer them separately so an item that emits both does not
    // concatenate one into the other, but render both to the same bubble.
    case "response.audio_transcript.delta":
    case "response.text.delta": {
      const channel = type.startsWith("response.text") ? "text" : "audio";
      const bufferKey = `agent:${channel}:${id}`;
      const text = (partials.get(bufferKey) ?? "") + delta;
      partials.set(bufferKey, text);
      events.onState("speaking");
      events.onPartial("agent", id, text);
      break;
    }
    case "response.audio_transcript.done":
    case "response.text.done": {
      const channel = type.startsWith("response.text") ? "text" : "audio";
      const bufferKey = `agent:${channel}:${id}`;
      const text =
        transcript || (typeof message.text === "string" ? message.text : "") || partials.get(bufferKey) || "";
      partials.delete(bufferKey);
      if (text) {
        events.onFinal("agent", id, text);
      }
      break;
    }
    case "response.done":
      events.onState("listening");
      break;
    default:
      break;
  }
}

/**
 * RMS loudness of the microphone, reported every frame until torn down. The
 * numbers are only ever used to size a ring, so an approximate curve beats an
 * accurate one: the square root lifts quiet speech into visible movement.
 */
function meterLevel(stream: MediaStream, onLevel: (level: number) => void): () => void {
  const context = new AudioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.7;
  context.createMediaStreamSource(stream).connect(analyser);

  const samples = new Float32Array(analyser.fftSize);
  let frame = 0;

  const tick = (): void => {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) {
      sum += sample * sample;
    }
    const rms = Math.sqrt(sum / samples.length);
    onLevel(Math.min(1, Math.sqrt(rms) * 2.5));
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);

  return () => {
    cancelAnimationFrame(frame);
    void context.close();
  };
}

/**
 * Voice Live wants a complete offer, so wait for ICE gathering rather than
 * trickling candidates. The timeout keeps a slow STUN server from hanging the
 * call — a partial candidate list still connects on a local network.
 */
function waitForIce(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    };
    const onChange = (): void => {
      if (pc.iceGatheringState === "complete") {
        done();
      }
    };
    const timer = setTimeout(done, ICE_TIMEOUT_MS);
    pc.addEventListener("icegatheringstatechange", onChange);
  });
}
