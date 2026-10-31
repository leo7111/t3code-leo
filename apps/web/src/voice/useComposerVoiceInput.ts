import { useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  VoiceInputController,
  VoiceTranscriptionError,
  voiceInputBlocksSubmission,
  type VoiceDraftSnapshot,
  type VoiceInputState,
  type VoiceTranscriptionOptions,
} from "@t3tools/client-runtime/voice-input";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  VoiceTranscriptionError as ApiTranscriptionError,
  type EnvironmentId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useStableCallback } from "../hooks/useStableCallback";
import { useAtomCommand } from "../state/use-atom-command";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { transcribeVoice, voiceTranscriptionStatus } from "../state/voiceTranscription";
import { BrowserVoiceRecorder, readRecording } from "./browserVoiceRecorder";
import { canShowCodexVoiceInput } from "./availability";

const isApiTranscriptionError = Schema.is(ApiTranscriptionError);

export function useComposerVoiceInput(options: {
  readonly state: VoiceInputState;
  readonly onStateChange: (state: VoiceInputState) => void;
  readonly environmentId: EnvironmentId;
  readonly ownerKey: string;
  readonly text: string;
  readonly available: boolean;
  readonly provider: ServerProvider | null;
  readonly readDraft: () => Omit<VoiceDraftSnapshot, "revision"> | null;
  readonly commitDraft: (
    text: string,
    selection: { readonly start: number; readonly end: number },
  ) => void;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(options.environmentId));
  const supported =
    config?.environment.capabilities.voiceTranscription === true &&
    canShowCodexVoiceInput(options.provider) &&
    config.settings.codexVoiceInputEnabled;
  const available = options.available && supported;
  const canTranscribe = useAtomValue(transcribeVoice.permissionAtom(options.environmentId));
  const status = useEnvironmentQuery(
    supported
      ? voiceTranscriptionStatus({ environmentId: options.environmentId, input: {} })
      : null,
  );
  const transcribe = useAtomCommand(transcribeVoice, { reportFailure: false, reportDefect: false });
  const navigate = useNavigate();
  const { state } = options;
  const onStateChange = useStableCallback(options.onStateChange);
  const revision = useRef({ ownerKey: options.ownerKey, text: options.text, version: 0 });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Track the editor revision used by the asynchronous recorder controller.
  useLayoutEffect(() => {
    if (revision.current.ownerKey !== options.ownerKey || revision.current.text !== options.text) {
      revision.current = {
        ownerKey: options.ownerKey,
        text: options.text,
        version: revision.current.version + 1,
      };
    }
  }, [options.ownerKey, options.text]);

  const readDraft = useStableCallback(() => {
    const draft = available ? options.readDraft() : null;
    return draft ? { ...draft, revision: revision.current.version } : null;
  });
  const commitDraft = useStableCallback(options.commitDraft);
  const prepare = useStableCallback(async ({ signal }: VoiceTranscriptionOptions) => {
    if (signal.aborted)
      throw new VoiceTranscriptionError("cancelled", "Voice input was cancelled.");
    const environmentId = options.environmentId;
    if (!available || !canTranscribe || !status.data?.configured)
      throw new VoiceTranscriptionError(
        "unavailable",
        "Add an OpenAI API key in Settings → Browser → Voice input.",
      );
    return {
      locale: navigator.language || "en-US",
      transcribe: async (uri: string, { signal }: VoiceTranscriptionOptions) => {
        const audio = await readRecording(uri, signal);
        const result = await transcribe({ environmentId, input: { ...audio, signal } });
        if (result._tag === "Failure") {
          const failure = squashAtomCommandFailure(result);
          throw new VoiceTranscriptionError(
            "transcription-failed",
            isApiTranscriptionError(failure)
              ? new ApiTranscriptionError({ reason: failure.reason }).message
              : "Could not transcribe the recording. Check the connection and try again.",
          );
        }
        return result.value.text;
      },
    };
  });
  const [session] = useState(() => {
    const recorder = new BrowserVoiceRecorder((status) => {
      void controller.handleRecorderStatus(status);
    });
    const controller = new VoiceInputController({
      retainRecordingOnFailure: true,
      recorder,
      getTranscriber: () => ({ prepare }),
      requestPermission: async () => ({ granted: true, canAskAgain: true }),
      configureRecording: async () => {},
      releaseRecording: () => recorder.release(),
      deleteRecording: (uri) => recorder.deleteRecording(uri),
      readDraft,
      commitDraft,
      onStateChange,
    });
    return { controller };
  });
  const owner = useRef({
    key: options.ownerKey,
    environmentId: options.environmentId,
    available,
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Cancel the native recorder when its composer owner or environment becomes unavailable.
  useLayoutEffect(() => {
    const previous = owner.current;
    if (
      previous.key !== options.ownerKey ||
      previous.environmentId !== options.environmentId ||
      previous.available !== available
    )
      session.controller.ownerChanged();
    owner.current = {
      key: options.ownerKey,
      environmentId: options.environmentId,
      available,
    };
  }, [session, options.ownerKey, options.environmentId, available]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Release the microphone and pending transcription when the composer unmounts.
  useEffect(() => () => session.controller.dispose(), [session]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keep the recorder in step with browser visibility and remove its listeners on unmount.
  useEffect(() => {
    const hide = () => {
      void session.controller.appMovedToBackground();
    };
    const visibilityChanged = () => {
      if (document.visibilityState === "hidden") hide();
    };
    window.addEventListener("pagehide", hide);
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      window.removeEventListener("pagehide", hide);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [session]);
  const microphoneSupported =
    typeof MediaRecorder !== "undefined" &&
    globalThis.isSecureContext &&
    Boolean(navigator.mediaDevices?.getUserMedia);
  const disabledReason = !supported
    ? "Update T3 to use dictation."
    : !microphoneSupported
      ? "Microphone requires HTTPS or localhost."
      : !canTranscribe
        ? "Dictation not permitted."
        : !available
          ? "Composer busy."
          : status.isPending
            ? "Checking…"
            : status.error
              ? "Dictation unavailable. Reconnect."
              : null;
  const needsSetup = disabledReason === null && status.data?.configured === false;
  return {
    supported,
    state,
    disabledReason,
    needsSetup,
    isBusy: voiceInputBlocksSubmission(state),
    isRecording: state.phase === "recording",
    isRecordingNow: () => session.controller.currentState.phase === "recording",
    blocksSubmission: () => voiceInputBlocksSubmission(session.controller.currentState),
    start: () => {
      if (disabledReason !== null) return;
      if (needsSetup) {
        void navigate({
          to: "/settings/browser",
          search: { machine: options.environmentId },
          hash: "voice-transcription-api-key",
        });
        return;
      }
      void session.controller.start();
    },
    stop: () => {
      void session.controller.stop();
    },
    stopAndSubmit: (submit: () => void) => {
      const capturedOwner = owner.current;
      void session.controller.stop((text) => {
        // Sending reads React state as well as the editor ref. Publish the committed
        // transcript and idle state together before invoking the normal send path.
        flushSync(() => onStateChange(session.controller.currentState));
        const currentDraft = readDraft();
        if (
          owner.current.key !== capturedOwner.key ||
          owner.current.environmentId !== capturedOwner.environmentId ||
          !owner.current.available ||
          currentDraft?.ownerKey !== capturedOwner.key ||
          currentDraft.text !== text
        )
          return;
        submit();
      });
    },
    cancel: () => session.controller.cancel(),
  };
}
