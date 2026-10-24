import * as React from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AlertTriangle, ArrowLeft, ExternalLink, Save, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { ErrorState } from "@/components/empty-state";
import { JsonSchemaForm, type JSONSchema } from "@/components/json-schema-form";
import { ToneBadge } from "@/components/badges";
import { usePluginSettings, usePluginToggle, usePlugins, useSavePluginSettings } from "@/queries/misc";
import { useCan } from "@/queries/auth";
import { usePluginRegistry } from "@/plugins/registry";

export const Route = createFileRoute("/_app/plugins/$name")({ component: PluginPage });

function PluginPage() {
  const { name } = Route.useParams();
  const plugins = usePlugins();
  const p = plugins.data?.find((x) => x.name === name);
  const settings = usePluginSettings(name);
  const save = useSavePluginSettings(name);
  const toggle = usePluginToggle();
  const can = useCan();
  const reg = usePluginRegistry();
  const [draft, setDraft] = React.useState<Record<string, unknown> | null>(null);
  React.useEffect(() => setDraft(null), [settings.data]);
  const schema = (settings.data?.schema ?? p?.settingsSchema) as JSONSchema | undefined;
  const values = draft ?? settings.data?.values ?? {};
  const pages = reg.pages.filter((x) => x.plugin === name);

  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" asChild className="-ml-2">
        <Link to="/plugins">
          <ArrowLeft /> Plugins
        </Link>
      </Button>
      {plugins.isLoading ? (
        <Skeleton className="h-32 rounded-xl" />
      ) : !p ? (
        <ErrorState error={plugins.error ?? `Plugin “${name}” not found`} retry={() => plugins.refetch()} />
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2">
                {p.name} <span className="text-sm font-normal text-muted-foreground">v{p.version}</span>
                <ToneBadge t={p.status === "running" ? "green" : p.status === "error" ? "red" : "gray"}>{p.status}</ToneBadge>
                <Badge variant="outline" className="font-normal">{p.source}</Badge>
              </CardTitle>
              <CardDescription>{p.description}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <label className="flex items-center justify-between gap-4 rounded-lg border p-3">
                <span className="text-sm font-medium">Enabled</span>
                <Switch checked={p.enabled} disabled={!can("plugins.manage") || toggle.isPending} onCheckedChange={(enabled) => toggle.mutate({ name, enabled })} />
              </label>
              {(p.error || reg.errors[name]) && (
                <p className="flex items-start gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  <span className="break-all whitespace-pre-wrap">{p.error ?? `Admin UI failed to load: ${reg.errors[name]}`}</span>
                </p>
              )}
              {pages.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {pages.map((pg) => (
                    <Button key={pg.path} variant="outline" size="sm" asChild>
                      <Link to="/p/$plugin/$" params={{ plugin: name, _splat: pg.path.replace(/^\/+/, "") }}>
                        <ExternalLink /> {pg.title}
                      </Link>
                    </Button>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Settings</CardTitle>
              <CardDescription>Changes are applied to the running plugin</CardDescription>
            </CardHeader>
            <CardContent>
              {settings.isLoading ? (
                <Skeleton className="h-24" />
              ) : settings.error ? (
                <ErrorState error={settings.error} retry={() => settings.refetch()} />
              ) : !schema || !Object.keys(schema).length || ((schema.type === "object" || !schema.type) && !Object.keys(schema.properties ?? {}).length) ? (
                <p className="text-sm text-muted-foreground">This plugin has no configurable settings.</p>
              ) : (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (draft) save.mutate(draft);
                  }}
                  className="space-y-4"
                >
                  <JsonSchemaForm key={name} schema={schema} value={values} onChange={setDraft} disabled={!can("plugins.manage")} />
                  {can("plugins.manage") && (
                    <div className="flex justify-end gap-2">
                      {draft && (
                        <Button type="button" variant="ghost" onClick={() => setDraft(null)}>
                          <Undo2 /> Discard
                        </Button>
                      )}
                      <Button type="submit" disabled={!draft || save.isPending}>
                        <Save /> Save settings
                      </Button>
                    </div>
                  )}
                </form>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
