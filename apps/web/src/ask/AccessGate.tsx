// PIN or email-code gate shown before any content.

import type { Messages } from "@pama/i18n";
import { useI18n } from "@pama/i18n";
import { Button, Card, ErrorBanner, Field, Input } from "@pama/ui";
import { KeyRound, Mail } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { api, PublicError } from "./api.ts";

/** The gate has a single field: put the cursor in it. */
const focusOnMount = (el: HTMLInputElement | null) => el?.focus();

function message(e: unknown, t: Messages["ask"]): string {
  if (e instanceof PublicError) {
    if (e.status === 423) return t.locked;
    if (e.code === "not_allowed") return t.notAllowed;
    if (e.status === 401) return t.wrong;
  }
  return t.wrong;
}

function Gate({
  icon,
  title,
  hint,
  children,
}: {
  icon: ReactNode;
  title: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <main className="flex min-h-dvh items-start justify-center px-4 pt-[12vh]">
      <Card className="w-full max-w-sm space-y-4 p-6">
        <span className="inline-flex size-10 items-center justify-center rounded-full bg-accent-soft text-accent-ink">
          {icon}
        </span>
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          <p className="text-sm text-muted">{hint}</p>
        </div>
        {children}
      </Card>
    </main>
  );
}

export function AccessGate({ mode, onGranted }: { mode: string; onGranted: () => void }) {
  const { t: all } = useI18n();
  const t = all.ask;
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
      setError(message(err, t));
    } finally {
      setBusy(false);
    }
  }

  const big = "h-11 text-base";
  const errorBox = error && <ErrorBanner title={error} />;

  if (mode === "pin") {
    return (
      <Gate icon={<KeyRound aria-hidden className="size-5" />} title={t.pinTitle} hint={t.pinHint}>
        <form onSubmit={(e) => submit(e, { pin }, onGranted)} className="space-y-4">
          <Input
            className={`${big} text-center font-mono tracking-[0.4em]`}
            inputMode="numeric"
            autoComplete="one-time-code"
            aria-label={t.pinTitle}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
            maxLength={8}
            ref={focusOnMount}
          />
          {errorBox}
          <Button
            type="submit"
            variant="primary"
            size="lg"
            className="w-full"
            loading={busy}
            disabled={pin.length < 4}
          >
            {t.continue}
          </Button>
        </form>
      </Gate>
    );
  }
  if (!sent) {
    return (
      <Gate icon={<Mail aria-hidden className="size-5" />} title={t.emailTitle} hint={t.emailHint}>
        <form onSubmit={(e) => submit(e, { email }, () => setSent(true))} className="space-y-4">
          <Field label={t.email}>
            <Input
              className={big}
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              ref={focusOnMount}
            />
          </Field>
          {errorBox}
          <Button
            type="submit"
            variant="primary"
            size="lg"
            className="w-full"
            loading={busy}
            disabled={!email.includes("@")}
          >
            {t.sendCode}
          </Button>
        </form>
      </Gate>
    );
  }
  return (
    <Gate
      icon={<Mail aria-hidden className="size-5" />}
      title={t.emailTitle}
      hint={t.codeSent(email)}
    >
      <form onSubmit={(e) => submit(e, { email, otp: code }, onGranted)} className="space-y-4">
        <Input
          className={`${big} text-center font-mono tracking-[0.4em]`}
          inputMode="numeric"
          autoComplete="one-time-code"
          aria-label={t.code}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          maxLength={6}
          ref={focusOnMount}
        />
        {errorBox}
        <Button
          type="submit"
          variant="primary"
          size="lg"
          className="w-full"
          loading={busy}
          disabled={code.length !== 6}
        >
          {t.continue}
        </Button>
      </form>
    </Gate>
  );
}
