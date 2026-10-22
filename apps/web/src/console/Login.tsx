// Sign in to the console on a self-hosted or cloud server (US5): email magic link.
import { type FormEvent, useState } from "react";
import { api } from "../lib/api.ts";

export function Login() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api("/v1/auth/login", { json: { email } });
      setSent(true);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <section className="mx-auto mt-24 max-w-sm rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
      <h1 className="mb-1 text-lg font-semibold">Sign in to pamA</h1>
      {sent ? (
        <p className="text-sm text-stone-600">
          If <span className="font-medium">{email}</span> can sign in here, a link is on its way. It
          works once and expires in 15 minutes.
        </p>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <p className="text-sm text-stone-600">We'll email you a one-time sign-in link.</p>
          <input
            className="w-full rounded-lg border border-stone-300 px-3 py-2"
            type="email"
            autoComplete="email"
            aria-label="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          {error && <p className="text-sm text-red-700">{error}</p>}
          <button type="submit" className="btn-primary w-full py-2" disabled={!email.includes("@")}>
            Email me a link
          </button>
        </form>
      )}
    </section>
  );
}
