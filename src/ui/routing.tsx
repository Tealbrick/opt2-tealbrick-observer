// Routing: the ordered rules. The first matching rule decides; no match sends the record to Review. Rule 0 is locked and first.
// Mockup: build-app-observer.ts.
import { AppIcon, Button, Choices, Dialog, EmptyState, Field, Notice, Select, Swatch, Switch, Tag, Textarea, TextInput } from "@opt2-tealbrick/ui";
import { useState } from "react";
import { asRule, classLabel, DESTINATIONS, destinationName, PII_CHOICES, type Rule, type RuleAction, type RuleMatch, run } from "./api.ts";
import { Check, Failure, LoadFailed, PageHead, RequiredApps, useAct, useLoad } from "./common.tsx";
import { actionPhrase, isRuleZero, matchPhrase, RULE_ZERO_TEXT, RULE_ZERO_TITLE } from "./rules.ts";

const lines = (text: string): string[] => [...new Set(text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))];

interface Form {
  sources: string[];
  words: string;
  senders: string;
  pii: string[];
  actionable: "any" | "yes" | "no";
  minWords: string;
  deliver: RuleAction["deliver"];
  area: string;
  project: string;
  assignee: string;
  priority: string;
  redact: boolean;
  status: "draft" | "published";
}
const formOf = (rule: Rule | null, firstFree: RuleAction["deliver"]): Form => ({
  sources: rule?.match.sources ?? [],
  words: (rule?.match.words ?? []).join("\n"),
  senders: (rule?.match.senders ?? []).join("\n"),
  pii: rule?.match.pii ?? [],
  actionable: rule?.match.actionable === undefined ? "any" : rule.match.actionable ? "yes" : "no",
  minWords: rule?.match.minWords ? String(rule.match.minWords) : "",
  deliver: rule?.action.deliver ?? firstFree,
  area: rule?.action.area ?? "",
  project: rule?.action.project ?? "",
  assignee: rule?.action.assignee ?? "",
  priority: rule?.action.priority ?? "",
  redact: rule?.action.redact ?? false,
  status: rule?.action.knowledgeStatus ?? "draft",
});

/** The rule the form describes. Keys the form does not show (for example `conversations`) stay as the rule has them. */
export function ruleOf(f: Form, base: Rule | null): { match: RuleMatch; action: RuleAction } {
  const match: RuleMatch = {};
  if (base?.match.conversations?.length) match.conversations = base.match.conversations;
  if (f.sources.length) match.sources = f.sources;
  const words = lines(f.words);
  if (words.length) match.words = words;
  const senders = lines(f.senders);
  if (senders.length) match.senders = senders;
  if (f.pii.length) match.pii = f.pii;
  if (f.actionable !== "any") match.actionable = f.actionable === "yes";
  const min = Number.parseInt(f.minWords, 10);
  if (Number.isFinite(min) && min > 0) match.minWords = min;
  const action: RuleAction = { deliver: f.deliver };
  if (f.deliver !== "drop") {
    action.redact = f.redact;
    if (f.deliver === "knowledge") {
      if (f.area.trim()) action.area = f.area.trim();
      action.knowledgeStatus = f.status;
    }
    if (f.deliver === "kanban") {
      if (f.project.trim()) action.project = f.project.trim();
      if (f.assignee.trim()) action.assignee = f.assignee.trim();
    }
    if ((f.deliver === "kanban" || f.deliver === "inbox") && f.priority) action.priority = f.priority as RuleAction["priority"];
  }
  return { match, action };
}

