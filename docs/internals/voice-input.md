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

The web capture adapter uses MediaRecorder and the existing shared controller.
Capture stays on the client even for remote environments. The prepared transcriber
binds the environment before recording; it never falls back to another server.
Recordings are limited to five minutes and 8 MiB. Audio remains temporary client
input and is uploaded through an authorized RPC, separate from durable attachments.
The server sends one multipart request to OpenAI's transcription endpoint, with a
two-minute timeout and no automatic retries of billable uploads.

Dictation settings live under Integrations for one selected machine.
The enable preference persists with server settings and hides the microphone when
off, even if a key is configured; other providers do not show this control. Clicking the
microphone without a configured key opens that machine's API key settings. The key
is stored by ServerSecretStore, decoded as Redacted at the RPC boundary, and never
returned to clients. A stored key overrides the server's optional OPENAI_API_KEY;
removing it restores that environment fallback. Saving keys requires settings-write
permission; transcription requires orchestration-operate permission. Configuration
status requires only orchestration-read permission and returns no credential.

OpenAI API billing is separate from ChatGPT and Codex subscriptions. Only safe,
fixed error messages cross the RPC boundary; upstream response bodies and nested
HTTP errors are discarded. Cancellation interrupts pending client work and prevents
late draft insertion, but an upload already received by OpenAI may still be billed.
