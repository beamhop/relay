import * as React from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Fingerprint, KeyRound, Link2, Loader2, Puzzle, QrCode, Smartphone } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { Logo } from "@/components/layout/logo";
import { CopyButton } from "@/components/copy-button";
import { HttpError, errorMessage } from "@/lib/api";
import { loginWithBunker, loginWithExtension, loginWithPasskey, loginWithPassword, startNostrConnect } from "@/lib/auth";

export const Route = createFileRoute("/login")({
  validateSearch: (s: Record<string, unknown>): { redirect?: string } => ({ redirect: typeof s.redirect === "string" ? s.redirect : undefined }),
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const { redirect } = Route.useSearch();
  const [busy, setBusy] = React.useState<string | null>(null);
  const hasExtension = typeof window !== "undefined" && !!window.nostr;
  const passkeySupported = typeof window !== "undefined" && !!window.PublicKeyCredential;

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      if ((await fn()) === false) return; // more input needed (e.g. TOTP code)
      toast.success("Signed in");
      navigate({ to: (redirect && redirect.startsWith("/") && redirect !== "/login" ? redirect : "/") as "/" });
    } catch (e) {
      if ((e as Error)?.name !== "NotAllowedError") toast.error("Sign-in failed", { description: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-muted/30 p-4 pt-safe pb-safe">
      <div className="pointer-events-none absolute -top-40 left-1/2 size-[36rem] -translate-x-1/2 rounded-full bg-primary/20 blur-3xl" />
      <Card className="relative w-full max-w-md shadow-xl">
        <CardHeader className="items-center text-center">
          <Logo className="mx-auto mb-2 size-14" />
          <CardTitle className="text-2xl">beamhop admin</CardTitle>
          <CardDescription>Sign in to manage your relay</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <Button className="h-11 w-full" size="lg" disabled={!!busy} onClick={() => run("ext", loginWithExtension)}>
            {busy === "ext" ? <Loader2 className="animate-spin" /> : <Puzzle />}
            Sign in with extension
          </Button>
          {!hasExtension && <p className="-mt-3 text-center text-xs text-muted-foreground">No NIP-07 extension detected — use a remote signer, password or passkey.</p>}

          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <Separator className="flex-1" /> or <Separator className="flex-1" />
          </div>

          <Tabs defaultValue="bunker">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="bunker"><Smartphone className="size-4" /> Signer</TabsTrigger>
              <TabsTrigger value="password"><KeyRound className="size-4" /> Password</TabsTrigger>
              <TabsTrigger value="passkey"><Fingerprint className="size-4" /> Passkey</TabsTrigger>
            </TabsList>
            <TabsContent value="bunker" className="pt-3">
              <BunkerLogin busy={busy} run={run} />
            </TabsContent>
            <TabsContent value="password" className="pt-3">
              <PasswordLogin busy={busy} run={run} />
            </TabsContent>
            <TabsContent value="passkey" className="space-y-3 pt-3">
              <PasskeyLogin busy={busy} run={run} supported={passkeySupported} />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}

type RunFn = (key: string, fn: () => Promise<unknown>) => Promise<void>;

function BunkerLogin({ busy, run }: { busy: string | null; run: RunFn }) {
  const [input, setInput] = React.useState("");
  const [connect, setConnect] = React.useState<{ uri: string; cancel: () => void } | null>(null);
  const [authUrl, setAuthUrl] = React.useState<string>();
  React.useEffect(() => () => connect?.cancel(), [connect]);

  const startConnect = async () => {
    try {
      const c = await startNostrConnect(setAuthUrl);
      setConnect(c);
      run("nostrconnect", () => c.done).finally(() => setConnect(null));
    } catch (e) {
      toast.error("Could not start Nostr Connect", { description: errorMessage(e) });
    }
  };

  return (
    <div className="space-y-4">
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (input.trim()) run("bunker", () => loginWithBunker(input, setAuthUrl));
        }}
      >
        <Label htmlFor="bunker">Bunker URL or NIP-05</Label>
        <div className="flex gap-2">
          <Input id="bunker" placeholder="bunker://… or name@domain" value={input} onChange={(e) => setInput(e.target.value)} autoComplete="off" />
          <Button type="submit" disabled={!!busy || !input.trim()}>
            {busy === "bunker" ? <Loader2 className="animate-spin" /> : <Link2 />}
            Connect
          </Button>
        </div>
      </form>
      {authUrl && (
        <p className="rounded-md bg-amber-500/10 p-2 text-xs">
          Your signer requests approval:{" "}
          <a className="font-medium text-primary underline" href={authUrl} target="_blank" rel="noreferrer">
            open authorization page
          </a>
        </p>
      )}
      {connect ? (
        <div className="space-y-2 rounded-lg border bg-muted/40 p-3">
          <p className="flex items-center gap-2 text-sm font-medium">
            <Loader2 className="size-4 animate-spin" /> Waiting for your signer…
          </p>
          <p className="text-xs text-muted-foreground">Paste this into Amber, nsec.app or another NIP-46 signer, or open it directly on this device.</p>
          <div className="flex items-center gap-1">
            <code className="min-w-0 flex-1 truncate rounded bg-background px-2 py-1.5 text-xs">{connect.uri}</code>
            <CopyButton value={connect.uri} label="Connection URI" />
          </div>
          <div className="flex gap-2">
            <Button asChild variant="outline" size="sm" className="flex-1">
              <a href={connect.uri}>Open signer app</a>
            </Button>
            <Button variant="ghost" size="sm" onClick={() => connect.cancel()}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="outline" className="w-full" disabled={!!busy} onClick={startConnect}>
          <QrCode /> Use nostrconnect:// instead
        </Button>
      )}
    </div>
  );
}

function PasswordLogin({ busy, run }: { busy: string | null; run: RunFn }) {
  const [login, setLogin] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [totp, setTotp] = React.useState("");
  const [needTotp, setNeedTotp] = React.useState(false);
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        run("password", async () => {
          try {
            return await loginWithPassword(login.trim(), password, totp);
          } catch (err) {
            // first step of a 2FA login: just reveal the code field instead of reporting a failure
            if (err instanceof HttpError && err.code === "totp_required") {
              setNeedTotp(true);
              return false;
            }
            if (/totp|2fa|code/i.test(errorMessage(err))) setNeedTotp(true);
            throw err;
          }
        });
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="login">npub, hex pubkey or NIP-05 name</Label>
        <Input id="login" autoComplete="username" value={login} onChange={(e) => setLogin(e.target.value)} required />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="password">Password</Label>
        <Input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      </div>
      {needTotp && (
        <div className="space-y-1.5">
          <Label htmlFor="totp">Authenticator code</Label>
          <Input id="totp" inputMode="numeric" autoComplete="one-time-code" value={totp} onChange={(e) => setTotp(e.target.value)} />
        </div>
      )}
      <Button type="submit" className="w-full" disabled={!!busy}>
        {busy === "password" && <Loader2 className="animate-spin" />} Sign in
      </Button>
    </form>
  );
}

function PasskeyLogin({ busy, run, supported }: { busy: string | null; run: RunFn; supported: boolean }) {
  const [login, setLogin] = React.useState("");
  if (!supported) return <p className="text-sm text-muted-foreground">This browser doesn’t support passkeys.</p>;
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        run("passkey", () => loginWithPasskey(login.trim() || undefined));
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="pk-login">Account (optional)</Label>
        <Input id="pk-login" autoComplete="username webauthn" placeholder="npub or name — leave empty for discoverable passkeys" value={login} onChange={(e) => setLogin(e.target.value)} />
      </div>
      <Button type="submit" className="w-full" disabled={!!busy}>
        {busy === "passkey" ? <Loader2 className="animate-spin" /> : <Fingerprint />} Sign in with passkey
      </Button>
    </form>
  );
}
