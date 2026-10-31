import type {
  HTMLAttributes,
  TableHTMLAttributes,
  TdHTMLAttributes,
  ThHTMLAttributes,
} from "react";
import { cn } from "../cn.ts";

/** A table inside a bordered card that scrolls sideways on narrow screens instead of the page. */
export function Table({
  className,
  wrapperClassName,
  label,
  ...rest
}: TableHTMLAttributes<HTMLTableElement> & { wrapperClassName?: string; label?: string }) {
  return (
    <section
      className={cn("overflow-x-auto rounded-card border border-line bg-surface", wrapperClassName)}
      aria-label={label}
    >
      <table className={cn("w-full border-collapse text-left text-ui", className)} {...rest} />
    </section>
  );
}

export function THead({ className, ...rest }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn("border-b border-line bg-subtle/60", className)} {...rest} />;
}

export function TBody({ className, ...rest }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn("divide-y divide-line", className)} {...rest} />;
}

export function TR({ className, ...rest }: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr className={cn("align-top transition-colors hover:bg-subtle/50", className)} {...rest} />
  );
}

export function TH({ className, ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      scope="col"
      className={cn("whitespace-nowrap px-3 py-2 text-xs font-medium text-muted", className)}
      {...rest}
    />
  );
}

export function TD({ className, ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn("px-3 py-2.5", className)} {...rest} />;
}