/** Mounted when the dialog opens, so the form always starts from the rule it was opened for. */
function RuleDialog({ rule, rules, sources, targets, onClose, onSaved }: { rule: Rule | "new"; rules: Rule[]; sources: { id: string; label: string }[]; targets: readonly string[]; onClose: () => void; onSaved: () => void }) {
  const base = rule === "new" ? null : rule;
  const firstFree = (DESTINATIONS.find((d) => targets.includes(d.id))?.id ?? "drop") as RuleAction["deliver"];
  const [f, setF] = useState<Form>(() => formOf(base, firstFree));
  const { busy, error, act } = useAct();
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((cur) => ({ ...cur, [k]: v }));
  const toggle = (k: "sources" | "pii", id: string, on: boolean) => setF((cur) => ({ ...cur, [k]: on ? [...cur[k], id] : cur[k].filter((x) => x !== id) }));
  const available = (d: string) => d === "drop" || targets.includes(d) || (base?.action.deliver === d && f.deliver === d);

  const save = () =>
    act(async () => {
      const { match, action } = ruleOf(f, base);
      await run("rule_put", { ...(base ? { id: base.id } : {}), position: base ? base.position : rules.length, match, action });
      onSaved();
      onClose();
    });

  const conditions = Object.keys(ruleOf(f, base).match).length;
  return (
    <Dialog
      open
      title={base ? "Change the rule" : "New rule"}
      kicker={base ? `Rule ${base.position}` : "Routing"}
      size="lg"
      busy={busy}
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={() => void save()} disabled={busy || !available(f.deliver)}>
          {base ? "Save the rule" : "Add the rule"}
        </Button>
      }
    >
      <Failure message={error} />
      <div className="tb-stack">
        <h3>A record matches when all of this is true</h3>
        {conditions === 0 ? <Notice tone="neutral">With no condition the rule matches every record that no earlier rule decided.</Notice> : null}
        {sources.length > 0 ? (
          <div className="tb-stack">
            <span className="tb-label">Records from these sources (none ticked: any source)</span>
            <div className="tb-checks">
              {sources.map((s) => (
                <Check key={s.id} checked={f.sources.includes(s.id)} onChange={(on) => toggle("sources", s.id, on)} title={s.label} />
              ))}
            </div>
          </div>
        ) : null}
        <Field label="Mention any of these words" hint="One word or phrase per line. A whole word, or a stem with * at the end (invoice*). At least 3 letters before the *.">
          <Textarea rows={3} value={f.words} onChange={(e) => set("words", e.target.value)} />
        </Field>
        <Field label="Written by" hint="One address or handle per line. Empty: anyone.">
          <Textarea rows={2} value={f.senders} onChange={(e) => set("senders", e.target.value)} />
        </Field>
        <div className="tb-stack">
          <span className="tb-label">Contain personal data of these kinds (none ticked: any)</span>
          <div className="tb-checks">
            {PII_CHOICES.map((c) => (
              <Check key={c} checked={f.pii.includes(c)} onChange={(on) => toggle("pii", c, on)} title={classLabel(c)} />
            ))}
          </div>
        </div>
        <Field label="Ask for an action">
          <Select
            value={f.actionable}
            onValueChange={(v) => set("actionable", v as Form["actionable"])}
            options={[
              { value: "any", label: "Does not matter" },
              { value: "yes", label: "Asks for an action" },
              { value: "no", label: "Asks for no action" },
            ]}
          />
        </Field>
        <Field label="At least this many words" hint="Empty: any length.">
          <TextInput inputMode="numeric" value={f.minWords} onChange={(e) => set("minWords", e.target.value.replace(/[^0-9]/g, ""))} />
        </Field>

        <h3>Then</h3>
        <Choices
          label="Deliver to"
          value={f.deliver}
          onChange={(v) => set("deliver", v)}
          options={[
            ...DESTINATIONS.map((d) => ({ value: d.id as RuleAction["deliver"], title: d.name, disabled: !available(d.id), ...(available(d.id) ? {} : { note: "Not available now." }) })),
            { value: "drop" as const, title: "Drop", body: "Keep no text." },
          ]}
        />
        {f.deliver === "knowledge" ? (
          <>
            <Field label="Knowledge area" hint="Optional. Empty: Observer’s own area.">
              <TextInput value={f.area} maxLength={64} onChange={(e) => set("area", e.target.value)} />
            </Field>
            <Field label="Documents arrive as">
              <Select
                value={f.status}
                onValueChange={(v) => set("status", v as Form["status"])}
                options={[
                  { value: "draft", label: "Drafts" },
                  { value: "published", label: "Published documents" },
                ]}
              />
            </Field>
          </>
        ) : null}
        {f.deliver === "kanban" ? (
          <>
            <Field label="Task Board project" hint="Optional.">
              <TextInput value={f.project} maxLength={64} onChange={(e) => set("project", e.target.value)} />
            </Field>
            <Field label="Assign to" hint="Optional.">
              <TextInput value={f.assignee} maxLength={64} onChange={(e) => set("assignee", e.target.value)} />
            </Field>
          </>
        ) : null}
        {f.deliver === "kanban" || f.deliver === "inbox" ? (
          <Field label="Priority">
            <Select
              value={f.priority}
              placeholder="Normal"
              onValueChange={(v) => set("priority", v)}
              options={[
                { value: "low", label: "Low" },
                { value: "medium", label: "Medium" },
                { value: "high", label: "High" },
              ]}
            />
          </Field>
        ) : null}
        {f.deliver !== "drop" ? (
          <>
            <Switch label="Replace personal data with labels before delivering" checked={f.redact} onCheckedChange={(on) => set("redact", on)} />
            <p className="tb-hint">Off: a record with personal data waits in Review instead of being delivered. A record with a possible secret always waits in Review.</p>
          </>
        ) : null}
      </div>
    </Dialog>
  );
}

