// Small pieces the pages share: the failure notices (RUL-01, RUL-14), the one-call-at-a-time guard (C8), the load hook with the
// load error kept (a failed load is an error with Try again, never an empty list), and the "what is missing" notice.
import { Button, Notice } from "@opt2-tealbrick/ui";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { explain, missingRequired } from "./api.ts";

/** A failed action: a plain sentence in an alert, never dropped (RUL-01). */
export function Failure({ message }: { message: string | null }) {
  return message ? (
    <Notice tone="needs-you" role="alert">
      {message}
    </Notice>
  ) : null;
}

/** A failed load: what happened and Try again, never an empty state that looks like "nothing here" (RUL-14). */
export function LoadFailed({ message, retrying, onRetry }: { message: string; retrying: boolean; onRetry: () => void }) {
  return (
    <Notice tone="needs-you" role="alert">
      <span className="tb-row">
        <span>{message}</span>
        <Button size="sm" onClick={onRetry} disabled={retrying}>
          Try again
        </Button>
      </span>
    </Notice>
  );
}

export function PageHead({ title, lede, children }: { title: ReactNode; lede?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div className="tb-stack ob-head">
        <h1>{title}</h1>
        {lede ? <p className="tb-lede">{lede}</p> : null}
      </div>
      {children}
    </div>
  );
}

/**
 * One call at a time (C8): `act` runs the call, keeps `busy` true while it runs and turns a failure into a plain
 * sentence in `error`. A second `act` while one runs does nothing (the ref closes the gap before React re-renders).
 */
export function useAct() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);
  const act = useCallback(async (fn: () => Promise<unknown>): Promise<boolean> => {
    if (running.current) return false;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(explain(e));
      return false;
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, []);
  return { busy, error, setError, act };
}

/** Load once and on `reload`; keeps the last data and the load error apart (RUL-14). A late answer of an older call is dropped. */
export function useLoad<T>(fn: () => Promise<T>, deps: readonly unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const latest = useRef(fn);
  latest.current = fn;
  const reload = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const out = await latest.current();
      if (mine !== seq.current) return;
      setData(out);
      setError(null);
    } catch (e) {
      if (mine === seq.current) setError(explain(e));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload, ...deps]);
  return { data, error, loading, reload, setData };
}

/** Two-step danger button: the first click arms it ("Confirm …", filled), the second runs `onConfirm`. Focus leaving disarms it. */
export function ConfirmButton({ label, confirmLabel, onConfirm, disabled, size = "sm" }: { label: string; confirmLabel: string; onConfirm: () => void; disabled?: boolean; size?: "sm" | "md" }) {
  const [armed, setArmed] = useState(false);
  return (
    <Button
      variant="danger"
      size={size}
      confirm={armed}
      disabled={disabled}
      onBlur={() => setArmed(false)}
      onClick={() => {
        if (!armed) return setArmed(true);
        setArmed(false);
        onConfirm();
      }}
    >
      {armed ? confirmLabel : label}
    </Button>
  );
}

/** Observer needs Connect (to read) and Knowledge (to deliver). Says so when one is missing, with the next step for each; renders nothing
 *  when both are there. Core grants a companion only to a deployed AND licensed app, so "not available" is one of those two. */
export function RequiredApps({ targets }: { targets: readonly string[] | null }) {
  if (targets === null) return null;
  const missing = missingRequired(targets);
  if (missing.length === 0) return null;
  return (
    <Notice tone="needs-you" role="status">
      <span>
        <strong>Observer needs Connect and Knowledge to work.</strong> {missing.join(" and ")} {missing.length === 1 ? "is" : "are"} not available to it now. Task Board and Operator Inbox are optional.
        {missing.includes("Knowledge") ? " To connect Knowledge: in Portal, add Knowledge to this workspace and give it a licence. Observer connects to it by itself." : ""}
        {missing.includes("Connect") ? " To connect Connect: in Portal, add Connect to this workspace and give it a licence, then share an account with Observer in Connect." : ""}
      </span>
    </Notice>
  );
}

/** A kit check row (`.tb-check`): a native checkbox with a title and a line under it. Wrap several in `.tb-checks`. */
export function Check({ checked, onChange, title, body, disabled }: { checked: boolean; onChange: (on: boolean) => void; title: ReactNode; body?: ReactNode; disabled?: boolean }) {
  return (
    <label className="tb-check">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.currentTarget.checked)} />
      <span className="tb-check-title">{title}</span>
      {body ? <span className="tb-check-body">{body}</span> : null}
    </label>
  );
}
