import { useRef, useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { EnvironmentId, VOICE_AUDIO_MAX_BYTES, type ServerProvider } from "@t3tools/contracts";
import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";
import { render, stubGlobal } from "../../test/render";
import {
  ComposerVoiceControls,
  ComposerVoiceStatus,
} from "../components/chat/ComposerVoiceControls";
import { composerVoiceOwnerKey } from "./availability";
import { useStableCallback } from "../hooks/useStableCallback";
import { useComposerVoiceInput } from "./useComposerVoiceInput";

const backend = vi.hoisted(() => ({ transcribe: vi.fn() }));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: (atom: string) =>
    atom === "config"
      ? {
          environment: { capabilities: { voiceTranscription: true } },
          settings: { codexVoiceInputEnabled: true },
        }
      : true,
}));
vi.mock("../state/server", () => ({ serverEnvironment: { configValueAtom: () => "config" } }));
vi.mock("../state/voiceTranscription", () => ({
  transcribeVoice: { permissionAtom: () => "permission" },
  voiceTranscriptionStatus: () => "status",
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => backend.transcribe }));
vi.mock("../state/query", () => ({
  useEnvironmentQuery: () => ({ data: { configured: true }, isPending: false, error: null }),
}));

function setup(finalChunk?: Blob) {
  backend.transcribe.mockReset();
  let complete!: (result: unknown) => void;
  let fail!: (error: Error) => void;
  backend.transcribe.mockReturnValue(
    new Promise((resolve, reject) => {
      complete = resolve;
      fail = reject;
    }),
  );
  const track = Object.assign(new EventTarget(), { stop: vi.fn() });
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  class Recorder extends EventTarget {
    static isTypeSupported = () => true;
    state: RecordingState = "inactive";
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      queueMicrotask(() => {
        this.dispatchEvent(
          Object.assign(new Event("dataavailable"), {
            data: finalChunk ?? new Blob(["test speech"], { type: "audio/webm" }),
          }),
        );
        this.dispatchEvent(new Event("stop"));
      });
    }
  }
  return { Recorder, stream, track, complete, fail };
}

function Composer({ ownerKey = "test:thread" }: { ownerKey?: string }) {
  const [text, setText] = useState("");
  const textRef = useRef(text);
  const [sent, setSent] = useState<string[]>([]);
  const [state, onStateChange] = useState<VoiceInputState>({
    phase: "idle",
    error: null,
    errorAction: null,
  });
  const voice = useComposerVoiceInput({
    state,
    onStateChange,
    ownerKey,
    text,
    available: true,
    environmentId: EnvironmentId.make("test"),
    provider: {
      driver: "codex",
      enabled: true,
      installed: true,
      status: "ready",
      auth: { status: "authenticated" },
    } as ServerProvider,
    readDraft: () => ({ ownerKey, text: textRef.current, selection: { start: 0, end: 0 } }),
    commitDraft: (next) => {
      textRef.current = next;
      setText(next);
    },
  });
  const submit = useStableCallback(() => setSent((previous) => [...previous, text]));
  return (
    <>
      <textarea aria-label="Message" value={text} readOnly />
      <ComposerVoiceStatus state={state} onDismiss={voice.cancel} />
      <ComposerVoiceControls
        state={state}
        disabledReason={voice.disabledReason}
        needsSetup={voice.needsSetup}
        onStart={voice.start}
        onStop={voice.stop}
        onCancel={voice.cancel}
      />
      <button disabled={!voice.isRecording} onClick={() => voice.stopAndSubmit(submit)}>
        Submit message
      </button>
      <output aria-label="Sent messages">{JSON.stringify(sent)}</output>
    </>
  );
}

