// Privacy: how long Observer keeps message text, what it does when a message is deleted in the source, and "Delete stored text now".
// Mockup: build-app-observer.ts. DESIGN §5.5.
import { Button, Dialog, Field, Notice, Select, Switch, TextInput } from "@opt2-tealbrick/ui";
import { useEffect, useState } from "react";
import { type In, plural, run } from "./api.ts";
import { Failure, LoadFailed, PageHead, useAct, useLoad } from "./common.tsx";

const TEXT_DAYS = [1, 7, 30, 90, 365];
const REVIEW_DAYS = [7, 30, 90, 180, 365];
const days = (d: number) => (d === 1 ? "1 day" : d === 365 ? "365 days (longest)" : `${d} days`);
const options = (list: number[], current: number | undefined) => (current !== undefined && !list.includes(current) ? [...list, current].sort((a, b) => a - b) : list).map((d) => ({ value: String(d), label: days(d) }));

function DeleteNow({ open, sources, onClose }: { open: boolean; sources: { id: string; label: string }[]; onClose: () => void }) {
  const [source, setSource] = useState("");
  const [before, setBefore] = useState("");
  const [done, setDone] = useState<number | null>(null);
  const { busy, error, setError, act } = useAct();
  useEffect(() => {
    if (open) return;
    setSource("");
    setBefore("");
    setDone(null);
    setError(null);
  }, [open, setError]);
  const beforeOk = before === "" || (/^\d{4}-\d{2}-\d{2}$/.test(before) && !Number.isNaN(Date.parse(`${before}T00:00:00Z`)));
  const go = () =>
    act(async () => {
      const out = await run("purge", { ...(source ? { source } : {}), ...(before ? { before: `${before}T00:00:00Z` } : {}) });
      setDone(out.purged);
    });
  return (
    <Dialog
      open={open}
      title={done === null ? "Delete stored text now" : "Text deleted"}
      busy={busy}
      onClose={onClose}
      footer={
        done === null ? (
          <>
            <Button onClick={onClose} disabled={busy}>
              Keep it
            </Button>
            <Button variant="danger" confirm onClick={() => void go()} disabled={busy || !beforeOk}>
              Delete the text
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={onClose}>
            Close
          </Button>
        )
      }
    >
      <Failure message={error} />
      {done !== null ? (
        <p className="tb-soft" role="status">
          Observer deleted the stored text of {plural(done, "message")}. It keeps the message ids and dates, so nothing is read twice.
        </p>
      ) : (
        <div className="tb-stack">
          <p className="tb-soft">This deletes the message text and the record titles now, not after the retention time. It cannot be undone. Documents already delivered to Knowledge stay there.</p>
          <Field label="Which source">
            <Select value={source} onValueChange={setSource} options={[{ value: "", label: "All sources" }, ...sources.map((s) => ({ value: s.id, label: s.label }))]} />
          </Field>
          <Field label="Only messages sent before" hint="Write the day as YYYY-MM-DD. Empty: all stored text of the source." error={beforeOk ? undefined : "Write a date as YYYY-MM-DD, or leave it empty."}>
            <TextInput name="before" inputMode="numeric" placeholder="YYYY-MM-DD" autoComplete="off" value={before} onChange={(e) => setBefore(e.target.value.trim())} />
          </Field>
        </div>
      )}
    </Dialog>
  );
}

export function PrivacyPage() {
  const data = useLoad(async () => {
    const [privacy, sources] = await Promise.all([run("privacy_get", {}), run("sources_list", {})]);
    return { privacy, sources: sources.sources.map((s) => ({ id: s.id, label: s.label })) };
  });
  const { busy, error, act } = useAct();
  const [saved, setSaved] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const p = data.data?.privacy;

  const change = (patch: In<"privacy_set">) =>
    act(async () => {
      setSaved(false);
      const out = await run("privacy_set", patch);
      data.setData((cur) => (cur ? { ...cur, privacy: out } : cur));
      setSaved(true);
    });

  return (
    <section className="app-page" aria-label="Privacy">
      <PageHead title="Privacy" lede="Observer keeps message text only as long as it needs it. People in your sources did not agree to this: check your duty to inform them." />
      <Failure message={error} />
      {data.error ? <LoadFailed message={data.error} retrying={data.loading} onRetry={() => void data.reload()} /> : null}
      {saved ? (
        <Notice tone="live" role="status">
          Saved.
        </Notice>
      ) : null}
      {p === undefined ? (
        data.error ? null : (
          <p className="tb-soft" role="status">
            Loading the settings.
          </p>
        )
      ) : (
        <div className="cards">
          <article className="tb-card">
            <h3>Keep message text</h3>
            <Field label="After delivery or drop" hint="Then Observer deletes the text and keeps only ids and dates, for duplicate checks.">
              <Select value={String(p.textRetentionDays)} disabled={busy} options={options(TEXT_DAYS, p.textRetentionDays)} onValueChange={(v) => void change({ textRetentionDays: Number(v) })} />
            </Field>
            <Field label="While a record waits in Review" hint="Then the record is dropped.">
              <Select value={String(p.reviewRetentionDays)} disabled={busy} options={options(REVIEW_DAYS, p.reviewRetentionDays)} onValueChange={(v) => void change({ reviewRetentionDays: Number(v) })} />
            </Field>
          </article>
          <article className="tb-card">
            <h3>Deleted in the source</h3>
            <Switch label="Delete Observer’s copy at once" checked={p.onSourceDelete === "purge"} disabled={busy} onCheckedChange={(on) => void change({ onSourceDelete: on ? "purge" : "keep" })} />
            <p className="tb-hint">A Knowledge document made from it gets the tag “source-deleted” and an item in Operator Inbox. Observer never deletes in Knowledge itself.</p>
          </article>
          <article className="tb-card">
            <h3>Delete now</h3>
            <p className="tb-soft">Delete all stored text of one source, or everything sent before a date.</p>
            <div className="tb-ctas">
              <Button variant="danger" onClick={() => setDeleting(true)} disabled={busy}>
                Delete stored text…
              </Button>
            </div>
          </article>
          <article className="tb-card">
            <h3>Backups and exports</h3>
            <p className="tb-soft">Backups (kept for 3 nights) and exports contain the text that is still inside its retention time. Text you delete here is gone from the next backup.</p>
          </article>
        </div>
      )}
      <DeleteNow open={deleting} sources={data.data?.sources ?? []} onClose={() => setDeleting(false)} />
    </section>
  );
}
