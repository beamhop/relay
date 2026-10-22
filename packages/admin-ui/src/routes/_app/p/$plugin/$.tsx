import { createFileRoute, Link } from "@tanstack/react-router";
import { Puzzle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { ErrorBoundary } from "@/components/error-boundary";
import { PageSkeleton } from "@/components/page-skeleton";
import { normalizePath, usePluginRegistry } from "@/plugins/registry";

export const Route = createFileRoute("/_app/p/$plugin/$")({ component: PluginHostPage });

function PluginHostPage() {
  const { plugin, _splat } = Route.useParams();
  const reg = usePluginRegistry();
  const want = normalizePath(_splat ?? "");
  const page = reg.pages.find((p) => p.plugin === plugin && normalizePath(p.path) === want);

  if (!page) {
    if (!reg.loaded) return <PageSkeleton />;
    const err = reg.errors[plugin];
    return (
      <EmptyState
        icon={Puzzle}
        title={err ? `Plugin “${plugin}” failed to load` : "Plugin page not found"}
        description={err ?? `No page “/${want}” is registered by ${plugin}.`}
        action={
          <Button variant="outline" asChild>
            <Link to="/plugins/$name" params={{ name: plugin }}>
              Plugin details
            </Link>
          </Button>
        }
      />
    );
  }
  const Component = page.component;
  return (
    <ErrorBoundary key={`${plugin}/${want}`} label={`${plugin}: ${page.title}`}>
      <Component api={page.api} />
    </ErrorBoundary>
  );
}
