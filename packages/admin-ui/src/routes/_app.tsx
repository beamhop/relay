import { createFileRoute, redirect } from "@tanstack/react-router";
import { HttpError } from "@/lib/api";
import { meQuery } from "@/queries/auth";
import { AppShell } from "@/components/layout/app-shell";
import { AppLoadError } from "@/components/route-error";

export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ context, location }) => {
    try {
      const me = await context.queryClient.ensureQueryData(meQuery);
      return { me };
    } catch (e) {
      if (e instanceof HttpError && (e.status === 401 || e.status === 403)) {
        throw redirect({ to: "/login", search: { redirect: location.href === "/" ? undefined : location.href } });
      }
      throw e;
    }
  },
  component: AppShell,
  // the shell itself failed: full screen, not the per-page defaultErrorComponent (there's no shell to show it in)
  errorComponent: AppLoadError,
});
