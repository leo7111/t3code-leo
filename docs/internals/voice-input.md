# Voice input

Transcription edits a composer draft. On web and desktop, Submit during recording
stops capture, transcribes, and sends through normal message submission only after
the transcript is committed and the same draft still owns the operation. The red
stop control transcribes without sending. Failed, empty, cancelled, or stale results
never trigger automatic submission. Audio is temporary client input. Supported iOS devices transcribe locally. Web and desktop clients can use
OpenAI transcription in single-provider Codex chats through the selected environment when it advertises the
`voiceTranscription` capability.

The [shared controller](../../packages/client-runtime/src/voice-input/controller.ts)
owns the operation while the client supplies capture and transcription. Preparation
binds the transcriber and resolved locale for the whole recording. Draft ownership,
text, and revision are captured before recording and checked before insertion, so
a late transcript cannot overwrite a draft that was edited or replaced.

Cancellation invalidates a result immediately, but resources stay owned until the
underlying work settles. Apple's native transcription call cannot be interrupted
once started. Releasing the session or deleting its recording when the abort signal
fires would race that work. The [transcription contract](../../packages/client-runtime/src/voice-input/transcription.ts)
therefore requires implementations to settle only after their work has stopped;
the [Apple binding](../../apps/mobile/src/native/voiceTranscription.ios.ts) checks
cancellation between native calls and discards late results.

## Environment-backed transcription

Capture stays on the client even for remote environments. The prepared transcriber
binds the environment before recording; it never falls back to another server.
The server deliberately avoids automatic retries because uploads are billable;
cancelling a request cannot undo billing for an upload already received by OpenAI.

See the [capture adapter](../../apps/web/src/voice/browserVoiceRecorder.ts),
[environment binding](../../packages/client-runtime/src/voice-input/environment.ts), and
[transcription service](../../apps/server/src/voice/VoiceTranscription.ts) for the
limits, configuration, and transport behavior.
