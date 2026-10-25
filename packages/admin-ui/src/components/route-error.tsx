import * as React from "react";
import { useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isChunkLoadError } from "@/lib/app-update";
import { refreshAfterCrash } from "@/queries/client";

/** Full-screen error for the root and the app shell route (e.g. /auth/me failing with something other than a 401). */
export function AppLoadError({ error, reset }: ErrorComponentProps) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-lg font-medium">Can’t load the admin panel</p>
      <p className="max-w-md text-sm text-muted-foreground">{error instanceof Error ? error.message : String(error)}</p>
      <Button onClick={() => { reset(); window.location.reload(); }}>Retry</Button>
    </div>
  );
}

/**
 * The router's default error component: a page whose loader, lazy chunk or render fails shows this in its place,
 * inside the app shell, so navigation keeps working. A chunk that can't load (usually a deploy since this tab
 * opened) needs a full reload; anything else can retry with fresh data.
 */
export function RouteError({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  const qc = useQueryClient();
  const chunk = isChunkLoadError(error);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    console.error("[beamhop] page crashed", error);
  }, [error]);
  const retry = async () => {
    setBusy(true);
    try {
      await refreshAfterCrash(qc);
      await router.invalidate();
    } finally {
      setBusy(false);
      reset();
    }
  };
  return (
    <div className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="min-w-0 space-y-1">
        <p className="font-medium">{chunk ? "This page couldn’t be loaded" : "Page failed to render"}</p>
        <p className="break-words text-muted-foreground">
          {chunk ? "The admin panel was probably updated since this tab was opened. Reload to get the new version." : error instanceof Error ? error.message : String(error)}
        </p>
        {chunk ? (
          <Button size="sm" className="mt-1" onClick={() => window.location.reload()}>
            Reload
          </Button>
        ) : (
          <button className="text-primary underline-offset-4 hover:underline disabled:opacity-50" disabled={busy} onClick={retry}>
            Retry
          </button>
        )}
      </div>
    </div>
  );
}
