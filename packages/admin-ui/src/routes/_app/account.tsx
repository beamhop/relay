import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Bell, BellOff, EyeOff, Fingerprint, KeyRound, LogOut, Monitor, Moon, Plus, ShieldCheck, Sun, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { PushTopic } from "@beamhop/sdk/admin-contract";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { PageHeader } from "@/components/page-header";
import { UserAvatar } from "@/components/user-avatar";
import { CopyButton } from "@/components/copy-button";
import { RoleBadge } from "@/components/badges";
import { ResponsiveDialog } from "@/components/responsive-dialog";
import { useConfirm } from "@/components/confirm";
import { useLogout } from "@/components/layout/user-menu";
import { useMe, useSystem } from "@/queries/auth";
import { useApiMutation } from "@/queries/client";
import { api, enc, errorMessage, HttpError } from "@/lib/api";
import { registerPasskey } from "@/lib/auth";
import { currentSubscription, pushSupported, storedTopics, subscribePush, unsubscribePush } from "@/lib/push";
import { useTheme, type Theme } from "@/lib/theme";
import { remoteMediaPref, useBoolPref, WORLD_MAP_TILE_HOST, worldMapPref } from "@/lib/prefs";
import { displayName, toNpub } from "@/lib/nostr";
import { timeAgo } from "@/lib/format";

export const Route = createFileRoute("/_app/account")({ component: AccountPage });

function AccountPage() {
  const { data: me } = useMe();
  const logout = useLogout();
  if (!me) return null;
  const npub = toNpub(me.pubkey);
  return (
    <div className="space-y-4">
      <PageHeader title="Account" description="Your admin identity, sign-in methods and preferences" />
      <Card>
        <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <UserAvatar pubkey={me.pubkey} profile={me.profile} size={64} />
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-lg font-semibold">{displayName(me.pubkey, me.profile)}</h2>
              <RoleBadge role={me.role} />
            </div>
            <div className="flex min-w-0 items-center gap-1">
              <code className="truncate text-xs text-muted-foreground">{npub}</code>
              <CopyButton value={npub} />
            </div>
            <p className="text-xs text-muted-foreground">{me.permissions.length} permissions</p>
          </div>
          <Button variant="outline" onClick={logout}>
            <LogOut /> Sign out
          </Button>
        </CardContent>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <PasswordCard hasPassword={me.hasPassword} />
        <TotpCard hasPassword={me.hasPassword} enabled={me.hasTotp} />
        <PasskeysCard passkeys={me.passkeys} hasPassword={me.hasPassword} />
        <PushCard />
        <PrivacyCard />
        <ThemeCard />
      </div>
    </div>
  );
}

function PasswordCard({ hasPassword }: { hasPassword: boolean }) {
  const [current, setCurrent] = React.useState("");
  const [pw, setPw] = React.useState("");
  const [pw2, setPw2] = React.useState("");
  const set = useApiMutation({
    fn: (body: { password: string; currentPassword?: string }) => api.post("/auth/password/set", body),
    invalidate: [["me"]],
    success: hasPassword ? "Password changed" : "Password set",
    onSuccess: () => {
      setCurrent("");
      setPw("");
      setPw2("");
    },
  });
  // matches the server's minimum (admin-api PasswordSet)
  const tooShort = pw.length > 0 && pw.length < 8;
  const mismatch = pw2.length > 0 && pw !== pw2;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="size-4" /> Password
        </CardTitle>
        <CardDescription>{hasPassword ? "Change the password used to sign in without a Nostr signer." : "Set a password to sign in without a Nostr signer."}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          id="pw-form"
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (tooShort || mismatch || !pw) return;
            // the server waives the current password right after a Nostr sign-in, so only send it when entered
            set.mutate({ password: pw, currentPassword: hasPassword && current ? current : undefined });
          }}
        >
          <input type="text" autoComplete="username" className="hidden" readOnly />
          {hasPassword && (
            <div className="space-y-2">
              <Label htmlFor="pw-current">Current password</Label>
              <Input id="pw-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
              <p className="text-xs text-muted-foreground">Not needed within 10 minutes of signing in with your Nostr key.</p>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="pw-new">New password</Label>
            <Input id="pw-new" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} aria-invalid={tooShort} />
            {tooShort && <p className="text-xs text-destructive">Use at least 8 characters</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="pw-new2">Confirm new password</Label>
            <Input id="pw-new2" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} aria-invalid={mismatch} />
            {mismatch && <p className="text-xs text-destructive">Passwords don't match</p>}
          </div>
        </form>
      </CardContent>
      <CardFooter className="justify-end">
        <Button type="submit" form="pw-form" disabled={!pw || tooShort || pw !== pw2 || set.isPending}>
          {hasPassword ? "Change password" : "Set password"}
        </Button>
      </CardFooter>
    </Card>
  );
}

