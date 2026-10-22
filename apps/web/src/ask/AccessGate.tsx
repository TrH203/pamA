// PIN or email-code gate shown before any content.
import { type FormEvent, useState } from "react";
import { api, PublicError } from "./api.ts";
import { t } from "./i18n.ts";

function message(e: unknown): string {
  if (e instanceof PublicError) {
    if (e.status === 423) return t.locked;
    if (e.code === "not_allowed") return t.notAllowed;
    if (e.status === 401) return t.wrong;
  }
  return t.wrong;
}

export function AccessGate({ mode, onGranted }: { mode: string; onGranted: () => void }) {
  const [pin, setPin] = useState("");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(
    e: FormEvent,
    body: { pin?: string; email?: string; otp?: string },
    after: () => void,
  ) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.access(body);
      after();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  const field =
    "w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-base focus:border-stone-900 focus:outline-none";
  return (
    <section className="mx-auto mt-16 max-w-sm rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
      {mode === "pin" ? (
        <form onSubmit={(e) => submit(e, { pin }, onGranted)} className="space-y-3">
          <h1 className="text-lg font-semibold">{t.pinTitle}</h1>
          <p className="text-sm text-stone-600">{t.pinHint}</p>
          <input
            className={`${field} tracking-[0.4em]`}
            inputMode="numeric"
            autoComplete="one-time-code"
            aria-label={t.pinTitle}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
            maxLength={8}
            autoFocus
          />
          {error && <p className="text-sm text-red-700">{error}</p>}
          <button
            type="submit"
            disabled={busy || pin.length < 4}
            className="btn-primary w-full py-2"
          >
            {t.continue}
          </button>
        </form>
      ) : !sent ? (
        <form onSubmit={(e) => submit(e, { email }, () => setSent(true))} className="space-y-3">
          <h1 className="text-lg font-semibold">{t.emailTitle}</h1>
          <p className="text-sm text-stone-600">{t.emailHint}</p>
          <input
            className={field}
            type="email"
            autoComplete="email"
            aria-label="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
          />
          {error && <p className="text-sm text-red-700">{error}</p>}
          <button
            type="submit"
            disabled={busy || !email.includes("@")}
            className="btn-primary w-full py-2"
          >
            {t.sendCode}
          </button>
        </form>
      ) : (
        <form onSubmit={(e) => submit(e, { email, otp: code }, onGranted)} className="space-y-3">
          <h1 className="text-lg font-semibold">{t.emailTitle}</h1>
          <p className="text-sm text-stone-600">{t.codeSent(email)}</p>
          <input
            className={`${field} tracking-[0.4em]`}
            inputMode="numeric"
            autoComplete="one-time-code"
            aria-label={t.code}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            maxLength={6}
            autoFocus
          />
          {error && <p className="text-sm text-red-700">{error}</p>}
          <button
            type="submit"
            disabled={busy || code.length !== 6}
            className="btn-primary w-full py-2"
          >
            {t.continue}
          </button>
        </form>
      )}
    </section>
  );
}
