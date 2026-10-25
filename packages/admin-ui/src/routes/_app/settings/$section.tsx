/* eslint-disable @typescript-eslint/no-explicit-any */
import * as React from "react";
import { tryMutate } from "@/queries/client";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { useFieldArray, useForm, useWatch, type Control, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { FlaskConical, Plus, Save, Trash2, Undo2 } from "lucide-react";
import { RuntimeSettingsSchema } from "@beamhop/sdk-config";
import type { RuntimeSettings } from "@beamhop/sdk/admin-contract";
import { compileRegexFilter, unsafeRegexReason } from "@beamhop/sdk/regex-safety";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Form, FormControl, FormField, FormItem, FormLabel } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/empty-state";
import { ListInput } from "@/components/list-input";
import { BytesField, ListField, NumberField, SelectField, SwitchField, TextField } from "@/components/form-fields";
import { useSaveSettings, useSettings } from "@/queries/misc";
import { useCan } from "@/queries/auth";
import { useUnsavedGuard } from "@/hooks/use-unsaved-guard";
import { SETTINGS_SECTIONS, type SectionKey } from "@/lib/settings-sections";
import { kindName, parsePubkey, shortNpub } from "@/lib/nostr";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/settings/$section")({
  beforeLoad: ({ params }) => {
    if (!SETTINGS_SECTIONS.some((s) => s.key === params.section)) throw notFound();
  },
  component: SectionPage,
});

function SectionPage() {
  const { section } = Route.useParams();
  const key = section as SectionKey;
  const meta = SETTINGS_SECTIONS.find((s) => s.key === key)!;
  const { data, isLoading, error, refetch } = useSettings();
  if (isLoading)
    return (
      <Card>
        <CardContent className="space-y-4">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-10" />
          ))}
        </CardContent>
      </Card>
    );
  if (error || !data) return <ErrorState error={error ?? "No settings"} retry={() => refetch()} />;
  return <SectionForm key={key} sectionKey={key} title={meta.label} description={meta.description} value={data.settings[key]} />;
}

const FIELDS: { [K in SectionKey]: React.ComponentType<{ control: Control<any>; disabled: boolean }> } = {
  info: InfoFields,
  access: AccessFields,
  limits: LimitsFields,
  moderation: ModerationFields,
  retention: RetentionFields,
  nip05: Nip05Fields,
  groups: GroupsFields,
  blossom: BlossomFields,
};

function SectionForm<K extends SectionKey>({ sectionKey, title, description, value }: { sectionKey: K; title: string; description: string; value: RuntimeSettings[K] }) {
  const can = useCan();
  const editable = can("settings.edit");
  const save = useSaveSettings();
  const schema = RuntimeSettingsSchema.shape[sectionKey];
  const form = useForm<any>({
    resolver: zodResolver(schema as any) as Resolver<any>,
    values: value as any,
    resetOptions: { keepDirtyValues: true },
  });
  const Fields: React.ComponentType<{ control: Control<any>; disabled: boolean }> = FIELDS[sectionKey];
  const onSubmit = form.handleSubmit(async (values) => {
    if (sectionKey === "moderation") {
      const filters = values.wordFilters as RuntimeSettings["moderation"]["wordFilters"];
      if (filters.some((w) => !w.pattern.trim())) return void form.setError("root", { message: "Word filters need a pattern" });
      const bad = filters.find((w) => w.isRegex && regexError(w.pattern));
      if (bad) return void form.setError("root", { message: `Regex refused (invalid or unsafe): ${bad.pattern}` });
    }
    // failures are toasted; the form stays dirty so the edit isn't lost
    if (await tryMutate(save, { [sectionKey]: values } as any)) form.reset(values);
  });
  const dirty = form.formState.isDirty;
  useUnsavedGuard(dirty && editable);
  return (
    <Form {...form}>
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </CardHeader>
          <CardContent>
            <fieldset disabled={!editable} className="space-y-5">
              <Fields control={form.control} disabled={!editable} />
            </fieldset>
          </CardContent>
        </Card>
        {form.formState.errors.root && <p className="text-sm text-destructive">{form.formState.errors.root.message}</p>}
        {Object.keys(form.formState.errors).filter((k) => k !== "root").length > 0 && <p className="text-sm text-destructive">Please fix the highlighted fields.</p>}
        {editable && (
          <div
            className={cn(
              "sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-10 flex items-center justify-end gap-2 rounded-xl border bg-background/90 p-2 shadow-sm backdrop-blur transition-opacity md:bottom-4",
              !dirty && "opacity-0 pointer-events-none",
            )}
            // hidden but still in the tab order otherwise
            inert={!dirty}
            aria-hidden={!dirty}
          >
            <span className="mr-auto pl-2 text-sm text-muted-foreground">Unsaved changes</span>
            <Button type="button" variant="ghost" onClick={() => form.reset(structuredClone(value) as any, { keepDirtyValues: false, keepDefaultValues: false })}>
              <Undo2 /> Discard
            </Button>
            <Button type="submit" disabled={save.isPending}>
              <Save /> Save
            </Button>
          </div>
        )}
      </form>
    </Form>
  );
}

