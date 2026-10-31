// Review: records that wait for the owner (personal data, no matching rule, a possible secret). List + detail with the text and
// the marked spans. Nothing reaches Knowledge, Task Board or Operator Inbox before the owner decides here. Mockup: build-app-observer.ts.
import { accessFilter, Button, EmptyState, Field, ListFilter, Notice, Segmented, Select, Tag, useAccessFilter } from "@opt2-tealbrick/ui";
import { Fragment, useEffect, useMemo, useState } from "react";
import { asRecord, classLabel, DESTINATIONS, destinationName, type Message, REDACTION_LABELS, type RecordDetail, type RecordSummary, type Rule, recordTitle, run, SENSITIVE, stamp } from "./api.ts";
import { Check, ConfirmButton, Failure, LoadFailed, PageHead, RequiredApps, useAct, useLoad } from "./common.tsx";
import { ALL, FILTER_FROM, facetChoices, filterKey } from "./filtering.ts";
import { actionPhrase, matchPhrase } from "./rules.ts";

/** Which class names a merged span when marks overlap: first wins (src/detect/redact.ts PRIORITY). */
const PRIORITY = ["secret", "suspect_secret", "iban", "card", "id", "email", "phone", "name", "address", "special"];

interface Piece {
  text: string;
  cls: string | null;
}
/** The text cut at the spans (merged where they overlap), each marked piece with its class. */
export function pieces(text: string, spans: readonly { class: string; start: number; end: number }[]): Piece[] {
  const sorted = spans
    .map((s) => ({ ...s, start: Math.max(0, s.start), end: Math.min(text.length, s.end) }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: { class: string; start: number; end: number }[] = [];
  for (const s of sorted) {
    const last = merged[merged.length - 1];
    if (last && s.start < last.end) {
      last.end = Math.max(last.end, s.end);
      if (PRIORITY.indexOf(s.class) < PRIORITY.indexOf(last.class)) last.class = s.class;
    } else merged.push({ ...s });
  }
  const out: Piece[] = [];
  let at = 0;
  for (const s of merged) {
    if (s.start > at) out.push({ text: text.slice(at, s.start), cls: null });
    out.push({ text: text.slice(s.start, s.end), cls: s.class });
    at = s.end;
  }
  if (at < text.length) out.push({ text: text.slice(at), cls: null });
  return out;
}

/** One message text: marked spans as they are, or (redacted) each span replaced by the label `deliver_redacted` writes. */
export function Marked({ text, spans, redacted }: { text: string; spans: Message["spans"]; redacted: boolean }) {
  return (
    <>
      {pieces(text, spans).map((p, i) =>
        p.cls === null ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the pieces are positions in one text
          <Fragment key={i}>{p.text}</Fragment>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: the pieces are positions in one text
          <mark key={i} className={p.cls === "suspect_secret" || p.cls === "secret" ? "is-secret" : undefined} title={classLabel(p.cls)}>
            {redacted ? (REDACTION_LABELS[p.cls] ?? `[${p.cls}]`) : p.text}
            {redacted ? null : <span className="ob-sr"> ({classLabel(p.cls)})</span>}
          </mark>
        ),
      )}
    </>
  );
}

/** The fixed sentence for a record Observer could not sort (problem routing_failed). */
export const UNSORTED = "Observer could not sort this record. It is held for you. Its text opens hidden.";
const isUnsorted = (r: Pick<RecordSummary, "problem">): boolean => r.problem === "routing_failed";

/** Tags that say why a record waits. */
/** Why a record waits, as the tags of Reasons show it: one key per tag, so the filter by reason matches what the owner reads. */
export function reasonsOf(r: RecordSummary): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  if (r.possibleSecret) out.push({ value: "possible_secret", label: "possible secret" });
  if (isUnsorted(r)) out.push({ value: "could_not_sort", label: "could not sort" });
  if (r.secret) out.push({ value: "secret_removed", label: "secret removed" });
  const classes = Object.entries(r.pii)
    .filter(([c, n]) => n > 0 && c !== "suspect_secret" && c !== "secret")
    .map(([c]) => c);
  for (const c of classes) out.push({ value: `pii:${c}`, label: classLabel(c) });
  if (out.length === 0) out.push({ value: "no_route", label: "no route" });
  return out;
}

