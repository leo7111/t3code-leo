import {
  VOICE_AUDIO_MAX_BYTES,
  VoiceTranscriptionError,
  VoiceTranscribeResult,
  type VoiceTranscribeInput,
  type VoiceTranscriptionStatus,
  type VoiceConfigureApiKeyInput,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

export class VoiceTranscription extends Context.Service<
  VoiceTranscription,
  {
    readonly status: Effect.Effect<VoiceTranscriptionStatus, VoiceTranscriptionError>;
    readonly configureApiKey: (
      input: VoiceConfigureApiKeyInput,
    ) => Effect.Effect<VoiceTranscriptionStatus, VoiceTranscriptionError>;
    readonly transcribe: (
      input: VoiceTranscribeInput,
    ) => Effect.Effect<{ text: string }, VoiceTranscriptionError>;
  }
>()("t3/voice/VoiceTranscription") {}

const extensions = {
  "audio/webm": "webm",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
} as const;

const make = Effect.gen(function* () {
  const environment = yield* HostProcess.Environment;
  const httpClient = yield* HttpClient.HttpClient;
  const semaphore = yield* Semaphore.make(1);
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const settings = yield* ServerSettings.ServerSettingsService;
  const secretName = "voice-transcription-openai-api-key";
  const configurationError = () => new VoiceTranscriptionError({ reason: "configuration_failed" });
  const readKey = Effect.fn("VoiceTranscription.readKey")(function* () {
    const stored = yield* secrets.get(secretName).pipe(Effect.mapError(configurationError));
    const saved = Option.isSome(stored) ? new TextDecoder().decode(stored.value).trim() : "";
    const value = saved || environment.OPENAI_API_KEY?.trim();
    return {
      apiKey: value ? Redacted.make(value) : null,
      source: saved ? ("stored" as const) : value ? ("environment" as const) : ("none" as const),
    };
  });
  const status = readKey().pipe(
    Effect.map(({ apiKey, source }) => ({
      configured: apiKey !== null,
      source,
    })),
  );
  const configureApiKey = Effect.fn("VoiceTranscription.configureApiKey")(function* (
    input: VoiceConfigureApiKeyInput,
  ) {
    const value = input.apiKey === null ? null : Redacted.value(input.apiKey).trim();
    if (value !== null && (value.length === 0 || value.length > 4096 || /\s/.test(value))) {
      return yield* new VoiceTranscriptionError({ reason: "invalid_api_key" });
    }
    yield* (
      value === null
        ? secrets.remove(secretName)
        : secrets.set(secretName, new TextEncoder().encode(value))
    ).pipe(Effect.mapError(configurationError));
    return yield* status;
  });
  const transcribe = Effect.fn("VoiceTranscription.transcribe")(
    function* (input: VoiceTranscribeInput) {
      const currentSettings = yield* settings.getSettings.pipe(Effect.mapError(configurationError));
      if (!currentSettings.codexVoiceInputEnabled)
        return yield* new VoiceTranscriptionError({ reason: "disabled" });
      const { apiKey } = yield* readKey();
      if (!apiKey) return yield* new VoiceTranscriptionError({ reason: "not_configured" });
      const bytes = Buffer.from(input.audioBase64, "base64");
      if (
        bytes.length === 0 ||
        bytes.length > VOICE_AUDIO_MAX_BYTES ||
        bytes.toString("base64") !== input.audioBase64 ||
        !Object.hasOwn(extensions, input.mimeType)
      ) {
        return yield* new VoiceTranscriptionError({ reason: "invalid_audio" });
      }
      const body = new FormData();
      body.set("model", "gpt-transcribe");
      body.set(
        "file",
        new Blob([bytes], { type: input.mimeType }),
        `recording.${extensions[input.mimeType]}`,
      );
      // No retries: a lost response must not silently cause a second billable upload.
      const response = yield* HttpClientRequest.post(
        "https://api.openai.com/v1/audio/transcriptions",
      ).pipe(
        HttpClientRequest.bearerToken(apiKey),
        HttpClientRequest.bodyFormData(body),
        httpClient.execute,
        Effect.tapError((error) =>
          Effect.logWarning("voice transcription request failed", { category: error.reason._tag }),
        ),
        Effect.mapError(() => new VoiceTranscriptionError({ reason: "unavailable" })),
      );
      if (response.status < 200 || response.status >= 300) {
        yield* Effect.logWarning("voice transcription response failed", {
          status: response.status,
        });
        return yield* new VoiceTranscriptionError({
          reason:
            response.status === 401 || response.status === 403
              ? "unauthorized"
              : response.status === 429
                ? "rate_limited"
                : "unavailable",
        });
      }
      return yield* HttpClientResponse.schemaBodyJson(VoiceTranscribeResult)(response).pipe(
        Effect.map(({ text }) => ({ text: text.trim() })),
        Effect.tapError(() =>
          Effect.logWarning("voice transcription response failed", {
            category: "invalid_response",
          }),
        ),
        Effect.mapError(() => new VoiceTranscriptionError({ reason: "invalid_response" })),
      );
    },
    semaphore.withPermits(1),
    Effect.timeout("2 minutes"),
    Effect.catchTags({
      TimeoutError: () => Effect.fail(new VoiceTranscriptionError({ reason: "unavailable" })),
    }),
  );
  return VoiceTranscription.of({
    status,
    configureApiKey,
    transcribe,
  });
});
export const layer = Layer.effect(VoiceTranscription, make);
