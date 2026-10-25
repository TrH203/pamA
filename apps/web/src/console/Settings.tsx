// Settings shell: one section per question the owner asks. "Where things run" answers what is
// local and what is online; "Models" chooses the providers (including OpenRouter).
import { useState } from "react";
import { Models } from "./Models.tsx";
import { Placement } from "./Placement.tsx";

const SECTIONS = { placement: "Where things run", models: "Models" } as const;
type Section = keyof typeof SECTIONS;

export function Settings() {
  const initial = new URLSearchParams(location.search).get("section") as Section | null;
  const [section, setSection] = useState<Section>(
    initial && initial in SECTIONS ? initial : "placement",
  );
  const pick = (s: Section) => {
    setSection(s);
    const u = new URL(location.href);
    u.searchParams.set("tab", "settings");
    u.searchParams.set("section", s);
    history.replaceState(null, "", u);
  };
  return (
    <div className="space-y-4">
      <nav className="flex gap-1 border-b border-stone-200 pb-2">
        {(Object.keys(SECTIONS) as Section[]).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => pick(s)}
            className={`rounded px-3 py-1 text-sm ${section === s ? "bg-stone-200 font-medium" : "text-stone-600 hover:bg-stone-100"}`}
          >
            {SECTIONS[s]}
          </button>
        ))}
      </nav>
      {section === "placement" ? <Placement /> : <Models />}
    </div>
  );
}
