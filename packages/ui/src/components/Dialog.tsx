import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import {
  type ComponentPropsWithoutRef,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useRef,
  useState,
} from "react";
import { cn } from "../cn.ts";
import { Button } from "./Button.tsx";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({
  className,
  children,
  title,
  description,
  closeLabel = "Close",
  ...rest
}: Omit<ComponentPropsWithoutRef<typeof DialogPrimitive.Content>, "title"> & {
  title: ReactNode;
  description?: ReactNode;
  closeLabel?: string;
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-overlay data-[state=open]:animate-fade-in" />
      <DialogPrimitive.Content
        className={cn(
          "fixed inset-x-4 top-[12vh] z-50 mx-auto max-h-[76vh] w-auto max-w-md overflow-y-auto",
          "rounded-card border border-line bg-surface p-5 text-fg shadow-popover",
          "data-[state=open]:animate-pop-in focus-visible:outline-none",
          className,
        )}
        {...(description ? {} : { "aria-describedby": undefined })}
        {...rest}
      >
        <div className="mb-3 flex items-start gap-3 pr-6">
          <div className="space-y-1">
            <DialogPrimitive.Title className="text-base font-semibold">
              {title}
            </DialogPrimitive.Title>
            {description && (
              <DialogPrimitive.Description className="text-ui text-muted">
                {description}
              </DialogPrimitive.Description>
            )}
          </div>
        </div>
        {children}
        <DialogPrimitive.Close
          aria-label={closeLabel}
          className="absolute right-3 top-3 inline-flex size-7 items-center justify-center rounded-control text-faint transition-colors hover:bg-hover hover:text-fg"
        >
          <X aria-hidden className="size-4" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogFooter({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("mt-5 flex flex-wrap justify-end gap-2", className)}>{children}</div>;
}

export interface ConfirmOptions {
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button for destructive actions. */
  danger?: boolean;
}

/** A controlled confirm dialog. Prefer `useConfirm()` to replace `window.confirm`. */
export function ConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
}: ConfirmOptions & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={title}
        description={description}
        role="alertdialog"
        closeLabel={cancelLabel}
      >
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </Button>
          <Button
            variant={danger ? "danger" : "primary"}
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
            autoFocus
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;
const ConfirmContext = createContext<ConfirmFn | null>(null);

/** Hosts one ConfirmDialog for the subtree; `useConfirm()` opens it and resolves true/false. */
export function ConfirmProvider({
  children,
  defaults,
}: {
  children: ReactNode;
  defaults?: Pick<ConfirmOptions, "confirmLabel" | "cancelLabel">;
}) {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  const settle = (ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
  };
  const confirm = useCallback<ConfirmFn>((o) => {
    resolver.current?.(false);
    setOpts(o);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <ConfirmDialog
        {...defaults}
        {...(opts ?? { title: "" })}
        open={opts !== null}
        onOpenChange={(open) => {
          if (!open) {
            settle(false);
            setOpts(null);
          }
        }}
        onConfirm={() => settle(true)}
      />
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const fn = useContext(ConfirmContext);
  if (!fn) throw new Error("useConfirm needs a <ConfirmProvider>");
  return fn;
}