it("dictates, transcribes, and sends the committed React draft exactly once", async () => {
  const fake = setup();
  using _recorder = stubGlobal("MediaRecorder", fake.Recorder);
  using _microphone = vi
    .spyOn(navigator.mediaDevices, "getUserMedia")
    .mockResolvedValue(fake.stream as unknown as MediaStream);
  await using screen = await render(<Composer />);
  await screen.getByRole("button", { name: "Dictate", exact: true }).hover();
  await expect.element(page.getByText("Dictate", { exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "Dictate", exact: true }).click();
  await expect.element(screen.getByRole("button", { name: "Stop dictating" })).toBeEnabled();
  const submit = screen.getByRole("button", { name: "Submit message" });
  await expect.element(submit).toBeEnabled();
  await submit.click();
  await expect.element(submit).toBeDisabled();
  await vi.waitFor(() => expect(backend.transcribe).toHaveBeenCalledTimes(1));
  expect(fake.track.stop).toHaveBeenCalled();
  fake.complete({ _tag: "Success", value: { text: "hello world" } });
  await expect.element(screen.getByRole("textbox", { name: "Message" })).toHaveValue("hello world");
  await expect.element(screen.getByLabelText("Sent messages")).toHaveTextContent('["hello world"]');
});

it("retries the same audio after a failed send without submitting the message", async () => {
  const fake = setup();
  using _recorder = stubGlobal("MediaRecorder", fake.Recorder);
  using _microphone = vi
    .spyOn(navigator.mediaDevices, "getUserMedia")
    .mockResolvedValue(fake.stream as unknown as MediaStream);
  await using screen = await render(<Composer />);
  await screen.getByRole("button", { name: "Dictate", exact: true }).click();
  await screen.getByRole("button", { name: "Submit message" }).click();
  await vi.waitFor(() => expect(backend.transcribe).toHaveBeenCalledTimes(1));
  fake.fail(new Error("connection lost"));
  await expect.element(screen.getByRole("button", { name: "Retry dictation" })).toBeEnabled();
  backend.transcribe.mockResolvedValueOnce({
    _tag: "Success",
    value: { text: "recovered speech" },
  });
  await screen.getByRole("button", { name: "Retry dictation" }).click();
  await expect
    .element(screen.getByRole("textbox", { name: "Message" }))
    .toHaveValue("recovered speech");
  expect(backend.transcribe).toHaveBeenCalledTimes(2);
  expect(backend.transcribe.mock.calls[1]![0].input.audioBase64).toBe(
    backend.transcribe.mock.calls[0]![0].input.audioBase64,
  );
  expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
  await expect.element(screen.getByLabelText("Sent messages")).toHaveTextContent("[]");
});

it("keeps the red stop button as transcribe-without-sending", async () => {
  const fake = setup();
  using _recorder = stubGlobal("MediaRecorder", fake.Recorder);
  using _microphone = vi
    .spyOn(navigator.mediaDevices, "getUserMedia")
    .mockResolvedValue(fake.stream as unknown as MediaStream);
  await using screen = await render(<Composer />);
  await screen.getByRole("button", { name: "Dictate", exact: true }).click();
  await screen.getByRole("button", { name: "Stop dictating" }).click();
  await vi.waitFor(() => expect(backend.transcribe).toHaveBeenCalledTimes(1));
  fake.complete({ _tag: "Success", value: { text: "review me" } });
  await expect.element(screen.getByRole("textbox", { name: "Message" })).toHaveValue("review me");
  await expect.element(screen.getByLabelText("Sent messages")).toHaveTextContent("[]");
});

it.each(["chat", "request"] as const)(
  "does not send a late transcript after switching %s",
  async (owner) => {
    const fake = setup();
    using _recorder = stubGlobal("MediaRecorder", fake.Recorder);
    using _microphone = vi
      .spyOn(navigator.mediaDevices, "getUserMedia")
      .mockResolvedValue(fake.stream as unknown as MediaStream);
    await using screen = await render(
      <Composer ownerKey={composerVoiceOwnerKey("test", "thread", "first-request", "question")} />,
    );
    await screen.getByRole("button", { name: "Dictate", exact: true }).click();
    await screen.getByRole("button", { name: "Submit message" }).click();
    await vi.waitFor(() => expect(backend.transcribe).toHaveBeenCalledTimes(1));
    await screen.rerender(
      <Composer
        ownerKey={composerVoiceOwnerKey(
          "test",
          owner === "chat" ? "other-thread" : "thread",
          "next-request",
          "question",
        )}
      />,
    );
    fake.complete({ _tag: "Success", value: { text: "must not send" } });
    await expect
      .element(screen.getByRole("button", { name: "Dictate", exact: true }))
      .toBeEnabled();
    await expect.element(screen.getByRole("textbox", { name: "Message" })).toHaveValue("");
    await expect.element(screen.getByLabelText("Sent messages")).toHaveTextContent("[]");
  },
);

it.each(["Stop dictating", "Submit message"])(
  "does not upload or send oversized final audio via %s",
  async (action) => {
    const fake = setup(
      new Blob([new Uint8Array(VOICE_AUDIO_MAX_BYTES + 1)], { type: "audio/webm" }),
    );
    using _recorder = stubGlobal("MediaRecorder", fake.Recorder);
    using _microphone = vi
      .spyOn(navigator.mediaDevices, "getUserMedia")
      .mockResolvedValue(fake.stream as unknown as MediaStream);
    await using screen = await render(<Composer />);
    await screen.getByRole("button", { name: "Dictate", exact: true }).click();
    await screen.getByRole("button", { name: action, exact: true }).click();
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("This recording is too large. Try a shorter recording.");
    expect(backend.transcribe).not.toHaveBeenCalled();
    expect(fake.track.stop).toHaveBeenCalledTimes(1);
    await expect.element(screen.getByRole("textbox", { name: "Message" })).toHaveValue("");
    await expect.element(screen.getByLabelText("Sent messages")).toHaveTextContent("[]");
  },
);

it.each(["empty", "failure", "cancel"] as const)(
  "does not send when dictation ends with %s",
  async (outcome) => {
    const fake = setup();
    using _recorder = stubGlobal("MediaRecorder", fake.Recorder);
    using _microphone = vi
      .spyOn(navigator.mediaDevices, "getUserMedia")
      .mockResolvedValue(fake.stream as unknown as MediaStream);
    await using screen = await render(<Composer />);
    await screen.getByRole("button", { name: "Dictate", exact: true }).click();
    await screen.getByRole("button", { name: "Submit message" }).click();
    await vi.waitFor(() => expect(backend.transcribe).toHaveBeenCalledTimes(1));
    if (outcome === "cancel")
      await screen.getByRole("button", { name: "Cancel dictation", exact: true }).click();
    if (outcome === "failure") fake.fail(new Error("connection lost"));
    else
      fake.complete({
        _tag: "Success",
        value: { text: outcome === "empty" ? " " : "cancelled text" },
      });
    await expect
      .element(
        screen.getByRole("button", {
          name: outcome === "failure" ? "Retry dictation" : "Dictate",
          exact: true,
        }),
      )
      .toBeEnabled();
    await expect.element(screen.getByRole("textbox", { name: "Message" })).toHaveValue("");
    await expect.element(screen.getByLabelText("Sent messages")).toHaveTextContent("[]");
  },
);