function TotpCard({ hasPassword, enabled }: { hasPassword: boolean; enabled: boolean }) {
  const [setup, setSetup] = React.useState<{ secret: string; uri: string } | null>(null);
  const [disabling, setDisabling] = React.useState(false);
  const [code, setCode] = React.useState("");
  const close = () => {
    setSetup(null);
    setDisabling(false);
    setCode("");
  };
  const [reauth, setReauth] = React.useState<Reauth | null>(null);
  const [starting, setStarting] = React.useState(false);
  const begin = async (currentPassword?: string) => {
    setStarting(true);
    try {
      setSetup(await api.post<{ secret: string; uri: string }>("/auth/totp/setup", currentPassword ? { currentPassword } : {}));
      setReauth(null);
    } catch (err) {
      // a session that isn't fresh confirms the password (or signs in again when the password is newer than it)
      if (err instanceof HttpError && err.code === "reauth_required") setReauth(currentPassword ? "signin" : "password");
      else toast.error("Could not start setup", { description: errorMessage(err) });
    } finally {
      setStarting(false);
    }
  };
  const enable = useApiMutation({
    fn: (c: string) => api.post("/auth/totp/enable", { code: c }),
    invalidate: [["me"]],
    success: "Two-factor authentication enabled",
    onSuccess: close,
  });
  const disable = useApiMutation({
    fn: (c: string) => api.post("/auth/totp/disable", { code: c }),
    invalidate: [["me"]],
    success: "Two-factor authentication disabled",
    onSuccess: close,
  });
  const pending = enable.isPending || disable.isPending;
  const validCode = /^\d{6}$/.test(code.replace(/\s+/g, ""));
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="size-4" /> Two-factor authentication
        </CardTitle>
        <CardDescription>Require a code from an authenticator app when signing in with your password.</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          {!hasPassword ? "Set a password first to enable two-factor authentication." : enabled ? "Enabled — password sign-ins ask for a 6-digit code." : "Not enabled."}
        </p>
      </CardContent>
      <CardFooter className="justify-end">
        {enabled ? (
          <Button variant="outline" onClick={() => setDisabling(true)}>
            Disable
          </Button>
        ) : (
          <Button variant="outline" onClick={() => begin()} disabled={!hasPassword || starting}>
            <ShieldCheck /> Set up
          </Button>
        )}
      </CardFooter>
      <ResponsiveDialog
        open={!!setup || disabling}
        onOpenChange={(o) => !o && close()}
        title={disabling ? "Disable two-factor authentication" : "Set up authenticator app"}
        description={disabling ? "Enter a current code from your authenticator app. A code you just used to sign in can't be reused — wait for the next one." : "Add this account to your authenticator app, then enter the 6-digit code it shows."}
        footer={
          <Button type="submit" form="totp-form" disabled={!validCode || pending}>
            {disabling ? "Disable" : "Verify and enable"}
          </Button>
        }
      >
        <form
          id="totp-form"
          className="space-y-3 pb-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!validCode) return;
            const c = code.replace(/\s+/g, "");
            if (disabling) disable.mutate(c);
            else enable.mutate(c);
          }}
        >
          {setup && (
            <div className="space-y-2">
              <Label>Secret key</Label>
              <div className="flex min-w-0 items-center gap-1 rounded-md border bg-muted/40 px-3 py-2">
                <code className="min-w-0 flex-1 truncate text-sm tracking-wider">{setup.secret.replace(/(.{4})/g, "$1 ").trim()}</code>
                <CopyButton value={setup.secret} />
              </div>
              <a href={setup.uri} className="text-sm text-primary underline-offset-4 hover:underline">
                Open in authenticator app
              </a>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="totp-code">Code</Label>
            <Input
              id="totp-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoFocus
            />
          </div>
        </form>
      </ResponsiveDialog>
      <ReauthDialog reauth={reauth} action="set up two-factor authentication" busy={starting} onCancel={() => setReauth(null)} onSubmit={(pw) => begin(pw)} />
    </Card>
  );
}

