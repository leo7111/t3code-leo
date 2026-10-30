import { MicIcon, SquareIcon, XIcon } from "lucide-react";
import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerBanner } from "./ComposerBanner";

export function ComposerVoiceControls(props: {
  readonly state: VoiceInputState;
  readonly disabledReason: string | null;
  readonly needsSetup: boolean;
  readonly onStart: () => void;
  readonly onStop: () => void;
  readonly onCancel: () => void;
}) {
  const busy =
    props.state.phase === "preparing" ||
    props.state.phase === "recording" ||
    props.state.phase === "transcribing";
  const recording = props.state.phase === "recording";
  const label = recording
    ? "Stop dictating"
    : props.state.phase === "preparing"
      ? "Starting…"
      : busy
        ? "Transcribing…"
        : props.needsSetup
          ? "Set up dictation"
          : "Dictate";
  return (
    <div className="flex shrink-0 items-center gap-1" data-composer-voice-controls>
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex" />}>
          <Button
            variant={recording ? "destructive" : "ghost-muted"}
            size="icon"
            aria-label={label}
            disabled={busy ? !recording : props.disabledReason !== null}
            onPointerDown={(event) => event.preventDefault()}
            onClick={recording ? props.onStop : props.onStart}
          >
            {recording ? (
              <SquareIcon aria-hidden="true" />
            ) : busy ? (
              <Spinner aria-hidden="true" />
            ) : (
              <MicIcon aria-hidden="true" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipPopup>{props.disabledReason ?? label}</TooltipPopup>
      </Tooltip>
      {busy ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost-muted"
                size="icon"
                aria-label="Cancel dictation"
                onClick={props.onCancel}
              />
            }
          >
            <XIcon aria-hidden="true" />
          </TooltipTrigger>
          <TooltipPopup>Cancel dictation</TooltipPopup>
        </Tooltip>
      ) : null}
    </div>
  );
}

export function ComposerVoiceStatus({
  state,
  onDismiss,
}: {
  readonly state: VoiceInputState;
  readonly onDismiss: () => void;
}) {
  if (state.phase === "idle") return null;
  if (state.phase !== "error") {
    return (
      <span className="sr-only" role="status">
        {state.phase === "recording"
          ? "Dictating"
          : state.phase === "preparing"
            ? "Starting…"
            : "Transcribing…"}
      </span>
    );
  }
  return (
    <ComposerBanner.Row>
      <ComposerBanner.Content>
        <span className="whitespace-normal text-sm text-muted-foreground" role="alert">
          {state.error}
        </span>
      </ComposerBanner.Content>
      <Button variant="ghost-muted" size="icon-xs" aria-label="Dismiss" onClick={onDismiss}>
        <XIcon aria-hidden="true" />
      </Button>
    </ComposerBanner.Row>
  );
}