/** Where delivered documents go: the Knowledge area the owner picked, or Knowledge's shared company area (delivery_target_get/set). */
export function DeliveryTarget() {
  const data = useLoad(async () => run("delivery_target_get", {}));
  const { busy, error, act } = useAct();
  const d = data.data;
  const DEFAULT = "";
  const pick = (value: string) =>
    act(async () => {
      await run("delivery_target_set", { area: value === DEFAULT ? null : value });
      await data.reload();
    });
  const name = (id: string | null) => (id === null ? "none" : (d?.areas.find((a) => a.id === id)?.label ?? id));
  return (
    <section className="tb-card tb-stack" aria-label="Delivery target">
      <h3>Delivery target</h3>
      {data.error ? <LoadFailed message={data.error} retrying={data.loading} onRetry={() => void data.reload()} /> : null}
      <Failure message={error} />
      {d === null ? null : d.knowledgeMissing ? (
        <p className="tb-soft">Knowledge is not available to Observer now. Records you approve wait in Activity until it is.</p>
      ) : (
        <>
          <p className="tb-soft">
            Approved records go to Knowledge, area <strong>{name(d.effectiveArea)}</strong>
            {d.area === null ? " (the shared company area, the default)" : ""}. A document Observer delivered before stays where it is and is updated there.
          </p>
          {d.error ? <p className="tb-hint">{d.error}</p> : null}
          {d.areas.length > 0 ? (
            <Field label="Knowledge area" hint="Observer can write only where Knowledge lets it. An area marked read only refuses the documents.">
              <Select
                value={d.area ?? DEFAULT}
                disabled={busy}
                onValueChange={(v) => void pick(v)}
                options={[
                  { value: DEFAULT, label: "Company area (default)" },
                  ...d.areas.map((a) => ({ value: a.id, label: `${a.label}${a.access === "read" ? " (read only for Observer)" : ""}` })),
                ]}
              />
            </Field>
          ) : null}
          <span className="meta">
            Deliveries: {d.counts.sent} sent, {d.counts.pending} waiting, {d.counts.held} held for approval, {d.counts.failed} failed. See Activity.
          </span>
        </>
      )}
    </section>
  );
}

