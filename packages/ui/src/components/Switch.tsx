import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { Check, Minus } from "lucide-react";
import { type ComponentPropsWithoutRef, forwardRef } from "react";
import { cn } from "../cn.ts";

export const Switch = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(function Switch({ className, ...rest }, ref) {
  return (
    <SwitchPrimitive.Root
      ref={ref}
      className={cn(
        "inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent",
        "bg-line-strong transition-colors duration-150 ease-out data-[state=checked]:bg-accent",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...rest}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "block size-4 translate-x-0.5 rounded-full bg-surface shadow-sm transition-transform duration-150 ease-out",
          "data-[state=checked]:translate-x-[18px]",
        )}
      />
    </SwitchPrimitive.Root>
  );
});

export const Checkbox = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(function Checkbox({ className, ...rest }, ref) {
  return (
    <CheckboxPrimitive.Root
      ref={ref}
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-line-strong bg-surface",
        "transition-colors duration-150 ease-out hover:border-accent",
        "data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=checked]:text-accent-contrast",
        "data-[state=indeterminate]:border-accent data-[state=indeterminate]:bg-accent data-[state=indeterminate]:text-accent-contrast",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...rest}
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center">
        {rest.checked === "indeterminate" ? (
          <Minus aria-hidden className="size-3" strokeWidth={3} />
        ) : (
          <Check aria-hidden className="size-3" strokeWidth={3} />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
});
