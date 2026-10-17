// Sources (launch page): the sources Observer reads, each with a Live and a History job, the add-source StepFlow and the
// honest state while Connect gives Observer no data access (R3, SDK-CALLER-PRODUCT). Mockup: build-app-observer.ts.
import { Button, Dialog, EmptyState, Notice, Progress, Tag } from "@opt2-tealbrick/ui";
import { useState } from "react";
import { AddSource } from "./addsource.tsx";
import { asAccount, count, dateOf, type Job, kindName, plural, run, type Source, until } from "./api.ts";
import { ConfirmButton, Failure, LoadFailed, PageHead, RequiredApps, useAct, useLoad } from "./common.tsx";
import { HistoryDialog } from "./history.tsx";

/** The sentence the owner reads while Connect cannot be used (the agreed wording). */
export const CONNECT_MISSING = "Connect does not give Observer data access yet. Sources start when it does.";

type Tone = "live" | "busy" | "needs-you" | "idle";
function liveStatus(job: Job | undefined, source: Source): { tone: Tone; text: string; hint: string } {
  const state = job?.state ?? source.live.state;
  const retry = job?.retryAt ?? source.live.nextAt;
  switch (state) {
    case "running":
      return { tone: "live", text: "Watching", hint: source.live.lastReadAt ? `last read ${until(source.live.lastReadAt)}` : "reading new messages" };
    case "queued":
      return { tone: "busy", text: "Starting", hint: "waits for the next read" };
    case "waiting":
      return { tone: "busy", text: "Waiting", hint: retry ? `retry ${until(retry)}` : "retrying soon" };
    case "paused":
      return { tone: "idle", text: "Paused", hint: "press Start live to begin" };
    case "failed":
      return { tone: "needs-you", text: "Stopped", hint: job?.lastError ? "failed after repeated tries" : "stopped after repeated failures" };
    case "cancelled":
    case "done":
      return { tone: "idle", text: "Stopped", hint: "this job is over" };
    default:
      return { tone: "idle", text: "Not started", hint: "no live job" };
  }
}

const HISTORY_STATE: Record<string, string> = { queued: "queued", running: "reading", waiting: "waiting to retry", paused: "paused", failed: "stopped after failures", cancelled: "stopped", done: "done" };

function History({ source, job }: { source: Source; job: Job | undefined }) {
  if (!job) {
    return source.kind === "telegram" ? (
      <span className="tb-hint">No history: Telegram bots see only messages sent after they join.</span>
    ) : (
      <span className="tb-hint">History is not read. Observer reads only new messages.</span>
    );
  }
  const done = source.history.done;
  const total = source.history.total;
  const since = source.history.since ? ` · since ${dateOf(source.history.since)}` : "";
  const state = HISTORY_STATE[job.state] ?? job.state;
  const pct = job.state === "done" ? 100 : total && total > 0 ? Math.min(100, Math.round((done / total) * 100)) : undefined;
  const text = job.state === "done" ? `History: done · ${count(done)} messages${since}` : `History: ${count(done)}${total ? ` of up to ${count(total)}` : ""} messages${since} · ${state}`;
  return (
    <div className="ob-prog">
      <Progress value={pct} label={text} />
      <span className="meta">{text}</span>
    </div>
  );
}

function SourceCard({ source, jobs, busy, onJob, onHistory, onRemove }: { source: Source; jobs: Job[]; busy: boolean; onJob: (job: Job, action: "pause" | "resume" | "cancel" | "start") => void; onHistory: (s: Source) => void; onRemove: (s: Source) => void }) {
  const live = jobs.find((j) => j.kind === "live");
  const hist = jobs.find((j) => j.kind === "backfill");
  const l = liveStatus(live, source);
  const histActive = hist && ["queued", "running", "waiting"].includes(hist.state);
  return (
    <article className="tb-card ob-src" aria-label={source.label}>
      <div className="ob-src-head">
        <span className="ob-svc" aria-hidden="true">
          {kindName(source.kind).charAt(0)}
        </span>
        <div className="tb-stack ob-head">
          <h3>{source.label}</h3>
          <span className="meta">
            {kindName(source.kind)} · {plural(source.conversations.length, "conversation")}
          </span>
        </div>
      </div>
      <dl className="kv">
        <dt>Live</dt>
        <dd>
          <Tag status={l.tone}>{l.text}</Tag> <span className="tb-hint">{l.hint}</span>
        </dd>
        <dt>History</dt>
        <dd>
          <History source={source} job={hist} />
        </dd>
      </dl>
      {live?.state === "failed" && live.lastError ? <p className="tb-hint">Last error: {live.lastError}</p> : null}
      <div className="tb-ctas">
        {live && ["running", "queued", "waiting"].includes(live.state) ? (
          <Button size="sm" disabled={busy} onClick={() => onJob(live, "pause")}>
            Pause live
          </Button>
        ) : null}
        {live?.state === "paused" ? (
          <Button size="sm" variant="primary" disabled={busy} onClick={() => onJob(live, "start")}>
            Start live
          </Button>
        ) : null}
        {live?.state === "failed" ? (
          <Button size="sm" variant="primary" disabled={busy} onClick={() => onJob(live, "resume")}>
            Try live again
          </Button>
        ) : null}
        {histActive ? (
          <Button size="sm" disabled={busy} onClick={() => hist && onJob(hist, "pause")}>
            Pause history
          </Button>
        ) : null}
        {hist?.state === "paused" ? (
          <Button size="sm" variant="primary" disabled={busy} onClick={() => onJob(hist, "resume")}>
            Resume history
          </Button>
        ) : null}
        {hist?.state === "failed" ? (
          <Button size="sm" variant="primary" disabled={busy} onClick={() => onJob(hist, "resume")}>
            Try history again
          </Button>
        ) : null}
        {hist && ["queued", "running", "waiting", "paused"].includes(hist.state) ? <ConfirmButton label="Stop history" confirmLabel="Confirm: stop history" disabled={busy} onConfirm={() => onJob(hist, "cancel")} /> : null}
        {(!hist || hist.state === "cancelled" || hist.state === "done") && source.kind !== "telegram" ? (
          <Button size="sm" disabled={busy} onClick={() => onHistory(source)}>
            Read history…
          </Button>
        ) : null}
        <Button size="sm" variant="danger" disabled={busy} onClick={() => onRemove(source)}>
          Remove
        </Button>
      </div>
    </article>
  );
}

