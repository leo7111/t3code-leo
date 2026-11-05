import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import * as Cause from "effect/Cause";
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
  useUpdateScopedSettings: () => vi.fn(),
}));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: { kind: "environment", environmentId: "test" },
    connectedEnvironments: [{ environmentId: "test", label: "Test" }],
    selectScope: vi.fn(),
  }),
}));
vi.mock("./ScopedSwitch", () => ({ ScopedSwitch: () => null }));
vi.mock("./settingsLayout", () => ({
  SettingsSection: ({ children }: { children: ReactNode }) => children,
  SettingsRow: ({ children, control }: { children?: ReactNode; control?: ReactNode }) => (
    <>
      {control}
      {children}
    </>
  ),
}));

it.each(["success", "failure", "unexpected error"] as const)(
  "clears stale %s feedback when the API key changes",
  async (outcome) => {
    backend.configure.mockReset();
    if (outcome === "unexpected error") {
      backend.configure.mockRejectedValue(new Error("private backend detail"));
    } else {
      backend.configure.mockResolvedValue(
        outcome === "success"
          ? { _tag: "Success", value: {} }
          : { _tag: "Failure", cause: Cause.fail(new Error("connection lost")) },
      );
    }
    await using screen = await render(<VoiceTranscriptionSettings />);
    const input = screen.getByLabelText("API key", { exact: true });
    await input.fill("first-test-key");
    await screen.getByRole("button", { name: "Save", exact: true }).click();
    const feedback = screen.getByRole(outcome === "success" ? "status" : "alert");
    await expect
      .element(feedback)
      .toHaveTextContent(outcome === "success" ? "Saved." : "Could not save. Try again.");
    if (outcome !== "success") {
      await expect.element(screen.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
      expect(screen.container.textContent).not.toContain("private backend detail");
    }
    await input.click();
    await userEvent.keyboard("x");
    await expect.element(feedback).not.toBeInTheDocument();
  },
);
