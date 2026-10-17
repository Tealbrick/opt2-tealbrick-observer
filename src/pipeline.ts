// Classify a stored record and route it (DESIGN §4.3 steps 3–4). S2's ingestion calls `applyRouting` when a window closes;
// the record then waits in Review, is dropped, or is approved with an outbox row (S4 sends it).
import type { Db } from "@opt2-tealbrick/miniapp-sdk";
import { TbError } from "@opt2-tealbrick/miniapp-sdk";
import { classifyRecord } from "./classify.ts";
import { recordMetaFacts, scanRecord } from "./records.ts";
import { type Route, type RouteFacts, routeFacts } from "./router.ts";
import { DAY_MS, decideRecord, getPrivacy, listRules, loadClassifierConfig, notFound, type Row, recordRow } from "./store.ts";

/** Classify the stored messages of a record and decide where it goes. One transaction. */
export function applyRouting(db: Db, recordId: string, now: number): { route: Route; classes: Record<string, number> } {
  return db.transaction(() => {
    const rec = recordRow(db, recordId);
    if (!rec) throw notFound("record");
    if (!["open", "classified"].includes(String(rec.state))) throw new TbError("record_state_invalid", `cannot route a record that is ${String(rec.state)}`, 409);
    // the record closes: look for a secret in the JOINED texts too (one split over messages, e.g. "password:" and then the value),
    // with several separators and at every seam. A hit means a secret is stored in pieces: every message text of the record goes,
    // ids / digests / the flag stay. Too big to scan (256 KiB): held for Review as suspect.
    const scan = scanRecord(db, recordId, now);
    const crossHit = scan.secret;
    const msgs = db.prepare("SELECT conversation, author_key, text FROM obs_messages WHERE record_id = ? AND deleted = 0 ORDER BY sent_at, provider_msg_id").all(recordId);
    const cfg = loadClassifierConfig(db);
    const texts = msgs.map((m) => (m.text === null ? null : String(m.text)));
    const facts = classifyRecord(texts, cfg);
    const joined = texts.filter((t): t is string => t !== null).join("\n");
    if (crossHit) {
      facts.classes.secret = Math.max(facts.classes.secret ?? 0, 1);
      facts.secret = true;
    }
    if (scan.toolarge || scan.suspect) facts.classes.suspect_secret = Math.max(facts.classes.suspect_secret ?? 0, 1);
    // the thread subject and the author handles are text as well: a hit there counts like one in the body
    const meta = recordMetaFacts(db, recordId);
    if (meta.secret > 0) {
      facts.classes.secret = Math.max(facts.classes.secret ?? 0, meta.secret);
      facts.secret = true;
    }
    if (meta.suspect > 0) facts.classes.suspect_secret = Math.max(facts.classes.suspect_secret ?? 0, meta.suspect);
    const hasText = !crossHit && texts.some((t) => t !== null);
    const secret = facts.secret || crossHit || Number(rec.secret) === 1;
    const rf: RouteFacts = {
      source: String(rec.source_id),
      conversations: [...new Set(msgs.map((m) => String(m.conversation)))],
      authors: [...new Set(msgs.map((m) => String(m.author_key)))],
      text: crossHit ? "" : joined,
      classes: facts.classes,
      secret,
      actionable: facts.actionable,
      words: facts.words,
    };
    const route: Route = secret || hasText ? routeFacts(rf, listRules(db)) : { kind: "review", ruleId: null, reason: "no_text" };
    const common = [JSON.stringify(facts.classes), secret ? 1 : 0, facts.actionable ? 1 : 0] as const;
    db.prepare("UPDATE obs_records SET pii_json = ?, secret = ?, actionable = ?, rule_id = ?, updated_at = ? WHERE id = ?").run(...common, route.ruleId, now, recordId);
    const retention = getPrivacy(db).textRetentionDays;
    if (route.kind === "drop") {
      db.prepare("DELETE FROM obs_deliveries WHERE record_id = ? AND status <> 'sent'").run(recordId);
      db.prepare("UPDATE obs_records SET state = 'dropped', decided_by = ?, decided_at = ?, text_purge_at = ?, updated_at = ? WHERE id = ?").run(`rule:${route.ruleId}`, now, now + retention * DAY_MS, now, recordId);
    } else if (route.kind === "review") {
      db.prepare("UPDATE obs_records SET state = 'review', updated_at = ? WHERE id = ?").run(now, recordId);
    } else {
      // the same guards and the same outbox row as the owner's click: decideRecord (it needs the record in review)
      db.prepare("UPDATE obs_records SET state = 'review' WHERE id = ?").run(recordId);
      const row = recordRow(db, recordId) as Row;
      decideRecord(
        db,
        row,
        { decision: route.redact ? "deliver_redacted" : "deliver", destination: route.destination, input: { recordId, decision: route.redact ? "deliver_redacted" : "deliver", destination: route.destination, rule: route.ruleId } },
        `rule:${route.ruleId}`,
        now,
        retention,
      );
    }
    return { route, classes: facts.classes };
  });
}
