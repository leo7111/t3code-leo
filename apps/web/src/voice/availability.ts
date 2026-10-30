import type { ServerProvider } from "@t3tools/contracts";

type VoiceProvider = Pick<ServerProvider, "driver" | "enabled" | "installed" | "status" | "auth">;

export function composerVoiceOwnerKey(
  environmentId: string,
  draftTargetKey: string,
  requestId: string | undefined,
  questionId: string | undefined,
): string {
  return JSON.stringify([environmentId, draftTargetKey, requestId ?? null, questionId ?? null]);
}

export function canShowCodexVoiceInput(provider: VoiceProvider | null): boolean {
  return (
    provider?.driver === "codex" &&
    provider.enabled &&
    provider.installed &&
    provider.status === "ready" &&
    provider.auth.status === "authenticated"
  );
}
