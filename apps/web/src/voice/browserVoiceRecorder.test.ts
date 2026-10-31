import { describe, expect, it, vi } from "vite-plus/test";
import {
  VOICE_RECORDING_LIMIT_SECONDS,
  VoiceInputController,
} from "@t3tools/client-runtime/voice-input";
import { BrowserVoiceRecorder } from "./browserVoiceRecorder";
import { VOICE_AUDIO_MAX_BYTES } from "@t3tools/contracts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(
  options: {
    permission?: Promise<MediaStream>;
    supportedMimeTypes?: readonly string[];
    finalChunk?: Blob;
  } = {},
) {
  const track = Object.assign(new EventTarget(), { stop: vi.fn() });
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
  const instances: FakeMediaRecorder[] = [];
  class FakeMediaRecorder extends EventTarget {
    static isTypeSupported = (mimeType: string) =>
      options.supportedMimeTypes?.includes(mimeType) ?? true;
    state: RecordingState = "inactive";
    start = vi.fn(() => {
      this.state = "recording";
    });
    stop = vi.fn(() => {
      this.state = "inactive";
      queueMicrotask(() => {
        this.dispatchEvent(
          Object.assign(new Event("dataavailable"), {
            data: options.finalChunk ?? new Blob(["speech"], { type: "audio/webm" }),
          }),
        );
        this.dispatchEvent(new Event("stop"));
      });
    });
    constructor() {
      super();
      instances.push(this);
    }
  }
  const getUserMedia = vi.fn(() => options.permission ?? Promise.resolve(stream));
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  return { track, stream, instances, getUserMedia, [Symbol.dispose]: () => vi.unstubAllGlobals() };
}

