import { ChevronDown } from "lucide-react";
import {
  forwardRef,
  type InputHTMLAttributes,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { cn } from "../cn.ts";

const control = cn(
  "w-full rounded-control border border-line bg-surface text-ui text-fg placeholder:text-faint",
  "transition-colors duration-150 ease-out hover:border-line-strong",
  "focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring/40",
  "disabled:cursor-not-allowed disabled:opacity-60",
  "aria-[invalid=true]:border-danger",
);

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return <input ref={ref} className={cn(control, "h-8 px-2.5", className)} {...rest} />;
  },
);

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...rest }, ref) {
  return (
    <textarea ref={ref} className={cn(control, "px-2.5 py-2 leading-5", className)} {...rest} />
  );
});

/** A styled native select: keyboard, screen reader and mobile pickers work out of the box. */
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...rest }, ref) {
    return (
      <span className={cn("relative inline-flex w-full", className)}>
        <select ref={ref} className={cn(control, "h-8 appearance-none pl-2.5 pr-8")} {...rest}>
          {children}
        </select>
        <ChevronDown
          aria-hidden
          className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-faint"
        />
      </span>
    );
  },
);
