// "Add source" StepFlow (C126): 1-Account (and, when the account has both, messages or documents), 2-Conversations or Collections
// (and who is never read), 3-Details, 4-History (messages only: a documents source reads everything of its collections at Start). The source is made on
// Next of step 3 (source_add), with its live job paused: nothing is read until the owner presses Start live (DESIGN §3.2).
import { accessFilter, Choices, Field, ListFilter, Notice, Select, StepFlow, Textarea, TextInput, useAccessFilter } from "@opt2-tealbrick/ui";
import { useState } from "react";
import { asAccount, type ConnectAccount, count, type Dataset, DOCUMENTS_SENTENCE, datasetName, everyLabel, keptSentence, kindName, plural, run, unitName } from "./api.ts";
import { Check, Failure, useAct } from "./common.tsx";
import { CONVERSATIONS_MOST, FILTER_FROM, filterKey } from "./filtering.ts";
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
  const load = useAct();
  // the list names the accounts only; the conversations, history flag and kept days of the picked one come with ONE catalog read
  const [details, setDetails] = useState<ConnectAccount | null>(null);
  const account = details && details.id === accountId ? details : null;
  const history = useHistory(created?.id ?? null);
  // every source can read history: with `history` from Connect's catalog it reaches back further, without it Observer reads
  // what Connect kept (kinds and capabilities come from Connect, not from a list of services)
  const docs = account?.dataset === "documents";
  const canHistory = account !== null && !docs;
  const unit = unitName(account?.dataset ?? "messages");
  const units = unitName(account?.dataset ?? "messages", true);
  // The filter only narrows what the list shows. It never picks anything: a conversation that is picked and hidden stays picked and counted.
  const [find, setFind] = useAccessFilter(filterKey("addsource"));
  const findFilter = accessFilter(find);
  const listed = account?.conversations ?? [];
  const shownConversations = listed.filter((c) => findFilter.test(c.title));
  const hiddenPicked = picked.filter((id) => !shownConversations.some((c) => c.id === id)).length;
  const listCut = listed.length >= CONVERSATIONS_MOST;
  const showFind = listed.length >= FILTER_FROM || listCut || find.trim() !== "";

  const chooseAccount = (id: string, dataset?: Dataset) => {
    setAccountId(id);
    setPicked([]);
    setDetails(null);
    if (dataset === undefined) setLabel(accounts.find((a) => a.id === id)?.label ?? "");
    void load.act(async () => {
      const out = await run("sources_available", { account: id, ...(dataset ? { dataset } : {}) });
      const found = out.accounts.map(asAccount).find((a) => a.id === id);
      if (!found) throw Object.assign(new Error("not shared"), { code: "account_not_shared" });
      setDetails(found);
      // a documents source scans its collections again each time: slower by default, never faster than 5 minutes
      setEvery(found.dataset === "documents" ? "900" : "60");
    });
  };
  const toggle = (id: string, on: boolean) => setPicked((p) => (on ? [...p, id] : p.filter((x) => x !== id)));

  const addSource = () =>
    make.act(async () => {
      if (created || !account) return;
      const exclude = parseExclude(never);
      const out = await run("source_add", {
        account: account.id,
        dataset: account.dataset,
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
                  onChange={(id) => chooseAccount(id)}
                  options={accounts.map((a) => ({ value: a.id, title: a.label, body: kindName(a.kind) }))}
                />
              )}
              <Failure message={load.error} />
              {accountId && !account && !load.error ? (
                <p className="tb-soft" role="status">
                  Reading the account from Connect.
                </p>
              ) : null}
              {account && account.datasets.length > 1 ? (
                <Choices
                  label="What should Observer read?"
                  value={account.dataset}
                  onChange={(d) => chooseAccount(account.id, d as Dataset)}
                  options={account.datasets.map((d) => ({ value: d, title: datasetName(d), body: d === "documents" ? "Files, pages and table pages, one record per document." : "Chat messages, grouped by thread." }))}
                />
              ) : null}
              {account ? (
                <p className="tb-soft" role="status">
                  {plural(account.conversations.length, unit, units)}.{docs ? ` ${DOCUMENTS_SENTENCE}` : account.historyCapable ? "" : ` ${keptSentence(account.retentionDays)}`}
                </p>
              ) : null}
            </div>
          ),
        },
        {
          name: docs ? "Collections" : "Conversations",
          canNext: picked.length > 0,
          render: () => (
            <div className="tb-stack">
              <h3>Which {units} may Observer read?</h3>
              <p className="tb-soft">{docs ? "Choose the folders or tables Observer needs, not everything." : "Choose labels or channels, not everything. A whole mailbox includes private mail."}</p>
              {showFind ? (
                <ListFilter
                  label={`Filter the ${units}`}
                  value={find}
                  onChange={setFind}
                  filter={findFilter}
                  placeholder="Name, or a regex"
                  noun={{ one: unit, many: units }}
                  shown={shownConversations.length}
                  total={listed.length}
                  more={listCut}
                  onClear={() => setFind("")}
                />
              ) : null}
              {picked.length > 0 || hiddenPicked > 0 ? (
                <p className="tb-soft" role="status">
                  {picked.length} chosen{hiddenPicked > 0 ? `, ${hiddenPicked} hidden by the filter` : ""}.
                </p>
              ) : null}
              <div className="tb-checks">
                {shownConversations.map((c) => (
                  <Check
                    key={c.id}
                    checked={picked.includes(c.id)}
                    onChange={(on) => toggle(c.id, on)}
                    title={c.title}
                    body={c.estimate === null ? `Connect cannot tell how many ${docs ? "documents" : "messages"}.` : `About ${count(c.estimate)} ${docs ? "documents" : "messages"}.`}
                  />
                ))}
              </div>
              <Field
                label={docs ? "Never read documents by" : "Never read messages from"}
                hint={`One address, handle or domain per line, for example doctor@clinic.example or @family.example. Their ${docs ? "documents" : "messages"} are never stored.`}
              >
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
              <Field label={docs ? "Look for changes every" : "Look for new messages every"} hint="Live watching stays off until you press Start live on the source.">
                <Select value={every} onValueChange={setEvery} options={INTERVALS.filter((s) => !docs || s >= 300).map((s) => ({ value: String(s), label: everyLabel(s) }))} />
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
              <h3>{docs ? "Ready" : "Should Observer read older messages?"}</h3>
              <p className="tb-soft">The source is added. Live watching is off until you press Start live on the source.</p>
              {docs ? <p className="tb-soft">{DOCUMENTS_SENTENCE}</p> : null}
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
