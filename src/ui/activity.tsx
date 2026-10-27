// Activity: what Observer delivered and to where, with the ones that wait for approval (held), failed, or were superseded (the record
// went back to Review after the decision, so the row will never be sent). Mockup: build-app-observer.ts.
import { AppIcon, Button, EmptyState, Select, Table, Tag } from "@opt2-tealbrick/ui";
import { useEffect, useMemo, useState } from "react";
import { asDelivery, asRecord, type Delivery, destinationName, recordTitle, run, stamp, until } from "./api.ts";
import { Failure, LoadFailed, PageHead, useAct, useLoad } from "./common.tsx";

type Filter = "all" | "pending" | "held" | "sent" | "failed";
const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All deliveries" },
  { value: "pending", label: "Waiting to send" },
  { value: "held", label: "Held for approval" },
  { value: "sent", label: "Delivered" },
  { value: "failed", label: "Failed" },
];

/** The status tag of a delivery. A superseded row is never sent, whatever its status says. */
export function StatusTag({ d }: { d: Delivery }) {
  if (d.superseded) return <Tag status="idle">Superseded: will not be sent</Tag>;
  switch (d.status) {
    case "sent":
      return <Tag status="live">Delivered</Tag>;
    case "held":
      return <Tag status="needs-you">Held: waits for your approval</Tag>;
    case "failed":
      return <Tag status="needs-you">{d.nextAt ? `Failed · retry ${until(d.nextAt)}` : "Failed"}</Tag>;
    default:
      return <Tag status="busy">{d.nextAt ? `Waiting to send · next try ${until(d.nextAt)}` : "Waiting to send"}</Tag>;
  }
}

export function ActivityPage() {
  const [filter, setFilter] = useState<Filter>("all");
  const [more, setMore] = useState<Delivery[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const list = useLoad(async () => {
    const [deliveries, records, sources] = await Promise.all([run("deliveries_list", filter === "all" ? {} : { status: filter }), run("records_list", {}), run("sources_list", {})]);
    const labels = new Map(sources.sources.map((s) => [s.id, s.label] as const));
    return { items: deliveries.items.map(asDelivery), next: deliveries.nextCursor, titles: new Map(records.items.map(asRecord).map((r) => [r.id, recordTitle(r, labels.get(r.source))] as const)) };
  }, [filter]);
  const { busy, error, act } = useAct();
  const d = list.data;
  useEffect(() => {
    if (d) {
      setMore([]);
      setCursor(d.next);
    }
  }, [d]);
  const items = useMemo(() => (d ? [...d.items, ...more] : []), [d, more]);

  const retry = (id: string) =>
    act(async () => {
      await run("delivery_retry", { id });
      await list.reload();
    });
  const showMore = () =>
    act(async () => {
      if (!cursor) return;
      const page = await run("deliveries_list", { ...(filter === "all" ? {} : { status: filter }), cursor });
      setMore((m) => [...m, ...page.items.map(asDelivery)]);
      setCursor(page.nextCursor);
    });

  return (
    <section className="app-page" aria-label="Activity">
      <PageHead title="Activity" lede="Records you approved, and where they go. Observer sends them to Knowledge by itself; Task Board and Inbox come in a later version. Every delivery is keyed to its record, so a retry never makes a second copy.">
        <div className="ob-filter">
          <span className="tb-label" id="ob-filter-label">
            Show
          </span>
          <Select aria-labelledby="ob-filter-label" value={filter} onValueChange={(v) => setFilter(v as Filter)} options={FILTERS} />
        </div>
      </PageHead>
      <Failure message={error} />
      {list.error ? <LoadFailed message={list.error} retrying={list.loading} onRetry={() => void list.reload()} /> : null}
      {d === null ? (
        list.error ? null : (
          <p className="tb-soft" role="status">
            Loading the deliveries.
          </p>
        )
      ) : items.length === 0 ? (
        <EmptyState title={filter === "all" ? "Nothing here yet" : "No deliveries match"}>{filter === "all" ? "Records you approve in Review, and records a rule routes, appear here." : "Pick another filter to see the rest."}</EmptyState>
      ) : (
        <>
          <Table className="ob-table" aria-label="Deliveries">
            <thead>
              <tr>
                <th>When</th>
                <th>Record</th>
                <th>Destination</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((x) => (
                <tr key={x.id}>
                  <td>{x.updatedAt ? stamp(x.updatedAt) : "—"}</td>
                  <td className="strong">
                    {d.titles.get(x.recordId) ?? "A record that is no longer listed"}
                    {x.warning ? <span className="ob-warn"> {x.warning.startsWith("may_duplicate") ? "May duplicate an earlier copy." : x.warning}</span> : null}
                    {/* last_error is always one of Observer's own sentences (src/deliver.ts), never the destination's words */}
                    {x.status !== "sent" && x.lastError ? <span className="ob-warn"> {x.lastError}</span> : x.status === "failed" ? <span className="ob-warn"> The destination did not take it.</span> : null}
                  </td>
                  <td>
                    <span className="ob-dest-cell">
                      <AppIcon name={destinationName(x.destination)} size={16} /> {destinationName(x.destination)}
                    </span>
                  </td>
                  <td>
                    <span className="tb-row ob-status">
                      <StatusTag d={x} />
                      {x.status === "failed" && !x.superseded ? (
                        <Button size="sm" disabled={busy} onClick={() => void retry(x.id)}>
                          Retry
                        </Button>
                      ) : null}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
          {cursor ? (
            <div className="tb-ctas">
              <Button onClick={() => void showMore()} disabled={busy}>
                Show more
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
