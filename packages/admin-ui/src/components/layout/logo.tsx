import { cn } from "@/lib/utils";

export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 512 512" className={cn("size-8", className)} aria-hidden>
      <defs>
        <linearGradient id="bh-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8b5cf6" />
          <stop offset="1" stopColor="#5b21b6" />
        </linearGradient>
      </defs>
      <rect width="512" height="512" rx="116" fill="url(#bh-g)" />
      <path d="M104 360 Q184 92 264 360 Q324 196 384 300" fill="none" stroke="#fff" strokeWidth="40" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="408" cy="200" r="36" fill="#fff" />
    </svg>
  );
}
