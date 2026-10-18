// "Add source" StepFlow (C126): 1-Account, 2-Conversations (and who is never read), 3-Details, 4-History. The source is made on
// Next of step 3 (source_add), with its live job paused: nothing is read until the owner presses Start live (DESIGN §3.2).
import { Choices, Field, Notice, Select, StepFlow, Textarea, TextInput } from "@opt2-tealbrick/ui";
import { useState } from "react";
import { type ConnectAccount, count, everyLabel, keptSentence, kindName, plural, run } from "./api.ts";
import { Check, Failure, useAct } from "./common.tsx";
import { HistoryFields, useHistory } from "./history.tsx";

/** One address, handle or domain per line: "@example.com" and "example.com" are domains, anything with a name before the @ is a sender. */
export function parseExclude(text: string): { senders: string[]; domains: string[] } {
  const senders: string[] = [];
  const domains: string[] = [];
  for (const raw of text.split(/\r?\n|,/)) {
    const v = raw.trim();
    if (!v) continue;
    if (v.startsWith("@")) domains.push(v.slice(1));
    else if (!v.includes("@") && v.includes(".") && !v.includes(":")) domains.push(v);
    else senders.push(v);
  }
  return { senders: [...new Set(senders)], domains: [...new Set(domains)] };
}

const INTERVALS = [15, 30, 60, 120, 300, 900, 3600];
const RETENTION = ["", "1", "7", "30", "90", "365"];

function Flow({ accounts, onClose, onDone }: { accounts: ConnectAccount[]; onClose: () => void; onDone: () => void }) {
  const [accountId, setAccountId] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [never, setNever] = useState("");
  const [label, setLabel] = useState("");
  const [every, setEvery] = useState("60");
  const [retention, setRetention] = useState("");
  const [created, setCreated] = useState<{ id: string } | null>(null);
  const make = useAct();
  const account = accounts.find((a) => a.id === accountId) ?? null;
  const history = useHistory(created?.id ?? null);
  // every source can read history: with `history` from Connect's catalog it reaches back further, without it Observer reads
  // what Connect kept (kinds and capabilities come from Connect, not from a list of services)
  const canHistory = account !== null;

  const chooseAccount = (id: string) => {
    setAccountId(id);
    setPicked([]);
    setLabel(accounts.find((a) => a.id === id)?.label ?? "");
  };
  const toggle = (id: string, on: boolean) => setPicked((p) => (on ? [...p, id] : p.filter((x) => x !== id)));

  const addSource = () =>
    make.act(async () => {
      if (created || !account) return;
      const exclude = parseExclude(never);
      const out = await run("source_add", {
        account: account.id,
        conversations: picked,
        label: label.trim(),
        ...(exclude.senders.length || exclude.domains.length ? { exclude } : {}),
        liveIntervalS: Number(every),
        ...(retention ? { retentionDays: Number(retention) } : {}),
      });
      setCreated({ id: out.source.id });
      onDone();
    });

  return (
    <StepFlow
      open
      title="Add source"
      kicker="Observer"
      size="lg"
      onClose={onClose}
      onFinish={() => {
        onDone();
        onClose();
      }}
      busy={make.busy || history.busy}
      steps={[
        {
          name: "Account",
          canNext: account !== null,
          render: () => (
            <div className="tb-stack">
              <h3>Which account should Observer read?</h3>
              <p className="tb-soft">Only accounts you shared with Observer in Connect appear here. Sharing is read-only.</p>
              {accounts.length === 0 ? (
                <p className="tb-soft">No account is shared with Observer yet.</p>
              ) : (
                <Choices
                  label="Account"
                  value={accountId}
                  onChange={chooseAccount}
                  options={accounts.map((a) => ({ value: a.id, title: a.label, body: `${kindName(a.kind)} · ${plural(a.conversations.length, "conversation")}`, ...(a.historyCapable ? {} : { note: keptSentence(a.retentionDays) }) }))}
                />
              )}
            </div>
          ),
        },
        {
          name: "Conversations",
          canNext: picked.length > 0,
          render: () => (
            <div className="tb-stack">
              <h3>Which conversations may Observer read?</h3>
              <p className="tb-soft">Choose labels or channels, not everything. A whole mailbox includes private mail.</p>
              <div className="tb-checks">
                {(account?.conversations ?? []).map((c) => (
                  <Check key={c.id} checked={picked.includes(c.id)} onChange={(on) => toggle(c.id, on)} title={c.title} body={c.estimate === null ? "Connect cannot tell how many messages." : `About ${count(c.estimate)} messages.`} />
                ))}
              </div>
              <Field label="Never read messages from" hint="One address, handle or domain per line, for example doctor@clinic.example or @family.example. Their messages are never stored.">
                <Textarea rows={3} value={never} onChange={(e) => setNever(e.target.value)} />
              </Field>
            </div>
          ),
        },
        {
          name: "Details",
          nextLabel: "Add source",
          canNext: label.trim().length > 0,
          onNext: addSource,
          render: () => (
            <div className="tb-stack">
              <Failure message={make.error} />
              <h3>How should Observer watch it?</h3>
              <Field label="Name">
                <TextInput value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} />
              </Field>
              <Field label="Look for new messages every" hint="Live watching stays off until you press Start live on the source.">
                <Select value={every} onValueChange={setEvery} options={INTERVALS.map((s) => ({ value: String(s), label: everyLabel(s) }))} />
              </Field>
              <Field label="Keep message text" hint="After a record is delivered or dropped. Empty: the setting on the Privacy page.">
                <Select value={retention} onValueChange={setRetention} options={RETENTION.map((d) => ({ value: d, label: d === "" ? "As on the Privacy page" : d === "1" ? "1 day" : `${d} days` }))} />
              </Field>
              <Notice tone="neutral">People in this source did not agree to this. Check your duty to inform them.</Notice>
            </div>
          ),
        },
        {
          name: "History",
          nextLabel: canHistory ? "Read history" : "Done",
          optional: canHistory ? "Skip, no history" : false,
          canNext: canHistory ? history.valid : true,
          onNext: canHistory ? () => history.start() : undefined,
          render: () => (
            <div className="tb-stack">
              <Failure message={history.error} />
              <h3>Should Observer read older messages?</h3>
              <p className="tb-soft">The source is added. Live watching is off until you press Start live on the source.</p>
              {account && !account.historyCapable ? <p className="tb-soft">{keptSentence(account.retentionDays)}</p> : null}
              {canHistory ? <HistoryFields h={history} keptDays={account?.historyCapable === false ? account.retentionDays : undefined} /> : null}
            </div>
          ),
        },
      ]}
    />
  );
}

export function AddSource({ open, accounts, onClose, onDone }: { open: boolean; accounts: ConnectAccount[]; onClose: () => void; onDone: () => void }) {
  return open ? <Flow accounts={accounts} onClose={onClose} onDone={onDone} /> : null;
}
