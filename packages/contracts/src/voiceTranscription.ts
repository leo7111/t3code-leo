import * as Schema from "effect/Schema";

export const VOICE_AUDIO_MAX_BYTES = 8 * 1024 * 1024;
export const VoiceAudioMimeType = Schema.Literals([
  "audio/webm",
  "audio/mp4",
  "audio/ogg",
  "audio/wav",
]);
export const VoiceTranscribeInput = Schema.Struct({
  audioBase64: Schema.String.check(
    Schema.isMinLength(4),
    Schema.isMaxLength(Math.ceil(VOICE_AUDIO_MAX_BYTES / 3) * 4),
    Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  ),
  mimeType: VoiceAudioMimeType,
});
export type VoiceTranscribeInput = typeof VoiceTranscribeInput.Type;
export const VoiceTranscribeResult = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(100_000)),
});
export const VoiceTranscriptionStatus = Schema.Struct({
  configured: Schema.Boolean,
  source: Schema.Literals(["stored", "environment", "none"]),
});
export type VoiceTranscriptionStatus = typeof VoiceTranscriptionStatus.Type;
export const VoiceConfigureApiKeyInput = Schema.Struct({
  // Validate length after wrapping, so malformed-key diagnostics cannot echo the key.
  apiKey: Schema.NullOr(Schema.RedactedFromValue(Schema.String)),
});
export type VoiceConfigureApiKeyInput = typeof VoiceConfigureApiKeyInput.Type;

const messages = {
  disabled: "Transcription is disabled. Enable it in Settings → Integrations → OpenAI voice input.",
  not_configured: "Add an OpenAI API key in Settings → Integrations → Voice input.",
  invalid_api_key: "Enter a valid OpenAI API key (up to 4,096 characters, without spaces).",
  configuration_failed: "Could not access transcription settings on this T3 server. Try again.",
  invalid_audio:
    "This recording is empty, unsupported, or too large. Record up to five minutes and try again.",
  unauthorized: "OpenAI rejected the API key. Check the key configured on this T3 server.",
  rate_limited:
    "OpenAI's transcription quota or rate limit was reached. Check API billing or try again later.",
  unavailable: "Could not reach OpenAI transcription. Check the connection and try again.",
  invalid_response: "OpenAI returned an invalid transcription response. Try again.",
} as const;
export class VoiceTranscriptionError extends Schema.TaggedError<VoiceTranscriptionError>()(
  "VoiceTranscriptionError",
  {
    reason: Schema.Literals(Object.keys(messages) as Array<keyof typeof messages>),
  },
) {
  override get message(): string {
    return messages[this.reason];
  }
}
