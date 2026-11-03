import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import { Search } from "lucide-react";
import { type ComponentType, useEffect } from "react";

export interface CommandItem {
  id: string;
  label: string;
  group?: string;
  icon?: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  /** Extra words that should match (e.g. the old tab name). */
  keywords?: string[];
  shortcut?: string;
  run: () => void;
}

/** Open/close on Cmd+K (macOS) or Ctrl+K elsewhere. */
export function useCommandShortcut(toggle: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);
}

/** Cmd+K palette: type to filter, arrows to move, Enter to run. */
export function CommandPalette({
  open,
  onOpenChange,
  items,
  placeholder = "Type a command or search…",
  empty = "No results.",
  title = "Command palette",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: CommandItem[];
  placeholder?: string;
  empty?: string;
  title?: string;
}) {
  const groups = [...new Set(items.map((i) => i.group ?? ""))];
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-overlay data-[state=open]:animate-fade-in" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed inset-x-4 top-[14vh] z-50 mx-auto max-w-lg overflow-hidden rounded-card border border-line bg-surface text-fg shadow-popover data-[state=open]:animate-pop-in"
        >
          <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
          <Command label={title} loop>
            <div className="flex items-center gap-2 border-b border-line px-3">
              <Search aria-hidden className="size-4 text-faint" />
              <Command.Input
                autoFocus
                placeholder={placeholder}
                className="h-11 w-full bg-transparent text-sm text-fg outline-none placeholder:text-faint"
              />
            </div>
            <Command.List className="max-h-80 overflow-y-auto p-1.5">
              <Command.Empty className="px-3 py-6 text-center text-ui text-muted">
                {empty}
              </Command.Empty>
              {groups.map((g) => (
                <Command.Group
                  key={g || "_"}
                  heading={g || undefined}
                  className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-faint"
                >
                  {items
                    .filter((i) => (i.group ?? "") === g)
                    .map((i) => {
                      const Icon = i.icon;
                      return (
                        <Command.Item
                          key={i.id}
                          value={`${i.label} ${i.id}`}
                          keywords={i.keywords}
                          onSelect={() => {
                            onOpenChange(false);
                            i.run();
                          }}
                          className="flex cursor-pointer items-center gap-2.5 rounded-control px-2 py-2 text-ui text-fg data-[selected=true]:bg-accent-soft data-[selected=true]:text-accent-ink"
                        >
                          {Icon && <Icon aria-hidden className="size-4 text-faint" />}
                          <span className="flex-1">{i.label}</span>
                          {i.shortcut && <kbd className="text-xs text-faint">{i.shortcut}</kbd>}
                        </Command.Item>
                      );
                    })}
                </Command.Group>
              ))}
            </Command.List>
          </Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