export function Reasons({ r }: { r: RecordSummary }) {
  const classes = Object.entries(r.pii)
    .filter(([c, n]) => n > 0 && c !== "suspect_secret" && c !== "secret")
    .map(([c]) => c);
  return (
    <span className="tb-row ob-tags">
      {r.possibleSecret ? <Tag status="needs-you">possible secret</Tag> : null}
      {isUnsorted(r) ? <Tag status="needs-you">could not sort</Tag> : null}
      {r.secret ? <Tag status="needs-you">secret removed</Tag> : null}
      {classes.map((c) => (
        <Tag key={c} {...(SENSITIVE.has(c) ? { status: "needs-you" as const } : {})}>
          {classLabel(c)}
        </Tag>
      ))}
      {!r.possibleSecret && !isUnsorted(r) && !r.secret && classes.length === 0 ? <Tag>no route</Tag> : null}
    </span>
  );
}

function Detail({ id, sourceLabels, rules, targets, onDecided }: { id: string; sourceLabels: ReadonlyMap<string, string>; rules: Rule[]; targets: readonly string[]; onDecided: (message: string) => void }) {
  const rec = useLoad(async () => (await run("review_get", { id })).record as unknown as RecordDetail, [id]);
  const { busy, error, act } = useAct();
  const [redacted, setRedacted] = useState(false);
  // a possible secret opens redacted; the original is shown only when the owner asks for it
  const [revealed, setRevealed] = useState(false);
  const [readIt, setReadIt] = useState(false);
  const r = rec.data;
  const rule = r?.ruleId ? rules.find((x) => x.id === r.ruleId) : undefined;
  const available = (d: string) => targets.includes(d);
  const [picked, setPicked] = useState<string | null>(null);
  // the owner's pick, else the destination the record's rule names, else the first one that is available
  const ruleWants = rule && rule.action.deliver !== "drop" && available(rule.action.deliver) ? rule.action.deliver : "";
  const destination = picked !== null && available(picked) ? picked : ruleWants || (DESTINATIONS.find((d) => available(d.id))?.id ?? "");

  if (rec.error && !r) return <LoadFailed message={rec.error} retrying={rec.loading} onRetry={() => void rec.reload()} />;
  if (!r) return <p className="tb-soft" role="status">Loading the record.</p>;

  const hasText = r.messages.some((m) => m.text !== null);
  const marked = r.messages.some((m) => m.spans.length > 0);
  const found = Object.entries(r.pii).filter(([, n]) => n > 0);
  // a token that looks like a secret holds the record as a whole. A message with no span that marks it (a token split over messages, a message too big
  // to mark, a hit in the subject or the handle) is redacted as a whole: all of its text becomes [possible secret]
  // a record Observer could not sort has the same safe default with its own words: every message opens hidden
  const unsorted = isUnsorted(r);
  const hidden = r.possibleSecret || unsorted;
  const wholeMessage = (m: RecordDetail["messages"][number]) => unsorted || (r.possibleSecret && !m.spans.some((s) => s.class === "suspect_secret"));
  const heldWhole = r.possibleSecret && r.messages.some((m) => m.text !== null && wholeMessage(m));
  const showRedacted = hidden ? !revealed : redacted;
  // Knowledge is required: without it nothing can be delivered
  const knowledgeMissing = !available("knowledge");
  const canDeliver = hasText && !r.secret && destination !== "" && !knowledgeMissing && !busy;
  // deliver as is of a possible secret needs the tick, and the tick needs the original text on screen
  const canAsIs = canDeliver && (!hidden || (revealed && readIt));

  type Decision = "deliver" | "deliver_redacted" | "drop" | "keep";
  const send = async (decision: Decision) => {
    const toPlace = decision === "deliver" || decision === "deliver_redacted";
    await run("review_decide", {
      recordId: r.id,
      revision: r.revision, // the version the owner read: a newer one is refused (revision_changed)
      decision,
      ...(toPlace ? { destination: destination as "knowledge" | "kanban" | "inbox" } : {}),
      ...(decision === "deliver" && hidden ? { acknowledged: true } : {}),
    });
    onDecided(toPlace ? `Approved for ${destinationName(destination)}${decision === "deliver_redacted" ? ", redacted" : ""}. The Activity page shows the delivery.` : decision === "drop" ? "Dropped. Observer deletes the text after the retention time." : "Kept as delivered.");
  };
  const decide = (decision: Decision) =>
    act(async () => {
      try {
        await send(decision);
      } catch (e) {
        // an edit or a new message landed after the owner read the record: show the new version, take the tick back, say so
        if ((e as { code?: unknown } | null)?.code === "revision_changed") {
          setReadIt(false);
          setRevealed(false);
          await rec.reload();
        }
        throw e;
      }
    });

  return (
    <article className="ob-detail" aria-label="Record">
      <div className="tb-row ob-detail-head">
        <h2>{recordTitle(r, sourceLabels.get(r.source))}</h2>
        <Tag status="busy">waiting for you</Tag>
      </div>
      {r.secret ? (
        <Notice tone="needs-you" role="status">
          <span>
            <strong>A secret was removed from this record.</strong> Observer replaced it before it stored the text. The record can only be dropped.
          </span>
        </Notice>
      ) : null}
      {r.possibleSecret ? (
        <Notice tone="needs-you" role="status">
          <span>
            <strong>Possible secret: held for your review.</strong> A token in this text looks like a key or a password. The text opens redacted. Observer does not deliver the original text until you have shown it, read it and said it is safe.
          </span>
        </Notice>
      ) : null}
      {unsorted ? (
        <Notice tone="needs-you" role="status">
          <span>{UNSORTED}</span>
        </Notice>
      ) : null}
      <dl className="kv">
        <dt>Source</dt>
        <dd>{sourceLabels.get(r.source) ?? "A removed source"}</dd>
        <dt>Route</dt>
        <dd>{hidden ? "Held for your review, whatever the rules say" : rule ? `Rule ${rule.position}: ${matchPhrase(rule.match, sourceLabels)} → ${actionPhrase(rule.action)}` : "No rule matched"}</dd>
        <dt>Found</dt>
        <dd>{found.length === 0 ? "Observer found no personal data (it checks names, contact details, bank and card numbers, ids, addresses and special categories)" : found.map(([c, n]) => `${classLabel(c)} (${n})`).join(", ")}</dd>
        <dt>Messages</dt>
        <dd>
          {r.messages.length}
          {r.windowEnd ? ` · until ${stamp(r.windowEnd)}` : ""}
          {r.revision > 1 ? ` · version ${r.revision}` : ""}
        </dd>
        {r.textPurgeAt ? (
          <>
            <dt>Text kept</dt>
            <dd>until {stamp(r.textPurgeAt)}</dd>
          </>
        ) : null}
      </dl>
      {heldWhole && hasText ? (
        <Notice tone="neutral" role="status">
          <span>
            <strong>This record was held as a whole.</strong> In a message where Observer could not mark the part that looks like a secret, all of the text is redacted. Deliver redacted replaces all of it with [possible secret].
          </span>
        </Notice>
      ) : null}
      {hidden && hasText ? (
        <div className="tb-ctas">
          <Button
            size="sm"
            onClick={() => {
              setRevealed(!revealed);
              setReadIt(false);
            }}
          >
            {revealed ? "Hide the original text" : "Show the original text"}
          </Button>
        </div>
      ) : null}
      {!hidden && marked && hasText ? (
        <Segmented
          label="Show the text"
          value={redacted ? "redacted" : "marked"}
          onChange={(v) => setRedacted(v === "redacted")}
          options={[
            { value: "marked", label: "Marked" },
            { value: "redacted", label: "As delivered, redacted" },
          ]}
        />
      ) : null}
      <div className="ob-msgs">
        {r.messages.length === 0 ? <p>This record has no messages.</p> : null}
        {r.messages.map((m) => (
          <p key={`${m.conversation}:${m.id}`}>
            <b>{m.authorKind === "self" ? "You" : m.author || "Sender hidden"}:</b>{" "}
            {m.text === null ? (
              <em>{m.deleted ? "Deleted in the source." : "The text is gone."}</em>
            ) : wholeMessage(m) && showRedacted ? (
              unsorted ? (
                <mark>[text hidden]</mark>
              ) : (
                <mark className="is-secret">{REDACTION_LABELS.suspect_secret}</mark>
              )
            ) : (
              <Marked text={m.text} spans={m.spans} redacted={showRedacted} />
            )}
          </p>
        ))}
      </div>
      <p className="tb-hint">Marked text is personal data or a possible secret. “Deliver redacted” replaces it with labels such as [email] and [phone]. Message text is untrusted: Observer never follows instructions in it.</p>
      <Failure message={error} />
      {r.secret ? null : !hasText ? (
        <p className="tb-hint">The text of this record is gone, so it can only be dropped.</p>
      ) : (
        <div className="tb-stack">
          {knowledgeMissing ? (
            <Notice tone="needs-you" role="status">
              Knowledge is not available to Observer, so nothing can be delivered now. You can still drop the record.
            </Notice>
          ) : null}
          <div className="ob-dest">
            <span className="tb-label" id="ob-dest-label">
              Deliver to
            </span>
            <Select
              aria-labelledby="ob-dest-label"
              value={destination}
              placeholder="Not available"
              disabled={busy || !DESTINATIONS.some((d) => available(d.id))}
              onValueChange={setPicked}
              options={DESTINATIONS.map((d) => ({ value: d.id, label: d.name, disabled: !available(d.id), ...(available(d.id) ? {} : { meta: "not available" }) }))}
            />
          </div>
          {hidden ? <Check checked={readIt} onChange={setReadIt} disabled={busy || !revealed} title={r.possibleSecret ? "I read the original text above. The marked part is not a secret." : "I read the original text above. It may be delivered as it is."} body={revealed ? "Deliver as is stays off until you tick this. Deliver redacted needs no tick." : "Show the original text first. Deliver redacted needs no tick."} /> : null}
        </div>
      )}
      <div className="tb-ctas">
        {!r.secret && hasText && (marked || r.possibleSecret) ? (
          <Button variant="primary" disabled={!canDeliver} onClick={() => void decide("deliver_redacted")}>
            Deliver redacted
          </Button>
        ) : null}
        {!r.secret && hasText ? (
          <Button variant={marked || r.possibleSecret ? "secondary" : "primary"} disabled={!canAsIs} onClick={() => void decide("deliver")}>
            {marked || r.possibleSecret ? "Deliver as is" : "Deliver"}
          </Button>
        ) : null}
        {!r.secret && hasText && r.revision > 1 ? (
          <Button disabled={busy} onClick={() => void decide("keep")}>
            Keep the delivered version
          </Button>
        ) : null}
        <ConfirmButton size="md" label="Drop" confirmLabel="Confirm: drop" disabled={busy} onConfirm={() => void decide("drop")} />
      </div>
    </article>
  );
}