describe("browser voice capture", () => {
  it("rejects concurrent stops rather than uploading truncated oversized audio", async () => {
    using harness = setup({ finalChunk: new Blob([new Uint8Array(VOICE_AUDIO_MAX_BYTES)]) });
    const onStatus = vi.fn();
    const recorder = new BrowserVoiceRecorder(onStatus);
    await recorder.prepareToRecordAsync();
    recorder.record({ forDuration: 300 });
    harness.instances[0]!.dispatchEvent(
      Object.assign(new Event("dataavailable"), {
        data: new Blob(["earlier speech"]),
      }),
    );
    const results = await Promise.allSettled([recorder.stop(), recorder.stop()]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    await expect(recorder.stop()).rejects.toThrow("Try a shorter recording");
    expect(recorder.uri).toBeNull();
    expect(harness.track.stop).toHaveBeenCalledTimes(1);
    expect(onStatus).not.toHaveBeenCalledWith(expect.objectContaining({ isFinished: true }));
    await expect(recorder.release()).resolves.toBeUndefined();
  });

  it.each(["audio/mp4", "audio/ogg;codecs=opus", "audio/webm"])(
    "negotiates %s when the preferred codec is unavailable",
    async (mimeType) => {
      using _harness = setup({ supportedMimeTypes: [mimeType] });
      const recorder = new BrowserVoiceRecorder(vi.fn());
      await recorder.prepareToRecordAsync();
      recorder.record({ forDuration: VOICE_RECORDING_LIMIT_SECONDS });
      await recorder.stop();
      try {
        expect((await (await fetch(recorder.uri!)).blob()).type).toBe(mimeType);
      } finally {
        recorder.deleteRecording(recorder.uri!);
        await recorder.release();
      }
    },
  );

  it("rejects unsupported codecs before asking for microphone access", async () => {
    using harness = setup({ supportedMimeTypes: [] });
    const recorder = new BrowserVoiceRecorder(vi.fn());
    await expect(recorder.prepareToRecordAsync()).rejects.toThrow("supported audio format");
    expect(harness.getUserMedia).not.toHaveBeenCalled();
  });

  it("rejects insecure origins before asking for microphone access", async () => {
    using harness = setup();
    vi.stubGlobal("isSecureContext", false);
    const recorder = new BrowserVoiceRecorder(vi.fn());
    await expect(recorder.prepareToRecordAsync()).rejects.toThrow("HTTPS or localhost");
    expect(harness.getUserMedia).not.toHaveBeenCalled();
  });

  it("waits for final audio after the native recorder becomes inactive", async () => {
    using harness = setup();
    const recorder = new BrowserVoiceRecorder(vi.fn());
    await recorder.prepareToRecordAsync();
    recorder.record({ forDuration: 300 });
    const native = harness.instances[0]!;
    native.state = "inactive";
    const releasing = recorder.release();
    expect(harness.track.stop).not.toHaveBeenCalled();
    native.dispatchEvent(
      Object.assign(new Event("dataavailable"), {
        data: new Blob(["last speech"], { type: "audio/webm" }),
      }),
    );
    native.dispatchEvent(new Event("stop"));
    await releasing;
    expect(await (await fetch(recorder.uri!)).text()).toBe("last speech");
    recorder.deleteRecording(recorder.uri!);
  });

  it("automatically stops at the recording limit and releases microphone tracks", async () => {
    using h = setup();
    vi.useFakeTimers();
    const onStatus = vi.fn();
    const recorder = new BrowserVoiceRecorder(onStatus);
    try {
      await recorder.prepareToRecordAsync();
      recorder.record({ forDuration: VOICE_RECORDING_LIMIT_SECONDS });
      await vi.advanceTimersByTimeAsync(300_000);
      expect(h.instances[0]!.state).toBe("inactive");
      expect(h.track.stop).toHaveBeenCalledTimes(1);
      expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ isFinished: true }));
    } finally {
      if (recorder.uri) recorder.deleteRecording(recorder.uri);
      await recorder.release();
      vi.useRealTimers();
    }
  });
  it("records one audio blob and stops the microphone before returning it", async () => {
    using h = setup();
    const onStatus = vi.fn();
    const recorder = new BrowserVoiceRecorder(onStatus);
    await recorder.prepareToRecordAsync();
    recorder.record({ forDuration: 300 });
    await Promise.all([recorder.stop(), recorder.stop()]);
    expect(h.instances[0]!.stop).toHaveBeenCalledTimes(1);
    expect(h.track.stop).toHaveBeenCalledTimes(1);
    expect(await (await fetch(recorder.uri!)).text()).toBe("speech");
    expect(onStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ isFinished: true, hasError: false }),
    );
    const uri = recorder.uri!;
    recorder.deleteRecording(uri);
    expect(recorder.uri).toBeNull();
    await expect(fetch(uri)).rejects.toThrow();
    await recorder.release();
  });

  it("cleans up a late microphone grant after cancellation without recording or transcribing", async () => {
    const permission = deferred<MediaStream>();
    const entered = deferred<void>();
    using h = setup({ permission: permission.promise });
    h.getUserMedia.mockImplementation(() => {
      entered.resolve(undefined);
      return permission.promise;
    });
    const commitDraft = vi.fn();
    const transcribe = vi.fn(async () => "should not be inserted");
    const recorder = new BrowserVoiceRecorder((status) => {
      void controller.handleRecorderStatus(status);
    });
    const controller = new VoiceInputController({
      recorder,
      getTranscriber: () => ({ prepare: async () => ({ locale: "en-US", transcribe }) }),
      requestPermission: async () => ({ granted: true, canAskAgain: true }),
      configureRecording: async () => {},
      releaseRecording: () => recorder.release(),
      deleteRecording: (uri) => recorder.deleteRecording(uri),
      readDraft: () => ({
        ownerKey: "draft",
        text: "keep this",
        selection: { start: 9, end: 9 },
        revision: 1,
      }),
      commitDraft,
      onStateChange: vi.fn(),
    });
    const starting = controller.start();
    await entered.promise;
    controller.cancel();
    permission.resolve(h.stream);
    await starting;
    expect(h.track.stop).toHaveBeenCalledTimes(1);
    expect(h.instances[0]!.start).not.toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled();
    expect(commitDraft).not.toHaveBeenCalled();
  });

  it("preserves the draft and releases the microphone when recording is cancelled", async () => {
    using h = setup();
    const released = deferred<void>();
    const commitDraft = vi.fn();
    const transcribe = vi.fn(async () => "unused");
    const recorder = new BrowserVoiceRecorder((status) => {
      void controller.handleRecorderStatus(status);
    });
    const controller = new VoiceInputController({
      recorder,
      getTranscriber: () => ({ prepare: async () => ({ locale: "en-US", transcribe }) }),
      requestPermission: async () => ({ granted: true, canAskAgain: true }),
      configureRecording: async () => {},
      releaseRecording: async () => {
        await recorder.release();
        released.resolve(undefined);
      },
      deleteRecording: (uri) => recorder.deleteRecording(uri),
      readDraft: () => ({
        ownerKey: "draft",
        text: "typed draft",
        selection: { start: 11, end: 11 },
        revision: 1,
      }),
      commitDraft,
      onStateChange: vi.fn(),
    });
    await controller.start();
    controller.cancel();
    await released.promise;
    expect(h.track.stop).toHaveBeenCalledTimes(1);
    expect(transcribe).not.toHaveBeenCalled();
    expect(commitDraft).not.toHaveBeenCalled();
    expect(recorder.uri).toBeNull();
  });

  it("reports microphone denial without creating a recorder", async () => {
    using h = setup();
    h.getUserMedia.mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    const recorder = new BrowserVoiceRecorder(vi.fn());
    await expect(recorder.prepareToRecordAsync()).rejects.toMatchObject({
      name: "NotAllowedError",
    });
    await recorder.release();
    expect(h.instances).toEqual([]);
  });
});
