import { Link, Outlet, createRootRouteWithContext, type ErrorComponentProps } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";

export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
  notFoundComponent: NotFound,
  errorComponent: RootError,
});

function RootError({ error, reset }: ErrorComponentProps) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-lg font-medium">Can’t load the admin panel</p>
      <p className="max-w-md text-sm text-muted-foreground">{error instanceof Error ? error.message : String(error)}</p>
      <Button onClick={() => { reset(); window.location.reload(); }}>Retry</Button>
    </div>
  );
}

function NotFound() {
  return (
    <div className="flex min-h-[60dvh] flex-col items-center justify-center gap-3 text-center">
      <p className="text-5xl font-bold text-muted-foreground/40">404</p>
      <p className="text-lg font-medium">Page not found</p>
      <Button asChild variant="outline">
        <Link to="/">Back to dashboard</Link>
      </Button>
    </div>
  );
}