export function ReviewPage({ recordId, onOpen, hrefOf, onCount }: { recordId: string | null; onOpen: (id: string | null) => void; hrefOf: (id: string) => string; onCount?: (n: number) => void }) {
  const [more, setMore] = useState<RecordSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const ctx = useLoad(async () => {
    const [list, sources, rules] = await Promise.all([run("review_list", {}), run("sources_list", {}), run("rules_list", {})]);
    return { items: list.items.map(asRecord), next: list.nextCursor, labels: new Map(sources.sources.map((s) => [s.id, s.label] as const)), rules: rules.rules as unknown as Rule[], targets: rules.targets };
  });
  const paging = useAct();
  const d = ctx.data;
  // the first page replaces the extra pages (a reload starts again from the top)
  useEffect(() => {
    if (d) {
      setMore([]);
      setCursor(d.next);
    }
  }, [d]);
  const items = useMemo(() => (d ? [...d.items, ...more] : []), [d, more]);
  // The filter by text, source and reason reads the records loaded so far (review_list has no filter, 50 a page): `cursor` says more wait.
  const [query, setQuery] = useAccessFilter(filterKey("review"));
  const [sourceRaw, setSource] = useAccessFilter(filterKey("review:source"));
  const [reasonRaw, setReason] = useAccessFilter(filterKey("review:reason"));
  const source = sourceRaw === ALL ? "" : sourceRaw;
  const reason = reasonRaw === ALL ? "" : reasonRaw;
  const textFilter = accessFilter(query);
  const rows = items.filter(
    (r) =>
      (source === "" || r.source === source) &&
      (reason === "" || reasonsOf(r).some((x) => x.value === reason)) &&
      textFilter.test([recordTitle(r, d?.labels.get(r.source)), d?.labels.get(r.source) ?? "A removed source", ...reasonsOf(r).map((x) => x.label)].join(" ")),
  );
  const filterOn = query.trim() !== "" || source !== "" || reason !== "";
  const showBar = d !== null && (items.length >= FILTER_FROM || cursor !== null || filterOn);
  useEffect(() => {
    if (d) onCount?.(items.length);
  }, [d, items.length, onCount]);

  // The record shown when the address names none: the first one as the list loads, then kept. Typing a filter never swaps it for
  // another record: when the filter hides the open record, no record is shown (the page says so) until the owner picks one.
  const [auto, setAuto] = useState<string | null>(null);
  useEffect(() => {
    if (d && recordId === null && (auto === null || !items.some((i) => i.id === auto))) setAuto(rows[0]?.id ?? null);
  }, [d, recordId, items, rows, auto]);
  const chosen = recordId ?? auto;
  const hiddenByFilter = chosen !== null && items.some((i) => i.id === chosen) && !rows.some((i) => i.id === chosen);
  const selected = hiddenByFilter ? null : chosen;
  const showMore = () =>
    paging.act(async () => {
      if (!cursor) return;
      const page = await run("review_list", { cursor });
      setMore((m) => [...m, ...page.items.map(asRecord)]);
      setCursor(page.nextCursor);
    });

  const decided = (id: string, text: string) => {
    setMessage(text);
    const at = rows.findIndex((i) => i.id === id);
    const next = rows[at + 1] ?? rows[at - 1];
    onOpen(next && next.id !== id ? next.id : null);
    void ctx.reload();
  };

  return (
    <section className="app-page" aria-label="Review">
      <PageHead title="Review" lede="Records with personal data, a possible secret, or no matching route wait here. Nothing is delivered before you decide." />
      <Notice tone="neutral" role="status">
        Observer delivers what you approve to Knowledge (the area is set on Routing). Delivery to Task Board and Inbox starts in a later version.
      </Notice>
      <RequiredApps targets={d?.targets ?? null} />
      {message ? (
        <Notice tone="live" role="status">
          {message}
        </Notice>
      ) : null}
      {ctx.error ? <LoadFailed message={ctx.error} retrying={ctx.loading} onRetry={() => void ctx.reload()} /> : null}
      <Failure message={paging.error} />
      {d === null ? (
        ctx.error ? null : (
          <p className="tb-soft" role="status">
            Loading the records.
          </p>
        )
      ) : items.length === 0 ? (
        <EmptyState title="Nothing waits for you">Records with personal data, a possible secret or no matching route appear here.</EmptyState>
      ) : (
        <div className="tb-stack">
          {showBar ? (
            <ListFilter
              label="Filter the records"
              value={query}
              onChange={setQuery}
              filter={textFilter}
              placeholder="Title, source, or a regex"
              noun={{ one: "record", many: "records" }}
              shown={rows.length}
              total={items.length}
              facets={source !== "" || reason !== ""}
              more={cursor !== null}
              loadedOnly={filterOn}
              onClear={() => {
                setQuery("");
                setSource("");
                setReason("");
              }}
              onLoadMore={() => void showMore()}
              loadMoreLabel="Show more"
              loadingMore={paging.busy}
              hidden={items.length - rows.length}
              hiddenNoun={{ one: "record that waits for your decision", many: "records that wait for your decision" }}
            >
              <Field label="Source">
                <Select
                  aria-label="Source"
                  options={facetChoices("All sources", [...d.labels].map(([value, label]) => ({ value, label })), source, "A source that is removed")}
                  value={source === "" ? ALL : source}
                  onValueChange={(v) => setSource(v === ALL ? "" : v)}
                />
              </Field>
              <Field label="Reason">
                <Select
                  aria-label="Reason"
                  options={facetChoices("All reasons", items.flatMap(reasonsOf), reason, "A reason no record has now")}
                  value={reason === "" ? ALL : reason}
                  onValueChange={(v) => setReason(v === ALL ? "" : v)}
                />
              </Field>
            </ListFilter>
          ) : null}
        <div className="ob-split">
          <nav className="ruled ob-list" aria-label="Records waiting">
            {rows.map((r) => (
              <a
                key={r.id}
                className={`ob-row${r.id === selected ? " is-sel" : ""}`}
                href={hrefOf(r.id)}
                aria-current={r.id === selected ? "true" : undefined}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                  e.preventDefault();
                  setMessage(null);
                  onOpen(r.id);
                }}
              >
                <b>{recordTitle(r, d.labels.get(r.source))}</b>
                <span className="meta">
                  {d.labels.get(r.source) ?? "A removed source"}
                  {r.windowEnd ? ` · ${stamp(r.windowEnd)}` : ""}
                </span>
                <Reasons r={r} />
              </a>
            ))}
            {cursor ? (
              <div className="tb-ctas ob-more">
                <Button size="sm" onClick={() => void showMore()} disabled={paging.busy}>
                  Show more
                </Button>
              </div>
            ) : null}
          </nav>
          {selected ? (
            <Detail key={selected} id={selected} sourceLabels={d.labels} rules={d.rules} targets={d.targets} onDecided={(t) => decided(selected, t)} />
          ) : (
            <p className="tb-soft">Pick a record.</p>
          )}
        </div>
        </div>
      )}
    </section>
  );
}
