import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";
import { canShowCodexVoiceInput, composerVoiceOwnerKey } from "./availability";

const ready = {
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  status: "ready" as const,
  auth: { status: "authenticated" as const },
};

it("gives replacement pending requests distinct voice owners despite identical question ids", () => {
  const first = composerVoiceOwnerKey("environment", "draft", "request-one", "question");
  const second = composerVoiceOwnerKey("environment", "draft", "request-two", "question");
  expect(first).not.toBe(second);
  expect(first).toBe(composerVoiceOwnerKey("environment", "draft", "request-one", "question"));
  expect(first).not.toBe(composerVoiceOwnerKey("environment", "draft", undefined, undefined));
});

describe("composer voice provider availability", () => {
  it("allows a ready authenticated Codex provider", () => {
    expect(canShowCodexVoiceInput(ready)).toBe(true);
  });

  it("hides voice input without a selected provider", () => {
    expect(canShowCodexVoiceInput(null)).toBe(false);
  });

  it.each(["claudeAgent", "cursor", "grok", "opencode", "antigravity"] as const)(
    "hides voice input for %s",
    (driver) => {
      expect(canShowCodexVoiceInput({ ...ready, driver: ProviderDriverKind.make(driver) })).toBe(
        false,
      );
    },
  );

  it("hides voice input when Codex is not installed", () => {
    expect(canShowCodexVoiceInput({ ...ready, installed: false })).toBe(false);
  });

  it("hides voice input when Codex is disabled", () => {
    expect(canShowCodexVoiceInput({ ...ready, enabled: false })).toBe(false);
  });

  it("hides voice input when Codex needs attention", () => {
    expect(canShowCodexVoiceInput({ ...ready, status: "warning" })).toBe(false);
  });

  it.each(["unauthenticated", "unknown"] as const)(
    "hides voice input when Codex authentication is %s",
    (status) => {
      expect(canShowCodexVoiceInput({ ...ready, auth: { status } })).toBe(false);
    },
  );
});