export function SourcesPage() {
  const sources = useLoad(async () => {
    const [list, jobs, avail] = await Promise.all([run("sources_list", {}), run("jobs_list", {}), run("sources_available", {})]);
    return { sources: list.sources as Source[], jobs: jobs.jobs, connectMissing: avail.connectMissing, targets: avail.targets, accounts: avail.accounts.map(asAccount) };
  });
  const { busy, error, act } = useAct();
  const [adding, setAdding] = useState(false);
  const [history, setHistory] = useState<Source | null>(null);
  const [removing, setRemoving] = useState<Source | null>(null);
  const d = sources.data;

  const control = (job: Job, action: "pause" | "resume" | "cancel" | "start") =>
    act(async () => {
      try {
        await run("job_control", { id: job.id, action });
      } catch (e) {
        // a paused job that nobody paused is started; one that somebody paused is resumed. The list does not say which, so try start, then resume.
        if (action === "start" && (e as { code?: unknown } | null)?.code === "job_state_invalid") await run("job_control", { id: job.id, action: "resume" });
        else throw e;
      }
      await sources.reload();
    });

  const remove = () =>
    act(async () => {
      if (!removing) return;
      await run("source_remove", { id: removing.id });
      setRemoving(null);
      await sources.reload();
    });

  const canAdd = d !== null && !d.connectMissing && d.accounts.length > 0;
  return (
    <section className="app-page" aria-label="Sources">
      <PageHead title="Sources" lede="Observer reads only the conversations you share with it in Connect. It never sends, edits or deletes anything in a source.">
        <Button variant="primary" onClick={() => setAdding(true)} disabled={!canAdd}>
          Add source
        </Button>
      </PageHead>
      {d?.connectMissing ? (
        <Notice tone="needs-you" role="status">
          <span>
            <strong>Connect does not give Observer data access yet.</strong> Sources start when it does.
          </span>
        </Notice>
      ) : (
        <Notice tone="neutral" role="status">
          <span>
            <strong>Read-only by design.</strong> Observer’s grant on Connect allows reads only. Live watching and history import are separate jobs: pause or resume each one.
          </span>
        </Notice>
      )}
      <RequiredApps targets={d?.targets ?? null} />
      <Failure message={removing ? null : error} />
      {sources.error ? <LoadFailed message={sources.error} retrying={sources.loading} onRetry={() => void sources.reload()} /> : null}
      {d === null ? (
        sources.error ? null : (
          <p className="tb-soft" role="status">
            Loading the sources.
          </p>
        )
      ) : d.sources.length === 0 ? (
        <EmptyState title="No sources yet">{d.connectMissing ? "Nothing is read. Add a source here when Connect shares an account with Observer." : canAdd ? "Add a source to start. Live watching stays off until you press Start." : "Share an account with Observer in Connect, then add it here."}</EmptyState>
      ) : (
        <div className="cards">
          {d.sources.map((s) => (
            <SourceCard key={s.id} source={s} jobs={d.jobs.filter((j) => j.source === s.id)} busy={busy} onJob={(j, a) => void control(j, a)} onHistory={setHistory} onRemove={setRemoving} />
          ))}
        </div>
      )}
      {d ? <AddSource open={adding} accounts={d.accounts} onClose={() => setAdding(false)} onDone={() => void sources.reload()} /> : null}
      <HistoryDialog source={history} onClose={() => setHistory(null)} onStarted={() => void sources.reload()} />
      <Dialog
        open={removing !== null}
        title="Remove this source?"
        kicker={removing?.label}
        busy={busy}
        onClose={() => setRemoving(null)}
        footer={
          <>
            <Button onClick={() => setRemoving(null)} disabled={busy}>
              Keep it
            </Button>
            <Button variant="danger" confirm onClick={() => void remove()} disabled={busy}>
              Remove the source
            </Button>
          </>
        }
      >
        <Failure message={error} />
        <div className="tb-stack">
          <p className="tb-soft">Observer stops reading it and deletes everything it stored for it: messages and their ids, records, the delivery log and the jobs.</p>
          <p className="tb-soft">Documents already delivered to Knowledge stay there. You delete them in Knowledge.</p>
          <p className="tb-hint">Observer never changes the source itself.</p>
        </div>
      </Dialog>
    </section>
  );
}
