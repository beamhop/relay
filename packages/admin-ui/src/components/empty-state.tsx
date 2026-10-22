import type * as React from "react";
import { Inbox } from "lucide-react";
import { cn } from "@/lib/utils";

export function EmptyState({
  icon: Icon = Inbox, title, description, action, className,
}: { icon?: React.ComponentType<{ className?: string }>; title: string; description?: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed px-6 py-12 text-center", className)}>
      <div className="flex size-12 items-center justify-center rounded-full bg-muted">
        <Icon className="size-6 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <p className="font-medium">{title}</p>
        {description && <p className="max-w-sm text-sm text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-destructive/40 bg-destructive/5 px-6 py-8 text-center text-sm">
      <p className="font-medium text-destructive">Something went wrong</p>
      <p className="text-muted-foreground">{error instanceof Error ? error.message : String(error)}</p>
      {retry && (
        <button className="mt-1 text-sm font-medium text-primary underline-offset-4 hover:underline" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  );
}
