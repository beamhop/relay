import { StrictMode } from "react";
import { z } from "zod";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { queryClient } from "@/queries/client";
import { onUnauthorized } from "@/lib/api";
import { resetPluginUis } from "@/plugins/loader";
import { ThemeProvider } from "@/lib/theme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { ConfirmProvider } from "@/components/confirm";
import { PageSkeleton } from "@/components/page-skeleton";
import { RouteError } from "@/components/route-error";
import { installPreloadErrorReload, registerServiceWorker } from "@/lib/app-update";
import "./index.css";

// registered before the router loads any route chunk
installPreloadErrorReload();

// zod probes `new Function` for its JIT path, which the admin CSP (no unsafe-eval) reports as a violation
z.config({ jitless: true });

const router = createRouter({
  routeTree,
  basepath: import.meta.env.BASE_URL.replace(/\/$/, "") || "/",
  context: { queryClient },
  defaultPreload: "intent",
  defaultPreloadStaleTime: 0,
  defaultPendingComponent: PageSkeleton,
  // per page, inside the app shell (the root route keeps its own full-screen error)
  defaultErrorComponent: RouteError,
  defaultPendingMs: 150,
  scrollRestoration: true,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

let leaving = false;
onUnauthorized(() => {
  if (leaving || router.state.location.pathname === "/login") return;
  leaving = true;
  queryClient.removeQueries({ queryKey: ["me"] });
  // the next sign-in may be another admin with fewer permissions: drop everything this session loaded (cached
  // responses, plugin UIs) once the app shell has unmounted, so mounted queries don't refetch into more 401s
  router
    .navigate({ to: "/login", search: { redirect: router.state.location.href } })
    .finally(() => {
      queryClient.clear();
      resetPluginUis();
      leaving = false;
    });
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider delayDuration={300}>
          <ConfirmProvider>
            <RouterProvider router={router} />
          </ConfirmProvider>
          <Toaster position="top-center" richColors={false} closeButton />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);

registerServiceWorker();
