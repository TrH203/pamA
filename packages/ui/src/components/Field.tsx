import {
  Children,
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useId,
} from "react";
import { cn } from "../cn.ts";

/**
 * Label + control + hint/error. The single child control gets `id`, `aria-describedby` and
 * `aria-invalid` wired up, so callers only pass the input.
 */
export function Field({
  label,
  hint,
  error,
  children,
  className,
  labelAside,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactElement<Record<string, unknown>>;
  className?: string;
  /** Extra content on the label row (e.g. a status badge). */
  labelAside?: ReactNode;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  const child = Children.only(children);
  const control = isValidElement(child)
    ? cloneElement(child, {
        id: (child.props.id as string | undefined) ?? id,
        "aria-describedby": describedBy,
        "aria-invalid": error ? true : undefined,
      })
    : child;
  const controlId = isValidElement(child) ? ((child.props.id as string | undefined) ?? id) : id;
  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-center gap-2">
        <label htmlFor={controlId} className="text-ui font-medium text-fg">
          {label}
        </label>
        {labelAside}
      </div>
      {control}
      {hint && (
        <p id={hintId} className="text-xs text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-xs text-danger-ink">
          {error}
        </p>
      )}
    </div>
  );
}
