// The app inside the ONE app shell, <AppShell> from @opt2-tealbrick/ui (SDK-API §14): header in the app's colour with its
// art, then the pages. Sources (launch), Review, Routing, Activity, Privacy and Settings are Observer's own; Holds, Receipts,
// Agents & scopes and Backups & export come from ./standard.tsx (the template's single copy; pass your own words as props).
import { useSession } from "@opt2-tealbrick/miniapp-sdk/client";
import { AppShell, appArt, appColour, Button, Notice, STANDARD_PAGES, Tag } from "@opt2-tealbrick/ui";
import { useEffect, useState } from "react";
import { ActivityPage } from "./activity.tsx";
import { run } from "./api.ts";
import { useAppNav } from "./nav.ts";
import { PrivacyPage } from "./privacy.tsx";
import { ReviewPage } from "./review.tsx";
import { RoutingPage } from "./routing.tsx";
import { SettingsPage } from "./settings.tsx";
import { SourcesPage } from "./sources.tsx";
import { AgentsPage, BackupsPage, HoldsPage, portalHref, ReceiptsPage, useHoldList } from "./standard.tsx";

const NAME = "Observer";
/** Where scripts/build-ui.ts puts this app's still (`stills/`, next to this module in the hashed asset directory, C61). */
const STILLS = new URL("./stills/", import.meta.url).href;

/** Nav order of the mockup: Sources, Review (badge = records waiting), Routing, Activity, Privacy, then Holds, Receipts, Agents & scopes, Settings, Backups & export. */
const standard = (id: string) => STANDARD_PAGES.find((p) => p.id === id) ?? { id, label: id };

export function App() {
  const { principal, status, signOut } = useSession();
  const nav = useAppNav();
  const holds = useHoldList();
  const [notice, setNotice] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(0);
  const [portal] = useState(portalHref);
  const signedIn = status === "signed_in" && principal;
  // the badge shows from the first page on, not only after Review was opened
  useEffect(() => {
    if (!signedIn) return;
    run("review_list", {})
      .then((out) => setWaiting(out.items.length))
      .catch(() => {});
  }, [signedIn]);
  const pages = [
    { id: "sources", label: "Sources" },
    { id: "review", label: "Review", badge: waiting || null },
    { id: "routing", label: "Routing" },
    { id: "activity", label: "Activity" },
    { id: "privacy", label: "Privacy" },
    { ...standard("holds"), badge: holds.holds?.length || null },
    standard("receipts"),
    standard("agents"),
    { id: "settings", label: "Settings" },
    standard("backups"),
  ];
  return (
    <AppShell
      title={NAME}
      colour={appColour("observer")}
      art={appArt("observer", STILLS)}
      portalHref={portal}
      pages={pages}
      current={nav.page}
      onNavigate={nav.go}
      pageHref={nav.href}
      actions={
        signedIn ? (
          <Button
            size="sm"
            onClick={() => {
              setNotice(null);
              signOut().catch(() => setNotice("Couldn’t sign you out. Check your connection and try again."));
            }}
          >
            Sign out
          </Button>
        ) : (
          <Tag status={status === "loading" ? "busy" : "needs-you"}>{status === "loading" ? "Loading" : "Signed out"}</Tag>
        )
      }
      banner={
        status === "signed_out" ? (
          <Notice tone="needs-you" role="alert">
            Open this app from Portal to sign in.
          </Notice>
        ) : notice ? (
          <Notice tone="needs-you" role="alert">
            {notice}
          </Notice>
        ) : null
      }
    >
      {!signedIn ? null : nav.page === "review" ? (
        <ReviewPage recordId={nav.record} onOpen={(id) => (id ? nav.openRecord(id) : nav.go("review"))} hrefOf={nav.recordHref} onCount={setWaiting} />
      ) : nav.page === "routing" ? (
        <RoutingPage />
      ) : nav.page === "activity" ? (
        <ActivityPage />
      ) : nav.page === "privacy" ? (
        <PrivacyPage />
      ) : nav.page === "settings" ? (
        <SettingsPage />
      ) : nav.page === "agents" ? (
        <AgentsPage lede="Agents see the status of your sources and jobs, never message text, senders or titles. They can pause a job and flag a record Observer delivered. They read delivered records in Knowledge, under their own Knowledge access." />
      ) : nav.page === "receipts" ? (
        <ReceiptsPage lede="What agents did through Observer. Inputs are kept only as digests." />
      ) : nav.page === "backups" ? (
        <BackupsPage text="Observer backs up its data every night to its own volume. The export is a readable copy you can keep. It contains stored message text that is still inside its retention time." />
      ) : nav.page === "holds" ? (
        <HoldsPage list={holds} only={nav.hold} empty="No calls to Observer wait for your approval." />
      ) : (
        <SourcesPage />
      )}
    </AppShell>
  );
}