/** "password": the server wants the current password; "signin": only a fresh sign-in will do */
type Reauth = "password" | "signin";

/** Asks a session that isn't fresh to prove it's still its owner before a security-sensitive change. */
function ReauthDialog({ reauth, action, busy, onCancel, onSubmit }: { reauth: Reauth | null; action: string; busy: boolean; onCancel: () => void; onSubmit: (pw: string) => void }) {
  const [pw, setPw] = React.useState("");
  // keeps showing the last mode while the dialog animates closed
  const [mode, setMode] = React.useState<Reauth>("password");
  React.useEffect(() => {
    if (reauth) setMode(reauth);
    else setPw("");
  }, [reauth]);
  return (
    <ResponsiveDialog
      open={!!reauth}
      onOpenChange={(o) => !o && onCancel()}
      title="Confirm it's you"
      footer={
        mode === "password" ? (
          <Button type="submit" form="reauth-form" disabled={!pw || busy}>
            Continue
          </Button>
        ) : (
          <Button variant="outline" onClick={onCancel}>
            Close
          </Button>
        )
      }
    >
      {mode === "password" ? (
        <form
          id="reauth-form"
          className="space-y-2 pb-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (pw) onSubmit(pw);
          }}
        >
          <Label htmlFor="reauth-pw">Current password</Label>
          <Input id="reauth-pw" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
          <p className="text-xs text-muted-foreground">Confirm your password to {action}, or sign in again.</p>
        </form>
      ) : (
        <p className="pb-2 text-sm text-muted-foreground">For your security, sign out and sign in again, then {action} within 15 minutes.</p>
      )}
    </ResponsiveDialog>
  );
}

