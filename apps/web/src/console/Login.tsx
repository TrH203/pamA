// Sign in to the console on a self-hosted or cloud server (US5): email magic link.
import { useI18n } from "@pama/i18n";
import { Button, Card, ErrorBanner, Field, Input, Notice } from "@pama/ui";
import { MailCheck } from "lucide-react";
import { type FormEvent, useState } from "react";
import { api, errorMessage } from "../lib/api.ts";

/** Centered single-card layout for the pages shown before the console (login, device). */
export function AuthCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-start justify-center bg-bg px-4 pt-[14vh]">
      <Card className="w-full max-w-sm space-y-4 p-6">
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className="inline-flex size-7 items-center justify-center rounded-control bg-accent text-sm font-semibold text-accent-contrast"
          >
            p
          </span>
          <h1 className="text-base font-semibold">{title}</h1>
        </div>
        {children}
      </Card>
    </main>
  );
}

export function Login() {
  const { t } = useI18n();
  const s = t.pages.login;
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      // Come back to the same page (e.g. a device approval) after following the email link.
      const next = location.pathname + location.search;
      await api("/v1/auth/login", { json: next === "/" ? { email } : { email, next } });
      setSent(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard title={s.title}>
      {sent ? (
        <Notice tone="success" icon={MailCheck}>
          {s.sent(email)}
        </Notice>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <p className="text-ui text-muted">{s.hint}</p>
          <Field label={s.email}>
            <Input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="h-10 text-sm"
            />
          </Field>
          {error && <ErrorBanner title={t.common.error} message={error} />}
          <Button
            type="submit"
            variant="primary"
            size="lg"
            className="w-full"
            loading={busy}
            disabled={!email.includes("@")}
          >
            {s.submit}
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
