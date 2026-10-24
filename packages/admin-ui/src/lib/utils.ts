import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Returns the URL only if it parses as http(s); untrusted Nostr metadata must not become javascript:/data: links or styles. */
export function safeUrl(u: string | undefined | null): string | undefined {
  if (!u) return undefined;
  try {
    const p = new URL(u);
    return p.protocol === "https:" || p.protocol === "http:" ? p.href : undefined;
  } catch {
    return undefined;
  }
}
