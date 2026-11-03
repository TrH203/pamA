import { Slot } from "@radix-ui/react-slot";
import { type ButtonHTMLAttributes, forwardRef } from "react";
import { cn } from "../cn.ts";
import { Spinner } from "./Spinner.tsx";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg" | "icon";

const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-contrast hover:bg-accent-hover border border-transparent",
  secondary: "bg-surface text-fg border border-line hover:bg-subtle hover:border-line-strong",
  ghost: "bg-transparent text-muted border border-transparent hover:bg-hover hover:text-fg",
  danger: "bg-surface text-danger-ink border border-line hover:bg-danger-soft hover:border-danger",
};

const SIZE: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-ui gap-1.5",
  md: "h-8 px-3 text-ui gap-2",
  lg: "h-10 px-4 text-sm gap-2",
  icon: "h-8 w-8 p-0",
};

/** Class names for anything that should look like a button (links included). */
export function buttonClass(variant: ButtonVariant = "secondary", size: ButtonSize = "md"): string {
  return cn(
    "inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-control font-medium",
    "transition-colors duration-150 ease-out",
    "disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50",
    "[&_svg]:size-4 [&_svg]:shrink-0",
    VARIANT[variant],
    SIZE[size],
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner, disables the button and sets aria-busy. */
  loading?: boolean;
  /** Render the child element (e.g. a link) with button styles. */
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "secondary",
    size = "md",
    loading = false,
    asChild = false,
    className,
    disabled,
    children,
    type,
    ...rest
  },
  ref,
) {
  const cls = cn(buttonClass(variant, size), className);
  if (asChild) {
    return (
      <Slot ref={ref} className={cls} {...rest}>
        {children}
      </Slot>
    );
  }
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      className={cls}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <Spinner size="sm" label={null} />}
      {children}
    </button>
  );
});
