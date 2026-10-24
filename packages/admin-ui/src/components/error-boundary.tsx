import * as React from "react";
import { AlertTriangle } from "lucide-react";

/** `onRetry` runs before the subtree re-renders (e.g. drop the cached responses it crashed on, so Retry refetches). */
export class ErrorBoundary extends React.Component<
  { children: React.ReactNode; label?: string; fallback?: React.ReactNode; onRetry?: () => unknown },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error(`[beamhop] ${this.props.label ?? "component"} crashed`, error);
  }
  render() {
    if (this.state.error)
      return (
        this.props.fallback ?? (
          <div className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div className="min-w-0 space-y-1">
              <p className="font-medium">{this.props.label ?? "This section"} failed to render</p>
              <p className="break-words text-muted-foreground">{this.state.error.message}</p>
              <button
                className="text-primary underline-offset-4 hover:underline"
                onClick={async () => {
                  await this.props.onRetry?.();
                  this.setState({ error: null });
                }}
              >
                Retry
              </button>
            </div>
          </div>
        )
      );
    return this.props.children;
  }
}
