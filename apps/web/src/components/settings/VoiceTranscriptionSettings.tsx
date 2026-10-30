import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { VoiceTranscriptionError, type EnvironmentId } from "@t3tools/contracts";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { useRef, useState } from "react";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { configureVoiceApiKey, voiceTranscriptionStatus } from "../../state/voiceTranscription";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { useSettingsScope } from "./SettingsScopeContext";
import { ScopedSwitch } from "./ScopedSwitch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const isTranscriptionError = Schema.is(VoiceTranscriptionError);

function EnvironmentVoiceSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const supported = config?.environment.capabilities.voiceTranscription === true;
  const canConfigure = useAtomValue(configureVoiceApiKey.permissionAtom(environmentId));
  const status = useEnvironmentQuery(
    supported ? voiceTranscriptionStatus({ environmentId, input: {} }) : null,
  );
  const configure = useAtomCommand(configureVoiceApiKey, {
    reportFailure: false,
    reportDefect: false,
  });
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const enabled = settings.codexVoiceInputEnabled;
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const pending = useRef(false);
  const disabled =
    !supported || !canConfigure || saving || status.isPending || status.error !== null;
  const save = async (remove: boolean) => {
    if (disabled || pending.current || (!remove && !apiKey.trim())) return;
    pending.current = true;
    setSaving(true);
    setFeedback(null);
    try {
      const result = await configure({
        environmentId,
        input: { apiKey: remove ? null : Redacted.make(apiKey.trim()) },
      });
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        setFeedback({
          error: true,
          text: isTranscriptionError(failure)
            ? new VoiceTranscriptionError({ reason: failure.reason }).message
            : "Could not save. Try again.",
        });
      } else {
        setApiKey("");
        setFeedback({
          error: false,
          text: remove ? "Key removed." : "Saved.",
        });
      }
    } catch {
      setFeedback({ error: true, text: "Could not save. Check the connection and try again." });
    }
    pending.current = false;
    setSaving(false);
  };
  const availability = !supported
    ? "Update T3 to use dictation."
    : status.error
      ? "Could not load. Reconnect."
      : status.isPending
        ? "Loading…"
        : status.data?.source === "stored"
          ? "Key saved."
          : status.data?.source === "environment"
            ? "Using OPENAI_API_KEY."
            : "No key saved.";
  return (
    <>
      <SettingsRow
        {...searchableSetting("codex-voice-input-enabled")}
        title="Enable dictation"
        serverScoped
        settingKeys={["codexVoiceInputEnabled"]}
        description="Codex only."
        control={
          <ScopedSwitch
            settingKeys={["codexVoiceInputEnabled"]}
            aria-label="Enable dictation"
            checked={enabled}
            disabled={!supported || !canConfigure || saving}
            onCheckedChange={(next) => {
              setApiKey("");
              setFeedback(null);
              updateSettings({ codexVoiceInputEnabled: next });
            }}
          />
        }
      />
      {enabled ? (
        <SettingsRow
          {...searchableSetting("voice-transcription-api-key")}
          title="OpenAI API key"
          serverScoped
          description="Billed separately."
          status={availability}
        >
          <form
            className="mt-3 flex max-w-xl flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void save(false);
            }}
          >
            <label className="sr-only" htmlFor="voice-openai-api-key">
              API key
            </label>
            <Input
              id="voice-openai-api-key"
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              maxLength={4096}
              value={apiKey}
              onValueChange={setApiKey}
              disabled={disabled}
              placeholder={status.data?.configured ? "Replace key" : "API key"}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="submit"
                variant="default"
                size="sm"
                disabled={disabled || !apiKey.trim()}
              >
                {saving ? "Saving…" : "Save"}
              </Button>
              {status.data?.source === "stored" ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={disabled}
                  onClick={() => void save(true)}
                >
                  Remove key
                </Button>
              ) : null}
            </div>
            {feedback ? (
              <p
                role={feedback.error ? "alert" : "status"}
                className={
                  feedback.error ? "text-xs text-destructive" : "text-xs text-muted-foreground"
                }
              >
                {feedback.text}
              </p>
            ) : null}
          </form>
        </SettingsRow>
      ) : null}
    </>
  );
}

export function VoiceTranscriptionSettings() {
  const { scope, connectedEnvironments, selectScope } = useSettingsScope();
  const environment =
    scope.kind === "environment"
      ? connectedEnvironments.find((candidate) => candidate.environmentId === scope.environmentId)
      : undefined;
  return (
    <SettingsSection id="voice-input" title="Dictation">
      {environment ? (
        <EnvironmentVoiceSettings
          key={environment.environmentId}
          environmentId={environment.environmentId}
        />
      ) : (
        <SettingsRow
          {...searchableSetting("voice-transcription-api-key")}
          title="OpenAI API key"
          description={
            connectedEnvironments.length > 0 ? "Select a machine." : "Connect a machine."
          }
          control={
            connectedEnvironments.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {connectedEnvironments.map((candidate) => (
                  <Button
                    key={candidate.environmentId}
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => selectScope({ machine: candidate.environmentId })}
                  >
                    {candidate.label}
                  </Button>
                ))}
              </div>
            ) : null
          }
        />
      )}
    </SettingsSection>
  );
}
