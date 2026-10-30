import { describe, expect, it, vi } from "vite-plus/test";
import { VoiceInputController } from "@t3tools/client-runtime/voice-input";
import { BrowserVoiceRecorder } from "./browserVoiceRecorder";
import { VOICE_AUDIO_MAX_BYTES } from "@t3tools/contracts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(options: { permission?: Promise<MediaStream>; finalChunk?: Blob } = {}) {
  const track = Object.assign(new EventTarget(), { stop: vi.fn() });
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
  const instances: FakeMediaRecorder[] = [];
  class FakeMediaRecorder extends EventTarget {
    static isTypeSupported = () => true;
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
  it("rejects concurrent stops when the final chunk exceeds the size limit", async () => {
    using h = setup({ finalChunk: new Blob([new Uint8Array(VOICE_AUDIO_MAX_BYTES)]) });
    const onStatus = vi.fn();
    const recorder = new BrowserVoiceRecorder(onStatus);
    await recorder.prepareToRecordAsync();
    recorder.record({ forDuration: 300 });
    h.instances[0]!.dispatchEvent(
      Object.assign(new Event("dataavailable"), { data: new Blob(["earlier speech"]) }),
    );
    const results = await Promise.allSettled([recorder.stop(), recorder.stop()]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    await expect(recorder.stop()).rejects.toThrow("Try a shorter recording");
    expect(recorder.uri).toBeNull();
    expect(h.track.stop).toHaveBeenCalledTimes(1);
    expect(onStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ hasError: true, isFinished: false, url: null }),
    );
    expect(onStatus).not.toHaveBeenCalledWith(expect.objectContaining({ isFinished: true }));
    await expect(recorder.release()).resolves.toBeUndefined();
  });

  it("cleans up an oversized final chunk at the automatic duration stop", async () => {
    using h = setup({ finalChunk: new Blob([new Uint8Array(VOICE_AUDIO_MAX_BYTES + 1)]) });
    vi.useFakeTimers();
    const recorder = new BrowserVoiceRecorder(vi.fn());
    try {
      await recorder.prepareToRecordAsync();
      recorder.record({ forDuration: 1 });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(recorder.uri).toBeNull();
      expect(h.track.stop).toHaveBeenCalledTimes(1);
      await expect(recorder.stop()).rejects.toThrow("Try a shorter recording");
    } finally {
      await recorder.release();
      vi.useRealTimers();
    }
  });

  it("automatically stops at the recording limit and releases microphone tracks", async () => {
    using h = setup();
    vi.useFakeTimers();
    const onStatus = vi.fn();
    const recorder = new BrowserVoiceRecorder(onStatus);
    try {
      await recorder.prepareToRecordAsync();
      recorder.record({ forDuration: 300 });
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
