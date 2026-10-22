import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { PageHeader } from "@/components/page-header";
import { SETTINGS_SECTIONS } from "@/lib/settings-sections";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/settings")({ component: SettingsLayout });

function SettingsLayout() {
  return (
    <div className="space-y-4">
      <PageHeader title="Settings" description="Runtime settings apply immediately — no restart needed" />
      <div className="grid gap-4 md:grid-cols-[200px_1fr] lg:gap-6">
        <nav className="-mx-3 flex gap-1 overflow-x-auto px-3 pb-1 sm:-mx-6 sm:px-6 md:mx-0 md:flex-col md:overflow-visible md:px-0">
          {SETTINGS_SECTIONS.map((s) => (
            <Link
              key={s.key}
              to="/settings/$section"
              params={{ section: s.key }}
              className={cn("flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm whitespace-nowrap text-muted-foreground transition-colors hover:bg-muted hover:text-foreground")}
              activeProps={{ className: "bg-muted font-medium text-foreground" }}
            >
              <s.icon className="size-4" />
              {s.label}
            </Link>
          ))}
        </nav>
        <div className="min-w-0">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
