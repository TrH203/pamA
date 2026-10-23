import { useState } from "react";
import { type BundleLike, summarizeBundle } from "./bundleSummary.ts";

/** Bundle name as title, its branches as chips, session count and last activity. */
export function BundleSummary({ bundle, now }: { bundle: BundleLike; now?: Date }) {
  const [open, setOpen] = useState(false);
  const v = summarizeBundle(bundle, now);
  const chips = open ? v.allBranches : v.chips;
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h3 className="font-semibold">{v.title}</h3>
        <span className="text-xs text-stone-500">
          {v.sessionsLabel}
          {v.lastActivityLabel ? ` · ${v.lastActivityLabel}` : ""}
        </span>
      </div>
      {chips.length > 0 && (
        <ul className="mt-1 flex flex-wrap gap-1">
          {chips.map((b) => (
            <li
              key={b}
              className="rounded bg-stone-100 px-2 py-0.5 font-mono text-xs text-stone-700"
              title={b}
            >
              {b}
            </li>
          ))}
          {v.overflow > 0 && (
            <li>
              <button
                type="button"
                className="px-1 text-xs text-stone-600 underline"
                onClick={() => setOpen(!open)}
              >
                {open ? "show less" : `+${v.overflow} more`}
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
