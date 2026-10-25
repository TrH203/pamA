import { type JSX, StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ApiError, api } from "../lib/api.ts";
import "../styles.css";
import { Audit } from "./Audit.tsx";
import { Bundles } from "./Bundles.tsx";
import { DeviceApprove } from "./DeviceApprove.tsx";
import { Doctor } from "./Doctor.tsx";
import { Inbox } from "./Inbox.tsx";
import { Links } from "./Links.tsx";
import { Login } from "./Login.tsx";
import { Review } from "./Review.tsx";
import { Settings } from "./Settings.tsx";

const TABS = {
  review: "Review",
  links: "Links",
  inbox: "Inbox",
  audit: "Audit",
  bundles: "Bundles",
  settings: "Settings",
  doctor: "Doctor",
} as const;
const PAGES: Record<Tab, () => JSX.Element> = {
  review: Review,
  links: Links,
  inbox: Inbox,
  audit: Audit,
  bundles: Bundles,
  settings: Settings,
  doctor: Doctor,
};
type Tab = keyof typeof TABS;

function ConsoleApp() {
  const initial = (new URLSearchParams(location.search).get("tab") ?? "review") as Tab;
  const [tab, setTab] = useState<Tab>(initial in TABS ? initial : "review");
  const Page = PAGES[tab];
  const [auth, setAuth] = useState<"checking" | "ok" | "login" | "local">("checking");
  // `pama login` opens `/?device=CODE` (spec 004).
  const [device, setDevice] = useState(new URLSearchParams(location.search).get("device"));
  const [dev, setDev] = useState(false);
  useEffect(() => {
    api<{ mode: string; dev?: boolean }>("/v1/auth/me")
      .then((me) => {
        setDev(me.dev === true);
        setAuth("ok");
      })
      .catch((e) => {
        if (!(e instanceof ApiError) || e.status !== 401) return setAuth("ok");
        // The owner's machine uses a per-launch token: open the console from the desktop app.
        setAuth(
          location.hostname === "127.0.0.1" || location.hostname === "localhost"
            ? "local"
            : "login",
        );
      });
  }, []);
  if (auth === "checking") return null;
  if (auth === "login") return <Login />;
  if (device && auth === "ok") {
    return (
      <DeviceApprove
        code={device}
        onClose={() => {
          history.replaceState(null, "", location.pathname);
          setDevice(null);
        }}
      />
    );
  }
  if (auth === "local") {
    return (
      <p className="mx-auto mt-24 max-w-sm text-center text-stone-600">
        Run `pama console` or use the pamA tray menu to open the console.
      </p>
    );
  }
  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <header className="mb-6 flex flex-wrap items-center gap-4">
        <h1 className="text-xl font-bold">
          pamA
          {dev && (
            <span className="ml-2 rounded bg-amber-200 px-1.5 py-0.5 align-middle text-xs font-semibold text-amber-900">
              dev
            </span>
          )}
        </h1>
        <nav className="flex gap-1">
          {(Object.keys(TABS) as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`rounded px-3 py-1.5 text-sm ${tab === t ? "bg-stone-900 text-white" : "text-stone-600 hover:bg-stone-200"}`}
            >
              {TABS[t]}
            </button>
          ))}
        </nav>
      </header>
      <Page />
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <ConsoleApp />
    </StrictMode>,
  );
}
