import * as ToastPrimitive from "@radix-ui/react-toast";
import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { cn } from "../cn.ts";

export type ToastTone = "info" | "success" | "danger";
export interface ToastInput {
  title: ReactNode;
  description?: ReactNode;
  tone?: ToastTone;
  /** Milliseconds; errors stay longer by default. */
  duration?: number;
}
interface ToastItem extends ToastInput {
  id: number;
}

const ICON = { info: Info, success: CircleCheck, danger: CircleAlert } as const;
const TONE: Record<ToastTone, string> = {
  info: "text-muted",
  success: "text-success",
  danger: "text-danger",
};

interface ToastApi {
  toast: (t: ToastInput) => void;
  success: (title: ReactNode, description?: ReactNode) => void;
  error: (title: ReactNode, description?: ReactNode) => void;
}
const ToastContext = createContext<ToastApi | null>(null);

let seq = 0;

export function ToastProvider({
  children,
  closeLabel = "Dismiss",
}: {
  children: ReactNode;
  closeLabel?: string;
}) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const toast = useCallback((t: ToastInput) => {
    seq += 1;
    const id = seq;
    setItems((xs) => [...xs.slice(-3), { ...t, id }]);
  }, []);
  const value = useMemo<ToastApi>(
    () => ({
      toast,
      success: (title, description) => toast({ title, description, tone: "success" }),
      error: (title, description) => toast({ title, description, tone: "danger", duration: 8000 }),
    }),
    [toast],
  );
  return (
    <ToastContext.Provider value={value}>
      <ToastPrimitive.Provider swipeDirection="right">
        {children}
        {items.map((t) => {
          const tone = t.tone ?? "info";
          const Icon = ICON[tone];
          return (
            <ToastPrimitive.Root
              key={t.id}
              duration={t.duration ?? 4000}
              type={tone === "danger" ? "foreground" : "background"}
              onOpenChange={(open) => {
                if (!open) setItems((xs) => xs.filter((x) => x.id !== t.id));
              }}
              className={cn(
                "flex items-start gap-3 rounded-card border border-line bg-surface p-3 pr-9 text-fg shadow-popover",
                "relative data-[state=open]:animate-slide-in data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)]",
              )}
            >
              <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", TONE[tone])} />
              <div className="min-w-0 space-y-0.5">
                <ToastPrimitive.Title className="text-ui font-medium">
                  {t.title}
                </ToastPrimitive.Title>
                {t.description && (
                  <ToastPrimitive.Description className="text-ui text-muted">
                    {t.description}
                  </ToastPrimitive.Description>
                )}
              </div>
              <ToastPrimitive.Close
                aria-label={closeLabel}
                className="absolute right-2 top-2 inline-flex size-6 items-center justify-center rounded-control text-faint hover:bg-hover hover:text-fg"
              >
                <X aria-hidden className="size-3.5" />
              </ToastPrimitive.Close>
            </ToastPrimitive.Root>
          );
        })}
        <ToastPrimitive.Viewport className="fixed bottom-0 right-0 z-[60] flex w-full max-w-sm flex-col gap-2 p-4 outline-none" />
      </ToastPrimitive.Provider>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast needs a <ToastProvider>");
  return api;
}