export function RoutingPage() {
  const data = useLoad(async () => {
    const [rules, sources] = await Promise.all([run("rules_list", {}), run("sources_list", {})]);
    return { rules: rules.rules.map(asRule), targets: rules.targets, sources: sources.sources.map((s) => ({ id: s.id, label: s.label })) };
  });
  const { busy, error, act } = useAct();
  const [editing, setEditing] = useState<Rule | "new" | null>(null);
  const [deleting, setDeleting] = useState<Rule | null>(null);
  const d = data.data;
  const labels = new Map((d?.sources ?? []).map((s) => [s.id, s.label] as const));

  const move = (index: number, by: -1 | 1) =>
    act(async () => {
      if (!d) return;
      const ids = d.rules.map((r) => r.id);
      const [moved] = ids.splice(index, 1);
      if (moved === undefined) return;
      ids.splice(index + by, 0, moved);
      await run("rules_reorder", { ids });
      await data.reload();
    });
  const remove = () =>
    act(async () => {
      if (!deleting) return;
      await run("rule_delete", { id: deleting.id });
      setDeleting(null);
      await data.reload();
    });
  const open = (rule: Rule | "new") => setEditing(rule);

  return (
    <section className="app-page" aria-label="Routing">
      <PageHead title="Routing" lede="The first matching rule decides where a record goes. No match: the record waits in Review. Personal data always waits in Review unless a rule says to deliver it redacted.">
        <Button variant="primary" onClick={() => open("new")} disabled={d === null}>
          New rule
        </Button>
      </PageHead>
      <RequiredApps targets={d?.targets ?? null} />
      <DeliveryTarget />
      <Failure message={deleting ? null : error} />
      {data.error ? <LoadFailed message={data.error} retrying={data.loading} onRetry={() => void data.reload()} /> : null}
      {d === null ? (
        data.error ? null : (
          <p className="tb-soft" role="status">
            Loading the rules.
          </p>
        )
      ) : d.rules.length === 0 ? (
        <EmptyState title="No rules">Rule 0 is missing. Reload the page; Observer makes it at start.</EmptyState>
      ) : (
        <section className="ruled" aria-label="Rules">
          {d.rules.map((r, i) => {
            const zero = isRuleZero(r);
            const missing = r.action.deliver !== "drop" && !d.targets.includes(r.action.deliver);
            return (
              <div className="item" key={r.id}>
                <Swatch className={zero ? "is-needs-you" : undefined} />
                <h3>
                  {r.position}. {zero ? RULE_ZERO_TITLE : r.action.deliver === "drop" ? "Drop" : `To ${destinationName(r.action.deliver)}`} {zero ? <Tag status="needs-you">locked</Tag> : null}
                </h3>
                <p>
                  {zero ? (
                    RULE_ZERO_TEXT
                  ) : (
                    <>
                      {matchPhrase(r.match, labels)} →{" "}
                      {r.action.deliver !== "drop" ? (
                        <>
                          <AppIcon name={destinationName(r.action.deliver)} size={16} />{" "}
                        </>
                      ) : null}
                      {actionPhrase(r.action)}
                    </>
                  )}
                </p>
                {zero ? <span className="meta">Always runs first. It cannot be changed, moved or deleted.</span> : missing ? <span className="meta">{destinationName(r.action.deliver)} is not available now: matching records wait in Review.</span> : null}
                {zero ? null : (
                  <div className="side">
                    <Button size="sm" aria-label={`Move rule ${r.position} up`} disabled={busy || i <= 1} onClick={() => void move(i, -1)}>
                      Up
                    </Button>
                    <Button size="sm" aria-label={`Move rule ${r.position} down`} disabled={busy || i >= d.rules.length - 1} onClick={() => void move(i, 1)}>
                      Down
                    </Button>
                    <Button size="sm" disabled={busy} onClick={() => open(r)}>
                      Edit
                    </Button>
                    <Button size="sm" variant="danger" disabled={busy} onClick={() => setDeleting(r)}>
                      Delete
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </section>
      )}
      {d && editing ? <RuleDialog rule={editing} rules={d.rules} sources={d.sources} targets={d.targets} onClose={() => setEditing(null)} onSaved={() => void data.reload()} /> : null}
      <Dialog
        open={deleting !== null}
        title="Delete this rule?"
        kicker={deleting ? `Rule ${deleting.position}` : undefined}
        busy={busy}
        onClose={() => setDeleting(null)}
        footer={
          <>
            <Button onClick={() => setDeleting(null)} disabled={busy}>
              Keep it
            </Button>
            <Button variant="danger" confirm onClick={() => void remove()} disabled={busy}>
              Delete the rule
            </Button>
          </>
        }
      >
        <Failure message={error} />
        <p className="tb-soft">Records that matched it will match the next rule, or wait in Review. Records already delivered stay where they are.</p>
      </Dialog>
    </section>
  );
}
