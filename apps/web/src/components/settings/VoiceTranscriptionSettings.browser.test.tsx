import type { ReactNode } from "react";
import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { VoiceTranscriptionSettings } from "./VoiceTranscriptionSettings";

const backend = vi.hoisted(() => ({ configure: vi.fn() }));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: (atom: string) =>
    atom === "config" ? { environment: { capabilities: { voiceTranscription: true } } } : true,
}));
vi.mock("../../state/server", () => ({ serverEnvironment: { configValueAtom: () => "config" } }));
vi.mock("../../state/voiceTranscription", () => ({
  configureVoiceApiKey: { permissionAtom: () => "permission" },
  voiceTranscriptionStatus: () => "status",
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => backend.configure }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: { configured: false }, isPending: false, error: null }),
}));
vi.mock("./useScopedSettings", () => ({
  useScopedSettings: () => ({ codexVoiceInputEnabled: true }),
  useScopedSettingsMixed: () => false,
  useUpdateScopedSettings: () => vi.fn(),
}));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: { kind: "environment", environmentId: EnvironmentId.make("test") },
    connectedEnvironments: [{ environmentId: EnvironmentId.make("test") }],
  }),
}));
vi.mock("./settingsLayout", () => ({
  SettingsSection: ({ children }: { children: ReactNode }) => children,
  SettingsRow: ({ children, control }: { children?: ReactNode; control?: ReactNode }) => (
    <>
      {control}
      {children}
    </>
  ),
}));

it.each(["success", "failure"] as const)(
  "clears stale %s feedback when the API key changes",
  async (outcome) => {
    backend.configure.mockReset();
    if (outcome === "success") backend.configure.mockResolvedValue({ _tag: "Success", value: {} });
    else backend.configure.mockRejectedValue(new Error("connection lost"));
    await using screen = await render(<VoiceTranscriptionSettings />);
    const input = screen.getByLabelText("API key", { exact: true });
    await input.fill("first-test-key");
    await screen.getByRole("button", { name: "Save", exact: true }).click();
    const feedback = screen.getByRole(outcome === "success" ? "status" : "alert");
    await expect
      .element(feedback)
      .toHaveTextContent(
        outcome === "success" ? "Saved." : "Could not save. Check the connection and try again.",
      );
    await input.click();
    await userEvent.keyboard("x");
    await expect.element(feedback).not.toBeInTheDocument();
  },
);
