// A searchable scope picker (WAI-ARIA combobox with a listbox): projects and tasks to answer from.
// Multi-select for the console Chat, single-select (with "All my approved work") for the desktop
// popup. Keyboard: type to filter, ArrowUp/Down to move, Enter to pick, Escape to close.
import { cn, Input } from "@pama/ui";
import { Check, X } from "lucide-react";
import { useId, useMemo, useRef, useState } from "react";

export interface ScopeRef {
  type: "project" | "bundle" | "session";
  id: string;
}

export interface ScopeOption {
  ref: ScopeRef;
  label: string;
  /** Group heading, e.g. "Projects" or "Tasks". */
  group: string;
  /** Extra text that is searched and shown dimmed (e.g. the task's project). */
  hint?: string;
}

const same = (a: ScopeRef, b: ScopeRef) => a.type === b.type && a.id === b.id;

export function ScopeCombobox({
  options,
  value,
  onChange,
  multiple = false,
  label,
  placeholder,
  emptyLabel,
  allLabel,
  removeLabel,
  disabled,
  className,
}: {
  options: ScopeOption[];
  value: ScopeRef[];
  onChange: (v: ScopeRef[]) => void;
  multiple?: boolean;
  /** Accessible name of the input. */
  label: string;
  placeholder: string;
  emptyLabel: string;
  /** Single mode: the first option, which clears the scope. */
  allLabel?: string;
  removeLabel?: (name: string) => string;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  const listId = `${id}-list`;
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const all = useMemo<ScopeOption | null>(
    () =>
      !multiple && allLabel
        ? { ref: { type: "project", id: "" }, label: allLabel, group: "" }
        : null,
    [multiple, allLabel],
  );
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const hits = q
      ? options.filter((o) => `${o.label} ${o.hint ?? ""}`.toLowerCase().includes(q))
      : options;
    return all && !q ? [all, ...hits] : hits;
  }, [options, query, all]);

  const isSelected = (o: ScopeOption) =>
    o === all ? value.length === 0 : value.some((v) => same(v, o.ref));
  const labelOf = (r: ScopeRef) => options.find((o) => same(o.ref, r))?.label ?? r.id;

  const pick = (o: ScopeOption) => {
    if (o === all) onChange([]);
    else if (!multiple) onChange([o.ref]);
    else onChange(isSelected(o) ? value.filter((v) => !same(v, o.ref)) : [...value, o.ref]);
    if (!multiple) {
      setOpen(false);
      setQuery("");
    } else setQuery("");
  };

  const singleText = !multiple && !open ? (value[0] ? labelOf(value[0]) : (allLabel ?? "")) : query;
  const optionId = (i: number) => `${id}-opt-${i}`;

  return (
    <div className={cn("relative space-y-2", className)}>
      {multiple && value.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {value.map((r) => (
            <li
              key={`${r.type}:${r.id}`}
              className="inline-flex h-6 items-center gap-1 rounded-full border border-transparent bg-accent-soft pl-2 pr-1 text-xs font-medium text-accent-ink"
            >
              {labelOf(r)}
              {!disabled && (
                <button
                  type="button"
                  aria-label={removeLabel ? removeLabel(labelOf(r)) : `Remove ${labelOf(r)}`}
                  className="inline-flex size-4 items-center justify-center rounded-full hover:bg-hover focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={() => onChange(value.filter((v) => !same(v, r)))}
                >
                  <X aria-hidden className="size-3" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <Input
        ref={input}
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && shown[active] ? optionId(active) : undefined}
        placeholder={placeholder}
        disabled={disabled}
        value={singleText}
        onFocus={() => {
          setOpen(true);
          setActive(0);
        }}
        onBlur={() => {
          setOpen(false);
          setQuery("");
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setActive((i) => Math.min(i + 1, shown.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter" && open) {
            e.preventDefault();
            const o = shown[active];
            if (o) pick(o);
          } else if (e.key === "Escape" && open) {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
            setQuery("");
          }
        }}
      />
      {open && (
        <div
          id={listId}
          role="listbox"
          aria-label={label}
          aria-multiselectable={multiple || undefined}
          className="absolute inset-x-0 z-30 mt-1 max-h-60 overflow-auto rounded-control border border-line bg-surface p-1 shadow-popover"
        >
          {shown.length === 0 && <p className="px-2 py-1.5 text-ui text-muted">{emptyLabel}</p>}
          {shown.map((o, i) => {
            const selected = isSelected(o);
            const heading = o.group && (i === 0 || shown[i - 1]?.group !== o.group);
            return (
              <div key={o === all ? "all" : `${o.ref.type}:${o.ref.id}`} role="presentation">
                {heading && (
                  <p className="px-2 pb-0.5 pt-1.5 text-xs font-medium text-faint">{o.group}</p>
                )}
                <div
                  id={optionId(i)}
                  role="option"
                  aria-selected={selected}
                  tabIndex={-1}
                  // Keep focus in the input so the list does not close before the click lands.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(o)}
                  onKeyDown={() => undefined}
                  onMouseEnter={() => setActive(i)}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-control px-2 py-1.5 text-ui",
                    i === active ? "bg-hover text-fg" : "text-fg",
                  )}
                >
                  <Check
                    aria-hidden
                    className={cn("size-3.5 shrink-0 text-accent", !selected && "invisible")}
                  />
                  <span className="truncate">{o.label}</span>
                  {o.hint && <span className="ml-auto truncate text-xs text-faint">{o.hint}</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
