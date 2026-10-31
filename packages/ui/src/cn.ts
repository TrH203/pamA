import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// Teach tailwind-merge the custom tokens from theme.css so `text-ui` (a size) and `text-fg`
// (a colour) are not treated as conflicting, and `rounded-card` overrides `rounded-control`.
const merge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["ui"],
      radius: ["control", "card"],
      shadow: ["popover"],
    },
  },
});

/** Join class names; later Tailwind utilities win over earlier ones. */
export function cn(...inputs: ClassValue[]): string {
  return merge(clsx(inputs));
}