const Grid = ({ children, cols = 2 }: { children: React.ReactNode; cols?: 2 | 3 }) => (
  <div className={cn("grid gap-4", cols === 2 ? "sm:grid-cols-2" : "sm:grid-cols-2 lg:grid-cols-3")}>{children}</div>
);
const SubHeading = ({ children, hint }: { children: React.ReactNode; hint?: string }) => (
  <div className="border-t pt-4 first:border-0 first:pt-0">
    <h3 className="text-sm font-semibold">{children}</h3>
    {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
  </div>
);
const pubkeyValidate = (s: string) => (parsePubkey(s) ? undefined : "Invalid pubkey");
// "members" = allow-listed users and staff, but in the public access mode every pubkey counts as a member
// (blossom assertCanUpload, NIP-29 group creation), so on a public relay it is the same as "anyone"
const ACCESS_OPTS = [
  { value: "anyone", label: "Anyone" },
  { value: "members", label: "Members", hint: "allow-listed users and staff (on a public relay: every pubkey)" },
  { value: "admins", label: "Admins only" },
];
const MEMBERS_NOTE = "A relay in the public access mode treats every pubkey as a member, so “Members” lets everyone in there.";

// ---------------------------------------------------------------- sections
function InfoFields({ control }: { control: Control<any> }) {
  return (
    <>
      <Grid>
        <TextField control={control} name="name" label="Name" />
        <TextField control={control} name="contact" label="Contact" placeholder="mailto:admin@example.com" />
      </Grid>
      <TextField control={control} name="description" label="Description" multiline />
      <Grid>
        <TextField control={control} name="icon" label="Icon URL" placeholder="https://…/icon.png" />
        <TextField control={control} name="banner" label="Banner URL" placeholder="https://…/banner.jpg" />
      </Grid>
      <FormField
        control={control}
        name="pubkey"
        render={({ field }) => {
          const hex = field.value ? parsePubkey(field.value) : undefined;
          return (
            <FormItem>
              <FormLabel>Operator pubkey</FormLabel>
              <FormControl>
                <Input {...field} value={field.value ?? ""} placeholder="npub or hex" onBlur={() => hex && hex !== field.value && field.onChange(hex)} aria-invalid={!!field.value && !hex} />
              </FormControl>
              <p className="text-xs text-muted-foreground">{field.value && hex ? `Stored as hex · ${shortNpub(hex, 6)}` : "Advertised in NIP-11 as the relay operator"}</p>
            </FormItem>
          );
        }}
      />
      <Grid>
        <TextField control={control} name="termsOfService" label="Terms of service URL" />
        <TextField control={control} name="postingPolicy" label="Posting policy URL" />
      </Grid>
    </>
  );
}

function AccessFields({ control }: { control: Control<any> }) {
  return (
    <>
      <SelectField
        control={control}
        name="mode"
        label="Access mode"
        options={[
          { value: "public", label: "Public", hint: "anyone can write" },
          { value: "whitelist", label: "Whitelist", hint: "only allow-listed pubkeys" },
          { value: "invite", label: "Invite only", hint: "join with an invite code" },
          { value: "auth-required", label: "Auth required", hint: "any NIP-42 authenticated user" },
        ]}
      />
      <div className="grid gap-2">
        <SwitchField control={control} name="authForRead" label="Require AUTH to read" description="Clients must authenticate (NIP-42) before REQ" />
        <SwitchField control={control} name="authForWrite" label="Require AUTH to write" description="Clients must authenticate (NIP-42) before EVENT" />
        <SwitchField control={control} name="allowInboundToMembers" label="Accept inbound events for members" description="Non-members may publish events that p-tag a member (inbox behaviour)" />
      </div>
    </>
  );
}

function LimitsFields({ control }: { control: Control<any> }) {
  return (
    <>
      <SubHeading>Messages & events</SubHeading>
      <Grid cols={3}>
        <BytesField control={control} name="maxMessageBytes" label="Max message size" />
        <BytesField control={control} name="maxEventBytes" label="Max event size" />
        <NumberField control={control} name="maxContentLength" label="Max content length" suffix="chars" min={0} />
        <NumberField control={control} name="maxEventTags" label="Max tags per event" min={0} />
        <NumberField control={control} name="minPowDifficulty" label="Min PoW difficulty" min={0} description="NIP-13, 0 = off" />
      </Grid>
      <SubHeading>Timestamps</SubHeading>
      <Grid>
        <NumberField control={control} name="createdAtUpperSec" label="Max future skew" suffix="sec" min={0} />
        <NumberField control={control} name="createdAtLowerSec" label="Max event age" suffix="sec" min={0} description="0 = accept any age" />
      </Grid>
      <SubHeading>Subscriptions</SubHeading>
      <Grid cols={3}>
        <NumberField control={control} name="maxSubscriptions" label="Max subscriptions" min={1} />
        <NumberField control={control} name="maxFilters" label="Max filters per REQ" min={1} />
        <NumberField control={control} name="maxLimit" label="Max limit" min={1} />
        <NumberField control={control} name="defaultLimit" label="Default limit" min={1} />
      </Grid>
      <SubHeading hint="Per pubkey / IP. Individual users can be given overrides.">Rate limits</SubHeading>
      <Grid cols={3}>
        <NumberField control={control} name="eventsPerMinute" label="Events / minute" min={0} />
        <NumberField control={control} name="reqPerMinute" label="REQs / minute" min={0} />
        <NumberField control={control} name="connectionsPerIp" label="Connections per IP" min={1} />
      </Grid>
    </>
  );
}

/** Same check the server applies on save: invalid patterns and ones that could backtrack catastrophically. */
const regexError = (pattern: string): string | undefined => unsafeRegexReason(pattern);
type WordFilter = RuntimeSettings["moderation"]["wordFilters"][number];
const matches = (w: WordFilter, text: string) => {
  if (!w.pattern) return false;
  if (w.isRegex) {
    // the relay's own matcher, so the preview scans long text exactly as the relay does
    const compiled = compileRegexFilter(w.pattern);
    return "test" in compiled && compiled.test(text);
  }
  return text.toLowerCase().includes(w.pattern.toLowerCase());
};

function ModerationFields({ control, disabled }: { control: Control<any>; disabled: boolean }) {
  const { fields, append, remove } = useFieldArray({ control, name: "wordFilters", keyName: "_key" });
  const filters = (useWatch({ control, name: "wordFilters" }) ?? []) as WordFilter[];
  const [test, setTest] = React.useState("");
  const fmtKind = (k: number) => `${kindName(k)} (${k})`;
  return (
    <>
      <SubHeading>Kinds</SubHeading>
      <Grid>
        <ListField control={control} name="kindAllowlist" label="Kind allow-list" numeric placeholder="Empty = all kinds" format={fmtKind} description="If set, only these kinds are accepted" />
        <ListField control={control} name="kindBlocklist" label="Kind block-list" numeric placeholder="e.g. 4, 1059" format={fmtKind} />
      </Grid>
      <NumberField control={control} name="autoBanReportThreshold" label="Auto-ban after N reports" min={0} description="Distinct members reporting the same pubkey (0 = off)" className="sm:max-w-xs" />

      <SubHeading hint="Matched case-insensitively against event content. Reject refuses the event; Shadow-ban tells the client it was accepted but drops it; Report accepts it, adds it to the Reports queue and raises an alert.">
        Word filters
      </SubHeading>
      <div className="space-y-2">
        {fields.map((f, i) => {
          const w = filters[i];
          const err = w?.isRegex ? regexError(w.pattern) : undefined;
          const hit = !!test && !!w && w.enabled && matches(w, test);
          return (
            <div key={f._key} className={cn("space-y-3 rounded-lg border p-3 transition-colors", hit && "border-amber-500 bg-amber-500/5")}>
              <div className="flex items-start gap-2">
                <FormField
                  control={control}
                  name={`wordFilters.${i}.pattern`}
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormControl>
                        <Input {...field} placeholder={w?.isRegex ? "regular expression" : "word or phrase"} className={cn(w?.isRegex && "font-mono")} aria-invalid={!!err} />
                      </FormControl>
                      {err && <p className="text-xs text-destructive">{err}</p>}
                    </FormItem>
                  )}
                />
                <Button type="button" variant="ghost" size="icon" onClick={() => remove(i)} disabled={disabled} aria-label="Remove filter">
                  <Trash2 />
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <InlineSwitch control={control} name={`wordFilters.${i}.enabled`} label="Enabled" />
                <InlineSwitch control={control} name={`wordFilters.${i}.isRegex`} label="Regex" />
                <FormField
                  control={control}
                  name={`wordFilters.${i}.action`}
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange} disabled={disabled}>
                      <SelectTrigger size="sm" className="w-32">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="reject">Reject</SelectItem>
                        <SelectItem value="shadow">Shadow-ban</SelectItem>
                        <SelectItem value="report">Report</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                />
                <FormField
                  control={control}
                  name={`wordFilters.${i}.kinds`}
                  render={({ field }) => (
                    <div className="min-w-48 flex-1">
                      <ListInput numeric value={field.value ?? []} onChange={field.onChange} placeholder="Kinds (empty = all)" format={fmtKind} />
                    </div>
                  )}
                />
                {hit && <span className="text-xs font-medium text-amber-600 dark:text-amber-400">matches test text</span>}
              </div>
            </div>
          );
        })}
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          onClick={() => append({ id: crypto.randomUUID().slice(0, 8), pattern: "", isRegex: false, kinds: [], action: "reject", enabled: true } satisfies WordFilter)}
        >
          <Plus /> Add word filter
        </Button>
      </div>
      {fields.length > 0 && (
        <div className="space-y-2 rounded-lg bg-muted/50 p-3">
          <Label htmlFor="wf-test" className="flex items-center gap-1.5">
            <FlaskConical className="size-4" /> Test filters
          </Label>
          <Input id="wf-test" value={test} onChange={(e) => setTest(e.target.value)} placeholder="Type sample content to see which filters match" className="bg-background" />
          {test && (
            <p className="text-xs text-muted-foreground">
              {filters.filter((w) => w.enabled && matches(w, test)).length} of {filters.filter((w) => w.enabled).length} enabled filter(s) match
              {filters.some((w) => w.enabled && matches(w, test)) && ` → ${filters.find((w) => w.enabled && matches(w, test))!.action}`}
            </p>
          )}
        </div>
      )}
    </>
  );
}

