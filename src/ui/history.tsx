// Reading history: the start date, the estimate and the start of a history job (backfill_estimate, backfill_start). Used by the
// last step of "Add source" and by "Read history…" on a source card.
import { Button, Dialog, Field, TextInput } from "@opt2-tealbrick/ui";
import { useEffect, useState } from "react";
import { type ConnectAccount, count, keptSentence, type Out, run, type Source } from "./api.ts";
import { Failure, useAct } from "./common.tsx";

const DAY = 86_400_000;
const dayString = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** Three years back is the server's limit (BACKFILL_MAX_YEARS); the date field stops one day short so a time zone never trips it. */
export const OLDEST = () => dayString(Date.now() - (3 * 365 - 2) * DAY);
export const TODAY = () => dayString(Date.now());
const DEFAULT_DAYS = 90;

export type Estimate = Out<"backfill_estimate">;

/** "about 2 min", "about 1 h 10 min". */
export function durationLabel(seconds: number): string {
  if (seconds < 90) return "about a minute";
  const m = Math.round(seconds / 60);
  return m < 60 ? `about ${m} min` : `about ${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}

export function useHistory(sourceId: string | null) {
  const [since, setSinceState] = useState(() => dayString(Date.now() - DEFAULT_DAYS * DAY));
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const { busy, error, setError, act } = useAct();
  useEffect(() => {
    // another source or a new dialog: start again
    void sourceId;
    setSinceState(dayString(Date.now() - DEFAULT_DAYS * DAY));
    setEstimate(null);
    setError(null);
  }, [sourceId, setError]);
  const setSince = (v: string) => {
    setSinceState(v);
    setEstimate(null);
  };
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(since) && since >= OLDEST() && since <= TODAY();
  const iso = `${since}T00:00:00Z`;
  return {
    since,
    setSince,
    valid,
    estimate,
    busy,
    error,
    runEstimate: () =>
      act(async () => {
        if (sourceId) setEstimate(await run("backfill_estimate", { source: sourceId, since: iso }));
      }),
    start: () =>
      act(async () => {
        if (sourceId) await run("backfill_start", { source: sourceId, since: iso });
      }),
  };
}

/** `keptDays`: the source has no history of its own (Connect keeps this many days; null = it does not say); undefined = it has. */
export function HistoryFields({ h, keptDays }: { h: ReturnType<typeof useHistory>; keptDays?: number | null }) {
  const reach = keptDays === undefined ? "History reaches back three years at most." : keptDays === null ? "Connect has only what it kept: older messages cannot be read." : `Connect keeps messages for up to ${keptDays} days: older ones cannot be read.`;
  return (
    <div className="tb-stack">
      <Field label="Read messages since" hint={`Write the day as YYYY-MM-DD. ${reach} Observer reads it in the background. You can pause or stop it.`} error={h.valid ? undefined : "Write a date as YYYY-MM-DD, within the last three years."}>
        <TextInput name="since" inputMode="numeric" placeholder="YYYY-MM-DD" autoComplete="off" value={h.since} onChange={(e) => h.setSince(e.target.value.trim())} />
      </Field>
      <div className="tb-ctas">
        <Button size="sm" onClick={() => void h.runEstimate()} disabled={h.busy || !h.valid}>
          Estimate
        </Button>
      </div>
      {h.estimate ? (
        <p className="tb-soft" role="status">
          About {count(h.estimate.messages)} messages and {count(h.estimate.records)} records, {durationLabel(h.estimate.durationS)}.{h.estimate.providerNote ? ` ${h.estimate.providerNote}` : ""}
        </p>
      ) : null}
    </div>
  );
}

/** "Read history…" on a source card. */
export function HistoryDialog({ source, account, onClose, onStarted }: { source: Source | null; account?: ConnectAccount | undefined; onClose: () => void; onStarted: () => void }) {
  const kept = account && !account.historyCapable ? account.retentionDays : undefined;
  const h = useHistory(source?.id ?? null);
  const go = async () => {
    if (await h.start()) {
      onStarted();
      onClose();
    }
  };
  return (
    <Dialog
      open={source !== null}
      title="Read history"
      kicker={source?.label}
      busy={h.busy}
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={() => void go()} disabled={h.busy || !h.valid}>
          Read history
        </Button>
      }
    >
      <Failure message={h.error} />
      {kept !== undefined ? <p className="tb-soft">{keptSentence(kept)}</p> : null}
      <HistoryFields h={h} keptDays={kept} />
    </Dialog>
  );
}
