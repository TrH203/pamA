// Device login (spec 004): `pama login` shows a code and opens `/?device=CODE`; the signed-in
// owner checks that the code matches the terminal and approves or denies the machine.
import { useEffect, useState } from "react";
import { ApiError, api } from "../lib/api.ts";

interface Request {
  user_code: string;
  device_name: string;
  created_at: string;
}

export function DeviceApprove({ code, onClose }: { code: string; onClose: () => void }) {
  const [req, setReq] = useState<Request | null>(null);
  const [state, setState] = useState<"loading" | "ask" | "approved" | "denied" | "error">(
    "loading",
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Request>(`/v1/auth/device/lookup?code=${encodeURIComponent(code)}`)
      .then((r) => {
        setReq(r);
        setState("ask");
      })
      .catch((e) => {
        setError(e instanceof ApiError ? e.message : String(e));
        setState("error");
      });
  }, [code]);

  async function decide(approve: boolean) {
    try {
      await api(`/v1/auth/device/${approve ? "approve" : "deny"}`, {
        json: { user_code: code },
      });
      setState(approve ? "approved" : "denied");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setState("error");
    }
  }

  return (
    <section className="mx-auto mt-16 max-w-md space-y-4 rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
      <h1 className="text-lg font-semibold">Connect a device</h1>
      {state === "loading" && <p className="text-sm text-stone-600">Looking up the code…</p>}
      {state === "ask" && req && (
        <>
          <p className="text-sm text-stone-600">
            <span className="font-medium">{req.device_name}</span> wants to connect to this
            workspace with <code>pama</code>. Only continue if your terminal shows this code:
          </p>
          <p className="text-center font-mono text-2xl tracking-widest">{req.user_code}</p>
          <p className="text-xs text-stone-500">
            The device will be able to send digest drafts and use your workspace from the command
            line. Raw transcripts never leave it. You can revoke it any time.
          </p>
          <div className="flex gap-2">
            <button type="button" className="btn-primary flex-1 py-2" onClick={() => decide(true)}>
              Approve
            </button>
            <button type="button" className="btn flex-1 py-2" onClick={() => decide(false)}>
              Deny
            </button>
          </div>
        </>
      )}
      {state === "approved" && (
        <p className="text-sm text-stone-600">Approved. You can go back to your terminal.</p>
      )}
      {state === "denied" && (
        <p className="text-sm text-stone-600">Denied. Nothing was connected.</p>
      )}
      {state === "error" && <p className="text-sm text-red-700">{error}</p>}
      {state !== "ask" && state !== "loading" && (
        <button type="button" className="btn" onClick={onClose}>
          Open the console
        </button>
      )}
    </section>
  );
}
