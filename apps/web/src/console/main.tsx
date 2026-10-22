import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import "../styles.css";
import { Bundles } from "./Bundles.tsx";
import { Review } from "./Review.tsx";

const TABS = { review: "Review", bundles: "Bundles" } as const;
type Tab = keyof typeof TABS;

function ConsoleApp() {
  const [tab, setTab] = useState<Tab>("review");
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
      {tab === "review" ? <Review /> : <Bundles />}
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
