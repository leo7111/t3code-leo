import type { ServerProvider } from "@t3tools/contracts";

type VoiceProvider = Pick<ServerProvider, "driver" | "enabled" | "installed" | "status" | "auth">;

export function canShowCodexVoiceInput(provider: VoiceProvider | null): boolean {
  return (
    provider?.driver === "codex" &&
    provider.enabled &&
    provider.installed &&
    provider.status === "ready" &&
    provider.auth.status === "authenticated"
  );
}
