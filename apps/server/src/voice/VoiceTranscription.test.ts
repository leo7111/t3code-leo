import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  VOICE_AUDIO_MAX_BYTES,
  VoiceTranscribeInput,
  VoiceConfigureApiKeyInput,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/http";
import * as VoiceTranscription from "./VoiceTranscription.ts";

const decodeVoiceKey = Schema.decodeUnknownSync(VoiceConfigureApiKeyInput);
const isVoiceTranscribeInput = Schema.is(VoiceTranscribeInput);
const secretsLayer = () => {
  const values = new Map<string, Uint8Array>();
  return Layer.mock(ServerSecretStore.ServerSecretStore)({
    get: (name) => Effect.sync(() => Option.fromUndefinedOr(values.get(name))),
    set: (name, value) =>
      Effect.sync(() => {
        values.set(name, value);
      }),
    remove: (name) =>
      Effect.sync(() => {
        values.delete(name);
      }),
  });
};
const settingsLayer = (enabled: () => boolean = () => true) =>
  Layer.mock(ServerSettings.ServerSettingsService)({
    getSettings: Effect.sync(() => ({
      ...DEFAULT_SERVER_SETTINGS,
      codexVoiceInputEnabled: enabled(),
    })),
  });
const audio = {
  audioBase64: Buffer.from("audio fixture").toString("base64"),
  mimeType: "audio/webm" as const,
};
function harness(
  options: { key?: string; status?: number; body?: string; enabled?: () => boolean } = {},
) {
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request);
      return HttpClientResponse.fromWeb(
        request,
        new Response(options.body ?? JSON.stringify({ text: "  שלום T3 Code  " }), {
          status: options.status ?? 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }),
  );
  const layer = VoiceTranscription.layer.pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    Layer.provide(secretsLayer()),
    Layer.provide(settingsLayer(options.enabled)),
    Layer.provide(
      Layer.succeed(
        HostProcess.Environment,
        options.key === undefined ? {} : { OPENAI_API_KEY: options.key },
      ),
    ),
  );
  return { layer, requests };
}

