// Settings: what Observer is connected to (Connect and Knowledge are required, Task Board and Operator Inbox are optional) and the plain
// words about what it does with secrets and personal data. Nothing here is edited: the owner's choices live on Routing and Privacy.
import { Notice, Tag } from "@opt2-tealbrick/ui";
import { destinationName, run } from "./api.ts";
import { LoadFailed, PageHead, RequiredApps, useLoad } from "./common.tsx";
import { CONNECT_MISSING } from "./sources.tsx";

const APPS = [
  { id: "connect", name: "Connect", required: true, why: "Observer reads your sources through Connect, with read access only." },
  { id: "knowledge", name: "Knowledge", required: true, why: "When delivery starts, approved records become Knowledge documents, as drafts unless a rule says published." },
  { id: "kanban", name: destinationName("kanban"), required: false, why: "When delivery starts, requests found in your sources become issues in Observer’s project." },
  { id: "inbox", name: destinationName("inbox"), required: false, why: "When delivery starts, Observer tells you when records wait for review." },
] as const;

export function SettingsPage() {
  const data = useLoad(async () => {
    const out = await run("sources_available", {});
    return { targets: out.targets, connectMissing: out.connectMissing };
  });
  const d = data.data;
  return (
    <section className="app-page" aria-label="Settings">
      <PageHead title="Settings" lede="What Observer is connected to, and what it does with secrets and personal data." />
      {data.error ? <LoadFailed message={data.error} retrying={data.loading} onRetry={() => void data.reload()} /> : null}
      <Notice tone="neutral" role="status">
        Delivery to Knowledge, Task Board and Inbox starts in a later version.
      </Notice>
      <RequiredApps targets={d?.targets ?? null} />
      <div className="cards">
        <article className="tb-card" aria-label="Connected apps">
          <h3>Connected apps</h3>
          <ul className="ob-apps">
            {APPS.map((a) => {
              const there = d?.targets.includes(a.id) ?? false;
              return (
                <li key={a.id}>
                  <div className="tb-row">
                    <strong>{a.name}</strong>
                    <Tag>{a.required ? "required" : "optional"}</Tag>
                    {d === null ? null : there ? <Tag status="live">available</Tag> : <Tag status={a.required ? "needs-you" : "idle"}>not available</Tag>}
                  </div>
                  <span className="tb-hint">{a.why}</span>
                </li>
              );
            })}
          </ul>
          {d?.connectMissing ? <p className="tb-hint">{CONNECT_MISSING}</p> : null}
        </article>
        <article className="tb-card" aria-label="Secrets">
          <h3>Secrets</h3>
          <p className="tb-soft">Observer removes the secrets it recognises and holds possible secrets for your review.</p>
          <p className="tb-hint">It is not a complete secret scanner. A secret in a form nobody wrote a pattern for can get through. A record that held a recognised secret can only be dropped. A record with a token that merely looks like a secret waits in Review, and is never delivered before you have read it.</p>
        </article>
        <article className="tb-card" aria-label="Personal data">
          <h3>Personal data</h3>
          <p className="tb-soft">Observer marks email addresses, phone numbers, bank accounts, payment cards, government ids, addresses and special-category words. Without a rule that says “deliver redacted”, a record with any of them waits in Review.</p>
          <p className="tb-hint">Marking is automatic and has no model. Addresses are the least certain. Check the text before you deliver it.</p>
        </article>
        <article className="tb-card" aria-label="Read-only">
          <h3>Read-only</h3>
          <p className="tb-soft">Observer never sends, edits or deletes anything in a source. Message text is untrusted: Observer never follows instructions written in it.</p>
        </article>
      </div>
    </section>
  );
}
