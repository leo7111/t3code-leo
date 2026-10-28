import { createVoiceTranscriptionState } from "@t3tools/client-runtime/voice-input";
import { connectionAtomRuntime } from "../connection/runtime";
export const { voiceTranscriptionStatus, transcribeVoice, configureVoiceApiKey } =
  createVoiceTranscriptionState(connectionAtomRuntime);