describe("OpenAI voice transcription", () => {
  it.effect("honors disabling and re-enabling without removing a configured key", () => {
    let enabled = true;
    const h = harness({ key: "test-only-key", enabled: () => enabled });
    return Effect.gen(function* () {
      const service = yield* VoiceTranscription.VoiceTranscription;
      enabled = false;
      expect((yield* service.transcribe(audio).pipe(Effect.flip)).reason).toBe("disabled");
      expect(h.requests).toEqual([]);
      expect(yield* service.status).toEqual({ configured: true, source: "environment" });
      enabled = true;
      expect(yield* service.transcribe(audio)).toEqual({ text: "שלום T3 Code" });
      expect(h.requests).toHaveLength(1);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("rejects malformed keys with redacted input and fixed errors", () => {
    const h = harness();
    return Effect.gen(function* () {
      const service = yield* VoiceTranscription.VoiceTranscription;
      for (const apiKey of ["private-fixture".repeat(400), "private\nfixture", " "]) {
        const input = decodeVoiceKey({ apiKey });
        expect(JSON.stringify(input)).not.toContain("private");
        const error = yield* service.configureApiKey(input).pipe(Effect.flip);
        expect(error.reason).toBe("invalid_api_key");
        expect(JSON.stringify(error)).not.toContain("private");
      }
      expect(yield* service.status).toEqual({ configured: false, source: "none" });
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("saves and removes the server-owned key without returning it to clients", () => {
    const h = harness({ key: "environment-fixture" });
    return Effect.gen(function* () {
      const service = yield* VoiceTranscription.VoiceTranscription;
      const saved = yield* service.configureApiKey({ apiKey: Redacted.make("saved-fixture") });
      expect(saved).toEqual({ configured: true, source: "stored" });
      expect(JSON.stringify(saved)).not.toContain("saved-fixture");
      expect(yield* service.status).toEqual(saved);
      yield* service.transcribe(audio);
      expect(h.requests[0]!.headers.authorization).toBe("Bearer saved-fixture");
      expect(yield* service.configureApiKey({ apiKey: null })).toEqual({
        configured: true,
        source: "environment",
      });
      yield* service.transcribe(audio);
      expect(h.requests[1]!.headers.authorization).toBe("Bearer environment-fixture");
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("removing a saved key disables transcription when there is no environment key", () => {
    const h = harness();
    return Effect.gen(function* () {
      const service = yield* VoiceTranscription.VoiceTranscription;
      yield* service.configureApiKey({ apiKey: Redacted.make("saved-fixture") });
      expect(yield* service.configureApiKey({ apiKey: null })).toEqual({
        configured: false,
        source: "none",
      });
      expect((yield* service.transcribe(audio).pipe(Effect.flip)).reason).toBe("not_configured");
      expect(h.requests).toEqual([]);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("sends one bounded multipart recording and returns editable multilingual text", () => {
    const h = harness({ key: "test-only-key" });
    return Effect.gen(function* () {
      const service = yield* VoiceTranscription.VoiceTranscription;
      expect(yield* service.status).toEqual({ configured: true, source: "environment" });
      expect(yield* service.transcribe(audio)).toEqual({ text: "שלום T3 Code" });
      expect(h.requests).toHaveLength(1);
      const request = h.requests[0]!;
      expect(request.url).toBe("https://api.openai.com/v1/audio/transcriptions");
      expect(request.headers.authorization).toBe("Bearer test-only-key");
      expect(request.body._tag).toBe("FormData");
      if (request.body._tag === "FormData") {
        expect(request.body.formData.get("model")).toBe("gpt-transcribe");
        const file = request.body.formData.get("file");
        expect(file).toBeInstanceOf(File);
        expect((file as File).name).toBe("recording.webm");
        expect((file as File).size).toBe(Buffer.from("audio fixture").length);
      }
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("does not send audio without an API key", () => {
    const h = harness();
    return Effect.gen(function* () {
      const service = yield* VoiceTranscription.VoiceTranscription;
      expect(yield* service.status).toEqual({ configured: false, source: "none" });
      expect((yield* service.transcribe(audio).pipe(Effect.flip)).reason).toBe("not_configured");
      expect(h.requests).toEqual([]);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect.each([
    { status: 401, reason: "unauthorized" },
    { status: 403, reason: "unauthorized" },
    { status: 429, reason: "rate_limited" },
    { status: 500, reason: "unavailable" },
  ])("maps $status safely and never retries billable uploads", ({ status, reason }) => {
    const h = harness({
      key: "test-only-key",
      status,
      body: "private upstream response containing test-only-key",
    });
    return Effect.gen(function* () {
      const service = yield* VoiceTranscription.VoiceTranscription;
      const error = yield* service.transcribe(audio).pipe(Effect.flip);
      expect(error.reason).toBe(reason);
      expect(JSON.stringify(error)).not.toContain("test-only-key");
      expect(JSON.stringify(error)).not.toContain("private upstream");
      expect(h.requests).toHaveLength(1);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect.each(["not json", '{"text":123}'])("rejects invalid API responses", (body) => {
    const h = harness({ key: "test-only-key", body });
    return Effect.gen(function* () {
      const service = yield* VoiceTranscription.VoiceTranscription;
      expect((yield* service.transcribe(audio).pipe(Effect.flip)).reason).toBe("invalid_response");
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("rejects empty, malformed, and oversized audio before calling OpenAI", () => {
    const h = harness({ key: "test-only-key" });
    return Effect.gen(function* () {
      const service = yield* VoiceTranscription.VoiceTranscription;
      for (const audioBase64 of [
        "",
        "invalid!",
        Buffer.alloc(VOICE_AUDIO_MAX_BYTES + 1).toString("base64"),
      ]) {
        expect(
          (yield* service.transcribe({ ...audio, audioBase64 }).pipe(Effect.flip)).reason,
        ).toBe("invalid_audio");
      }
      expect(h.requests).toEqual([]);
      expect(isVoiceTranscribeInput({ ...audio, mimeType: "text/plain" })).toBe(false);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("bounds a stalled API request and aborts its underlying work", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      let interrupted = false;
      const client = HttpClient.make(() =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              interrupted = true;
            }),
          ),
        ),
      );
      const layer = VoiceTranscription.layer.pipe(
        Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
        Layer.provide(secretsLayer()),
        Layer.provide(settingsLayer()),
        Layer.provide(Layer.succeed(HostProcess.Environment, { OPENAI_API_KEY: "test-only-key" })),
      );
      const result = yield* Effect.gen(function* () {
        const service = yield* VoiceTranscription.VoiceTranscription;
        const running = yield* service.transcribe(audio).pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(entered);
        yield* TestClock.adjust("2 minutes");
        return yield* Fiber.join(running);
      }).pipe(Effect.provide(layer));
      expect(result.reason).toBe("unavailable");
      expect(interrupted).toBe(true);
    }),
  );
});