function InlineSwitch({ control, name, label, ariaLabel }: { control: Control<any>; name: string; label: string; ariaLabel?: string }) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={!!field.value} onCheckedChange={field.onChange} aria-label={ariaLabel} />
          {label}
        </label>
      )}
    />
  );
}

type RetentionRule = RuntimeSettings["retention"]["rules"][number];
function RetentionFields({ control, disabled }: { control: Control<any>; disabled: boolean }) {
  const { fields, append, remove } = useFieldArray({ control, name: "rules", keyName: "_key" });
  const rules = (useWatch({ control, name: "rules" }) ?? []) as RetentionRule[];
  const describe = (r?: RetentionRule) => {
    if (!r) return "";
    const what = r.kinds?.length ? r.kinds.map(kindName).join(", ") : "all kinds";
    const parts = [];
    if (r.maxAgeDays) parts.push(`delete ${what} older than ${r.maxAgeDays} days`);
    if (r.maxPerPubkey) parts.push(`keep at most ${r.maxPerPubkey} ${what} per pubkey`);
    return parts.length ? parts.join("; ") : "No limits set — rule has no effect";
  };
  return (
    <>
      <NumberField control={control} name="intervalMinutes" label="Run every" suffix="min" min={1} className="sm:max-w-xs" />
      <SubHeading hint="Rules run periodically; deleted events cannot be recovered.">Rules</SubHeading>
      <div className="space-y-3">
        {fields.map((f, i) => (
          <div key={f._key} className="space-y-3 rounded-lg border p-3">
            <div className="flex items-center gap-2">
              <InlineSwitch control={control} name={`rules.${i}.enabled`} label="" ariaLabel={`Enable rule ${i + 1}`} />
              <p className="flex-1 text-sm">{describe(rules[i])}</p>
              <Button type="button" variant="ghost" size="icon" onClick={() => remove(i)} disabled={disabled} aria-label="Remove rule">
                <Trash2 />
              </Button>
            </div>
            <Grid cols={3}>
              <ListField control={control} name={`rules.${i}.kinds`} label="Kinds" numeric placeholder="all kinds" format={(k: number) => `${kindName(k)} (${k})`} />
              <NumberField control={control} name={`rules.${i}.maxAgeDays`} label="Max age" suffix="days" min={0} optional placeholder="—" />
              <NumberField control={control} name={`rules.${i}.maxPerPubkey`} label="Max per pubkey" min={0} optional placeholder="—" />
            </Grid>
            <ListField
              control={control}
              name={`rules.${i}.exemptPubkeys`}
              label="Exempt pubkeys"
              placeholder="npub or hex"
              validate={pubkeyValidate}
              format={(p: string) => shortNpub(parsePubkey(p) ?? p, 4)}
            />
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          onClick={() => append({ id: crypto.randomUUID().slice(0, 8), enabled: true, kinds: [], maxAgeDays: 90, exemptPubkeys: [] } satisfies RetentionRule)}
        >
          <Plus /> Add rule
        </Button>
      </div>
    </>
  );
}

function Nip05Fields({ control }: { control: Control<any> }) {
  return (
    <>
      <SwitchField control={control} name="enabled" label="Serve /.well-known/nostr.json" description="Users with a NIP-05 name get name@domain identifiers" />
      <TextField control={control} name="domain" label="Domain" placeholder="relay.example.com" description="When set, /.well-known/nostr.json only answers requests for this host" />
      <ListField control={control} name="relays" label="Advertised relays" placeholder="wss://…" validate={(s) => (/^wss?:\/\//.test(s) ? undefined : "Must start with wss://")} />
    </>
  );
}

function GroupsFields({ control }: { control: Control<any> }) {
  return (
    <>
      <SwitchField control={control} name="enabled" label="Enable NIP-29 groups" />
      <SelectField control={control} name="creation" label="Who can create groups" options={ACCESS_OPTS} description={MEMBERS_NOTE} className="sm:max-w-md" />
    </>
  );
}

function BlossomFields({ control }: { control: Control<any> }) {
  return (
    <>
      <Grid>
        <BytesField control={control} name="maxUploadBytes" label="Max upload size" />
        <BytesField control={control} name="defaultQuotaBytes" label="Default quota per user" zeroLabel="Unlimited" description="0 = unlimited" />
      </Grid>
      <SelectField control={control} name="uploadAccess" label="Who can upload" options={ACCESS_OPTS} description={MEMBERS_NOTE} className="sm:max-w-md" />
      <ListField control={control} name="allowedMimeTypes" label="Allowed MIME types" placeholder="image/*, video/mp4…" description="Wildcards like image/* are supported" />
      <div className="grid gap-2">
        <SwitchField control={control} name="stripExif" label="Strip EXIF metadata" description="Remove location and camera data from images" />
        <SwitchField control={control} name="thumbnails" label="Generate thumbnails" />
        <SwitchField control={control} name="requireApproval" label="Require approval" description="New uploads are pending until approved by a moderator" />
      </div>
    </>
  );
}
