// The app's page router: the template's page paths (standard.tsx) plus `/review/<id>`, the link the Inbox item gives the owner
// (`ctx.ownerLink("/review/<id>")`, DESIGN §6). Sources is the launch page (manifest `ui.launchPath`).
import { useCallback, useEffect, useState } from "react";
import { holdOf, pageOf, standardRoutes } from "./standard.tsx";

/** Shell page id → path under the base `/a/observer/`. Agents & scopes is `/configure` (`ui.configurePath`). */
export const ROUTES: Record<string, string> = { ...standardRoutes("sources"), review: "review", routing: "routing", activity: "activity", privacy: "privacy", settings: "settings" };
const RECORD_PATH = /^review\/([^/]+)$/;

export interface AppNav {
  /** current page id */
  page: string;
  /** hold id of a `/holds/<id>` deep link, else null */
  hold: string | null;
  /** record id of a `/review/<id>` deep link or of the record the owner picked, else null */
  record: string | null;
  go: (id: string) => void;
  /** pick a record in Review (history.pushState, so the back button works and the address can be copied) */
  openRecord: (id: string) => void;
  href: (id: string) => string;
  recordHref: (id: string) => string;
}

const recordHref = (id: string) => `./review/${encodeURIComponent(id)}`;

function read(): { page: string; hold: string | null; record: string | null } {
  const { pathname } = globalThis.location;
  const base = new URL(document.baseURI).pathname;
  const rest = (pathname.startsWith(base) ? pathname.slice(base.length) : "").replace(/\/+$/, "");
  const m = RECORD_PATH.exec(rest);
  if (m?.[1]) {
    try {
      return { page: "review", hold: null, record: decodeURIComponent(m[1]) };
    } catch {
      return { page: "review", hold: null, record: null };
    }
  }
  return { page: pageOf(ROUTES, base, pathname, "sources"), hold: holdOf(pathname), record: null };
}

export function useAppNav(): AppNav {
  const [at, setAt] = useState(read);
  useEffect(() => {
    const onPop = () => setAt(read());
    globalThis.addEventListener("popstate", onPop);
    return () => globalThis.removeEventListener("popstate", onPop);
  }, []);
  const href = useCallback((id: string) => `./${ROUTES[id] ?? ""}`, []);
  const go = useCallback(
    (id: string) => {
      globalThis.history.pushState(null, "", href(id));
      setAt(read());
    },
    [href],
  );
  const openRecord = useCallback((id: string) => {
    globalThis.history.pushState(null, "", recordHref(id));
    setAt(read());
  }, []);
  return { ...at, go, openRecord, href, recordHref };
}
