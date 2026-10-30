import { VOICE_AUDIO_MAX_BYTES } from "@t3tools/contracts";
import {
  VoiceTranscriptionError,
  type VoiceRecorder,
  type VoiceRecorderStatus,
} from "@t3tools/client-runtime/voice-input";

const MIME_TYPES = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm"];

/** Records on the client machine, even when its selected T3 environment is remote. */
export class BrowserVoiceRecorder implements VoiceRecorder {
  uri: string | null = null;
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private bytes = 0;
  private recordingError: VoiceTranscriptionError | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopping: Promise<void> | null = null;
  private finishStop: (() => void) | null = null;
  private mimeType = "audio/webm";
  private readonly trackListeners: Array<{ track: MediaStreamTrack; ended: () => void }> = [];

  constructor(private readonly onStatus: (status: VoiceRecorderStatus) => void) {}

  async prepareToRecordAsync(): Promise<void> {
    if (
      !globalThis.isSecureContext ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    ) {
      throw new Error("Microphone recording requires HTTPS or localhost and a supported browser.");
    }
    const mimeType = MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new Error("This browser cannot record a supported audio format.");
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.mimeType = mimeType;
    this.recorder = new MediaRecorder(this.stream, { mimeType, audioBitsPerSecond: 64_000 });
    this.chunks = [];
    this.bytes = 0;
    this.recordingError = null;
    this.stopping = null;
    this.recorder.addEventListener("dataavailable", ({ data }) => {
      this.bytes += data.size;
      if (this.bytes > VOICE_AUDIO_MAX_BYTES) {
        this.recordingError ??= new VoiceTranscriptionError(
          "transcription-failed",
          "This recording is too large. Try a shorter recording.",
        );
        this.onStatus({
          isFinished: false,
          hasError: true,
          error: this.recordingError.message,
          url: null,
        });
        return;
      }
      if (data.size > 0) this.chunks.push(data);
    });
    this.recorder.addEventListener("error", () =>
      this.onStatus({
        isFinished: false,
        hasError: true,
        error: "The microphone recording failed. Try again.",
        url: null,
      }),
    );
    this.recorder.addEventListener("stop", () => {
      this.clearTimer();
      this.releaseTracks();
      if (this.recordingError) {
        this.chunks = [];
        this.finishStop?.();
        this.finishStop = null;
        return;
      }
      const blob = new Blob(this.chunks, { type: this.mimeType });
      this.chunks = [];
      this.uri = URL.createObjectURL(blob);
      this.finishStop?.();
      this.finishStop = null;
      this.onStatus({ isFinished: true, hasError: false, error: null, url: this.uri });
    });
    for (const track of this.stream.getAudioTracks()) {
      const ended = () =>
        this.onStatus({
          isFinished: false,
          hasError: true,
          error: "The microphone was disconnected. Reconnect it and try again.",
          url: null,
        });
      track.addEventListener("ended", ended);
      this.trackListeners.push({ track, ended });
    }
  }

  record({ forDuration }: { readonly forDuration: number }): void {
    if (!this.recorder) throw new Error("The recorder has not been prepared.");
    this.recorder.start(1_000);
    this.timer = setTimeout(() => void this.stop().catch(() => {}), forDuration * 1_000);
  }

  async stop(): Promise<void> {
    if (this.stopping) {
      await this.stopping;
      if (this.recordingError) throw this.recordingError;
      return;
    }
    this.clearTimer();
    if (!this.recorder || this.recorder.state === "inactive") {
      this.releaseTracks();
      if (this.recordingError) throw this.recordingError;
      return;
    }
    this.stopping = new Promise<void>((resolve) => {
      this.finishStop = resolve;
    });
    this.recorder.stop();
    await this.stopping;
    if (this.recordingError) throw this.recordingError;
  }

  async release(): Promise<void> {
    try {
      await this.stop();
    } catch {}
    this.releaseTracks();
    this.recorder = null;
    this.chunks = [];
  }

  deleteRecording(uri: string): void {
    URL.revokeObjectURL(uri);
    if (this.uri === uri) this.uri = null;
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private releaseTracks(): void {
    for (const { track, ended } of this.trackListeners) track.removeEventListener("ended", ended);
    this.trackListeners.length = 0;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
  }
}

export async function readRecording(uri: string, signal: AbortSignal) {
  const response = await fetch(uri, { signal });
  const blob = await response.blob();
  if (blob.size === 0 || blob.size > VOICE_AUDIO_MAX_BYTES)
    throw new Error("This recording is empty or too large. Try again.");
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    const abort = () => reader.abort();
    const cleanup = () => signal.removeEventListener("abort", abort);
    reader.addEventListener(
      "load",
      () => {
        cleanup();
        resolve(String(reader.result));
      },
      { once: true },
    );
    reader.addEventListener(
      "error",
      () => {
        cleanup();
        reject(new Error("Could not read the recording."));
      },
      { once: true },
    );
    reader.addEventListener(
      "abort",
      () => {
        cleanup();
        reject(new DOMException("Recording cancelled.", "AbortError"));
      },
      { once: true },
    );
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      cleanup();
      reject(new DOMException("Recording cancelled.", "AbortError"));
      return;
    }
    reader.readAsDataURL(blob);
  });
  const mimeType = blob.type.split(";")[0];
  if (
    mimeType !== "audio/webm" &&
    mimeType !== "audio/mp4" &&
    mimeType !== "audio/ogg" &&
    mimeType !== "audio/wav"
  )
    throw new Error("Unsupported recording format.");
  return { audioBase64: dataUrl.slice(dataUrl.indexOf(",") + 1), mimeType };
}
