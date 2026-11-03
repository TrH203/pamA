import { LoaderCircle } from "lucide-react";
import { cn } from "../cn.ts";

const SIZES = { sm: "size-3.5", md: "size-4", lg: "size-6" } as const;

/** Indeterminate progress. Pass `label={null}` when the surrounding text already says it. */
export function Spinner({
  size = "md",
  label = "Loading",
  className,
}: {
  size?: keyof typeof SIZES;
  label?: string | null;
  className?: string;
}) {
  return (
    <span role={label ? "status" : undefined} className={cn("inline-flex items-center", className)}>
      <LoaderCircle
        aria-hidden
        className={cn("animate-spin text-current motion-reduce:animate-none", SIZES[size])}
      />
      {label && <span className="sr-only">{label}</span>}
    </span>
  );
}
