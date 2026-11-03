// Device login (spec 004): `pama login` shows a code and opens `/?device=CODE`; the signed-in
// owner checks that the code matches the terminal and approves or denies the machine.
import { useI18n } from "@pama/i18n";
import { Button, ErrorBanner, Notice, Skeleton } from "@pama/ui";
import { CircleCheck, CircleSlash } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../lib/api.ts";
import { AuthCard } from "./Login.tsx";

interface Request {
  user_code: string;
  device_name: string;
  created_at: string;
}

export function DeviceApprove({ code, onClose }: { code: string; onClose: () => void }) {
  const { t } = useI18n();
  const s = t.pages.device;
  const [req, setReq] = useState<Request | null>(null);
  const [state, setState] = useState<"loading" | "ask" | "approved" | "denied" | "error">(
    "loading",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lookup = useCallback(() => {
    setState("loading");
    api<Request>(`/v1/auth/device/lookup?code=${encodeURIComponent(code)}`)
      .then((r) => {
        setReq(r);
        setState("ask");
      })
      .catch((e) => {
        setError(errorMessage(e));
        setState("error");
      });
  }, [code]);
  useEffect(lookup, [lookup]);

  async function decide(approve: boolean) {
    setBusy(true);
    try {
      await api(`/v1/auth/device/${approve ? "approve" : "deny"}`, {
        json: { user_code: code },
      });
      setState(approve ? "approved" : "denied");
    } catch (e) {
      setError(errorMessage(e));
      setState("error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard title={s.title}>
      {state === "loading" && (
        <div role="status" aria-label={s.lookingUp} className="space-y-2">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="mx-auto h-8 w-1/2" />
        </div>
      )}
      {state === "ask" && req && (
        <>
          <p className="text-ui text-muted">
            <span className="font-medium text-fg">{req.device_name}</span> wants to connect to this
            workspace with <code>pama</code>. Only continue if your terminal shows this code:
          </p>
          <p className="rounded-control bg-subtle py-3 text-center font-mono text-2xl tracking-widest">
            {req.user_code}
          </p>
          <p className="text-xs text-muted">
            The device will be able to send digest drafts and use your workspace from the command
            line. Raw transcripts never leave it. You can revoke it any time.
          </p>
          <div className="flex gap-2">
            <Button
              variant="primary"
              size="lg"
              className="flex-1"
              loading={busy}
              onClick={() => decide(true)}
            >
              {s.approve}
            </Button>
            <Button size="lg" className="flex-1" disabled={busy} onClick={() => decide(false)}>
              {s.deny}
            </Button>
          </div>
        </>
      )}
      {state === "approved" && (
        <Notice tone="success" icon={CircleCheck}>
          {s.approved}
        </Notice>
      )}
      {state === "denied" && <Notice icon={CircleSlash}>{s.denied}</Notice>}
      {state === "error" && (
        <ErrorBanner
          title={t.common.error}
          message={error}
          onRetry={lookup}
          retryLabel={t.common.retry}
        />
      )}
      {state !== "ask" && state !== "loading" && <Button onClick={onClose}>{s.open}</Button>}
    </AuthCard>
  );
}
