import { createFileRoute, redirect } from "@tanstack/react-router";
import { HttpError } from "@/lib/api";
import { meQuery } from "@/queries/auth";
import { AppShell } from "@/components/layout/app-shell";

export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ context, location }) => {
    try {
      const me = await context.queryClient.ensureQueryData(meQuery);
      return { me };
    } catch (e) {
      if (e instanceof HttpError && (e.status === 401 || e.status === 403)) {
        throw redirect({ to: "/login", search: { redirect: location.pathname === "/" ? undefined : location.pathname } });
      }
      throw e;
    }
  },
  component: AppShell,
});
