import { type JSX, StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import "../styles.css";
import { Audit } from "./Audit.tsx";
import { Bundles } from "./Bundles.tsx";
import { Inbox } from "./Inbox.tsx";
import { Links } from "./Links.tsx";
import { Review } from "./Review.tsx";

const TABS = {
  review: "Review",
  links: "Links",
  inbox: "Inbox",
  audit: "Audit",
  bundles: "Bundles",
} as const;
const PAGES: Record<Tab, () => JSX.Element> = {
  review: Review,
  links: Links,
  inbox: Inbox,
  audit: Audit,
  bundles: Bundles,
};
type Tab = keyof typeof TABS;

function ConsoleApp() {
  const initial = (new URLSearchParams(location.search).get("tab") ?? "review") as Tab;
  const [tab, setTab] = useState<Tab>(initial in TABS ? initial : "review");
  const Page = PAGES[tab];
  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <header className="mb-6 flex flex-wrap items-center gap-4">
        <h1 className="text-xl font-bold">pamA</h1>
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
