import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Bell, BellOff, Fingerprint, KeyRound, LogOut, Monitor, Moon, Plus, Sun, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { PushTopic } from "@beamhop/sdk/admin-contract";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
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
import { api, enc, errorMessage } from "@/lib/api";
import { registerPasskey } from "@/lib/auth";
import { currentSubscription, pushSupported, storedTopics, subscribePush, unsubscribePush } from "@/lib/push";
import { useTheme, type Theme } from "@/lib/theme";
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
        <PasskeysCard passkeys={me.passkeys} />
        <PushCard />
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
  const tooShort = pw.length > 0 && pw.length < 10;
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
            set.mutate({ password: pw, currentPassword: hasPassword ? current : undefined });
          }}
        >
          <input type="text" autoComplete="username" className="hidden" readOnly />
          {hasPassword && (
            <div className="space-y-2">
              <Label htmlFor="pw-current">Current password</Label>
              <Input id="pw-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="pw-new">New password</Label>
            <Input id="pw-new" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} aria-invalid={tooShort} />
            {tooShort && <p className="text-xs text-destructive">Use at least 10 characters</p>}
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

function PasskeysCard({ passkeys }: { passkeys: { id: string; name: string; createdAt: number; lastUsedAt: number | null }[] }) {
  const confirm = useConfirm();
  const [adding, setAdding] = React.useState(false);
  const [name, setName] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const remove = useApiMutation({ fn: (id: string) => api.del(`/auth/passkey/${enc(id)}`), invalidate: [["me"]], success: "Passkey removed" });
  const supported = typeof window !== "undefined" && "PublicKeyCredential" in window;
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await registerPasskey(name.trim() || defaultPasskeyName());
      toast.success("Passkey added");
      setAdding(false);
      setName("");
    } catch (err) {
      if ((err as Error).name !== "NotAllowedError") toast.error("Could not add passkey", { description: errorMessage(err) });
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
                if (await confirm({ title: `Remove passkey “${p.name}”?`, destructive: true, confirmText: "Remove" })) remove.mutate(p.id);
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
        onOpenChange={setAdding}
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
        </form>
      </ResponsiveDialog>
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
  { key: "alerts", label: "System alerts", hint: "High load, errors, plugin failures" },
  { key: "users", label: "New users", hint: "When someone joins via invite or is added" },
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
  const enable = async (t = topics) => {
    setBusy(true);
    try {
      setSub(await subscribePush(t));
      toast.success("Push notifications enabled");
    } catch (e) {
      toast.error("Could not enable notifications", { description: errorMessage(e) });
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
  const toggleTopic = (k: PushTopic, on: boolean) => {
    const next = on ? [...new Set([...topics, k])] : topics.filter((t) => t !== k);
    setTopics(next);
    if (sub) enable(next);
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
