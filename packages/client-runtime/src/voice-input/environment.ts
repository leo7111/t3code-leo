import {
  WS_METHODS,
  type VoiceConfigureApiKeyInput,
  type VoiceTranscribeInput,
} from "@t3tools/contracts";
import { requestGuarded } from "../rpc/client.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "../state/runtime.ts";
import * as Effect from "effect/Effect";
import type * as EnvironmentRegistry from "../connection/registry.ts";
import type { Atom } from "effect/reactivity";

export function createVoiceTranscriptionState<R, E>(
  connectionAtomRuntime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  const voiceTranscriptionStatus = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "voice:status",
    tag: WS_METHODS.voiceTranscriptionStatus,
    staleTimeMs: 30_000,
    idleTtlMs: 60_000,
  });

  const transcribeVoice = createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "voice:transcribe",
    tag: WS_METHODS.voiceTranscribe,
    execute: (input: VoiceTranscribeInput & { readonly signal: AbortSignal }) => {
      const cancelled = Effect.callback<never>((resume) => {
        const abort = () => resume(Effect.interrupt);
        input.signal.addEventListener("abort", abort, { once: true });
        if (input.signal.aborted) abort();
        return Effect.sync(() => input.signal.removeEventListener("abort", abort));
      });
      return Effect.raceFirst(
        requestGuarded(WS_METHODS.voiceTranscribe, {
          audioBase64: input.audioBase64,
          mimeType: input.mimeType,
        }),
        cancelled,
      );
    },
  });

  const configureVoiceApiKey = createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "voice:configureApiKey",
    tag: WS_METHODS.voiceConfigureApiKey,
    execute: (input: VoiceConfigureApiKeyInput) =>
      requestGuarded(WS_METHODS.voiceConfigureApiKey, input),
    onSuccess: ({ environmentId }, registry) =>
      Effect.sync(() => {
        registry.refresh(voiceTranscriptionStatus({ environmentId, input: {} }));
      }),
  });
  return { voiceTranscriptionStatus, transcribeVoice, configureVoiceApiKey };
}
