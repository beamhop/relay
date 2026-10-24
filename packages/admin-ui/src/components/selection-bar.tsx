import type * as React from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Floating bulk-action bar shown while items are selected. */
/** `busy` disables the actions while one is running, so a double tap doesn't send it twice. */
export function SelectionBar({ count, onClear, busy, children }: { count: number; onClear: () => void; busy?: boolean; children: React.ReactNode }) {
  if (!count) return null;
  return (
    <div className="fixed inset-x-0 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-40 flex justify-center px-3 md:bottom-6 md:pl-[var(--sidebar-width)]">
      <div className="flex max-w-full items-center gap-1 overflow-x-auto rounded-full border bg-popover p-1.5 pl-4 shadow-lg animate-in slide-in-from-bottom-4 fade-in">
        <span className="shrink-0 pr-2 text-sm font-medium tabular-nums">{count} selected</span>
        <fieldset disabled={busy} className="contents">
          {children}
        </fieldset>
        <Button size="icon-sm" variant="ghost" className="rounded-full" onClick={onClear} aria-label="Clear selection">
          <X />
        </Button>
      </div>
    </div>
  );
}
