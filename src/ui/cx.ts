import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cx(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Shared visible focus ring (2px outline, sky-400 on the dark theme gives > 3:1 contrast). */
export const focusRing =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";