function PasskeysCard({ passkeys, hasPassword }: { passkeys: { id: string; name: string; createdAt: number; lastUsedAt: number | null }[]; hasPassword: boolean }) {
  const confirm = useConfirm();
  const [adding, setAdding] = React.useState(false);
  const [name, setName] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [reauth, setReauth] = React.useState<Reauth | null>(null);
  const [pw, setPw] = React.useState("");
  const qc = useQueryClient();
  const [removing, setRemoving] = React.useState<{ id: string; reauth: Reauth } | null>(null);
  const [removeBusy, setRemoveBusy] = React.useState(false);
  const remove = async (id: string, currentPassword?: string) => {
    setRemoveBusy(true);
    try {
      await api.del(`/auth/passkey/${enc(id)}`, currentPassword ? { currentPassword } : undefined);
      toast.success("Passkey removed");
      setRemoving(null);
      qc.invalidateQueries({ queryKey: ["me"] });
    } catch (err) {
      if (err instanceof HttpError && err.code === "reauth_required") setRemoving({ id, reauth: hasPassword && !currentPassword ? "password" : "signin" });
      else toast.error("Could not remove passkey", { description: errorMessage(err) });
    } finally {
      setRemoveBusy(false);
    }
  };
  const supported = typeof window !== "undefined" && "PublicKeyCredential" in window;
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await registerPasskey(name.trim() || defaultPasskeyName(), pw || undefined);
      toast.success("Passkey added");
      setAdding(false);
      setName("");
      setReauth(null);
      setPw("");
    } catch (err) {
      // no password, or one the server won't accept for this session (set during it): a password field can't help
      if (err instanceof HttpError && err.code === "reauth_required") setReauth(hasPassword && !pw ? "password" : "signin");
      else if ((err as Error).name !== "NotAllowedError") toast.error("Could not add passkey", { description: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Fingerprint className="size-4" /> Passkeys
        </CardTitle>
        <CardDescription>Sign in with Face ID, Touch ID, Windows Hello or a security key.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {passkeys.length === 0 && <p className="text-sm text-muted-foreground">No passkeys registered.</p>}
        {passkeys.map((p) => (
          <div key={p.id} className="flex items-center gap-3 rounded-lg border p-3">
            <Fingerprint className="size-5 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{p.name || "Passkey"}</p>
              <p className="text-xs text-muted-foreground">
                Added {timeAgo(p.createdAt)} · {p.lastUsedAt ? `last used ${timeAgo(p.lastUsedAt)}` : "never used"}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-destructive"
              aria-label="Remove passkey"
              onClick={async () => {
                if (await confirm({ title: `Remove passkey “${p.name}”?`, destructive: true, confirmText: "Remove" })) await remove(p.id);
              }}
            >
              <Trash2 />
            </Button>
          </div>
        ))}
      </CardContent>
      <CardFooter className="justify-end">
        <Button variant="outline" onClick={() => setAdding(true)} disabled={!supported}>
          <Plus /> Add passkey
        </Button>
      </CardFooter>
      <ResponsiveDialog
        open={adding}
        onOpenChange={(o) => {
          setAdding(o);
          if (!o) {
            setReauth(null);
            setPw("");
          }
        }}
        title="Add passkey"
        description="Give it a name so you can recognise it later."
        footer={
          <Button type="submit" form="pk-form" disabled={busy}>
            {busy ? "Waiting for authenticator…" : "Continue"}
          </Button>
        }
      >
        <form id="pk-form" onSubmit={add} className="space-y-2 pb-2">
          <Label htmlFor="pk-name">Name</Label>
          <Input id="pk-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={defaultPasskeyName()} />
          {reauth === "signin" && (
            <p className="text-xs text-muted-foreground">For your security, sign out and sign in again, then add the passkey within 15 minutes.</p>
          )}
          {reauth === "password" && (
            <>
              <Label htmlFor="pk-pw">Current password</Label>
              <Input id="pk-pw" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />
              <p className="text-xs text-muted-foreground">Confirm your password to add a passkey, or sign in again.</p>
            </>
          )}
        </form>
      </ResponsiveDialog>
      <ReauthDialog
        reauth={removing?.reauth ?? null}
        action="remove a passkey"
        busy={removeBusy}
        onCancel={() => setRemoving(null)}
        onSubmit={(pw) => removing && remove(removing.id, pw)}
      />
    </Card>
  );
}

function defaultPasskeyName() {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/.test(ua) ? "iPhone" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "Device";
  return `${os} passkey`;
}

const TOPICS: { key: PushTopic; label: string; hint: string }[] = [
  { key: "reports", label: "New reports", hint: "When a user files a report" },
  { key: "alerts", label: "System alerts", hint: "Rejection spikes, memory and event-loop pressure, auto-bans, word-filter flags" },
];

function PushCard() {
  const { data: sys } = useSystem();
  const [sub, setSub] = React.useState<PushSubscription | null | undefined>(undefined);
  const [topics, setTopics] = React.useState<PushTopic[]>(storedTopics);
  const [busy, setBusy] = React.useState(false);
  const supported = pushSupported();
  React.useEffect(() => {
    currentSubscription().then(setSub, () => setSub(null));
  }, []);
  const enable = async (t = topics, quiet = false) => {
    setBusy(true);
    try {
      setSub(await subscribePush(t));
      if (!quiet) toast.success("Push notifications enabled");
      return true;
    } catch (e) {
      toast.error(quiet ? "Could not update notifications" : "Could not enable notifications", { description: errorMessage(e) });
      return false;
    } finally {
      setBusy(false);
    }
  };
  const disable = async () => {
    setBusy(true);
    try {
      await unsubscribePush();
      setSub(null);
      toast.success("Push notifications disabled");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const toggleTopic = async (k: PushTopic, on: boolean) => {
    const prev = topics;
    const next = on ? [...new Set([...topics, k])] : topics.filter((t) => t !== k);
    setTopics(next);
    if (!sub) return;
    // no topics left: a subscription for nothing would still read "enabled", so turn push off instead
    if (!next.length) return disable();
    if (await enable(next, true)) toast.success("Notification topics updated");
    else setTopics(prev); // keep the checkboxes matching what the server has
  };
  const unavailable = !supported ? "This browser doesn't support web push. On iOS, add the app to your home screen first." : sys && !sys.pushEnabled ? "Push notifications are not configured on this server." : undefined;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bell className="size-4" /> Notifications
        </CardTitle>
        <CardDescription>Get push notifications on this device, even when the panel is closed.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {unavailable ? (
          <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">{unavailable}</p>
        ) : (
          TOPICS.map((t) => (
            <label key={t.key} className="flex items-center gap-3 rounded-lg border p-3">
              <Checkbox checked={topics.includes(t.key)} onCheckedChange={(v) => toggleTopic(t.key, v === true)} disabled={busy} />
              <span>
                <span className="block text-sm font-medium">{t.label}</span>
                <span className="block text-xs text-muted-foreground">{t.hint}</span>
              </span>
            </label>
          ))
        )}
      </CardContent>
      {!unavailable && (
        <CardFooter className="justify-end">
          {sub ? (
            <Button variant="outline" onClick={disable} disabled={busy}>
              <BellOff /> Disable on this device
            </Button>
          ) : (
            <Button onClick={() => enable()} disabled={busy || sub === undefined || !topics.length}>
              <Bell /> Enable notifications
            </Button>
          )}
        </CardFooter>
      )}
    </Card>
  );
}

/** Third-party fetches the panel makes only after an explicit opt-in, per browser. */
function PrivacyCard() {
  const [remote, setRemote] = useBoolPref(remoteMediaPref);
  const [map, setMap] = useBoolPref(worldMapPref);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <EyeOff className="size-4" /> Privacy
        </CardTitle>
        <CardDescription>Stored on this device. Every remote fetch shows the other server your IP address and when you looked.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <PrefRow
          label="Load remote images and video"
          hint="Profile pictures, banners and note media hosted elsewhere. Off: generated avatars, and media loads only when you click it. Media on this relay always loads; reported media never loads on its own."
          checked={remote}
          onChange={setRemote}
        />
        <PrefRow label={`Load world map tiles from ${WORLD_MAP_TILE_HOST}`} hint="Draws the dashboard map (needs a GeoIP database)." checked={map} onChange={setMap} />
      </CardContent>
    </Card>
  );
}

function PrefRow({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  const id = React.useId();
  return (
    <label htmlFor={id} className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border p-3">
      <span>
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </label>
  );
}

function ThemeCard() {
  const { theme, setTheme } = useTheme();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Appearance</CardTitle>
        <CardDescription>Stored on this device</CardDescription>
      </CardHeader>
      <CardContent>
        <ToggleGroup type="single" variant="outline" value={theme} onValueChange={(v) => v && setTheme(v as Theme)} className="w-full">
          <ToggleGroupItem value="system" className="flex-1">
            <Monitor /> System
          </ToggleGroupItem>
          <ToggleGroupItem value="light" className="flex-1">
            <Sun /> Light
          </ToggleGroupItem>
          <ToggleGroupItem value="dark" className="flex-1">
            <Moon /> Dark
          </ToggleGroupItem>
        </ToggleGroup>
      </CardContent>
    </Card>
  );
}
