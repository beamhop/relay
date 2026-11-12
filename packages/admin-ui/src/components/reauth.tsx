import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ResponsiveDialog } from "@/components/responsive-dialog";
import { HttpError } from "@/lib/api";

/** "password": the server wants the current password; "signin": only a fresh sign-in will do */
export type Reauth = "password" | "signin";

/**
 * A security-sensitive action the server refuses with `reauth_required` while the session isn't fresh. `reauth` then
 * says what helps: "password" (send it again with the current password) when the admin has one and didn't just give
 * it, else "signin" (a password newer than the session, or none: only signing in again will do). `retry(pw)` resends
 * the last call's argument with the password. Other errors go to `onError`.
 */
export function useReauthAction<A>(action: (arg: A, currentPassword?: string) => Promise<unknown>, o: { hasPassword: boolean; onError: (err: unknown) => void }) {
  const [reauth, setReauth] = React.useState<Reauth | null>(null);
  const [busy, setBusy] = React.useState(false);
  const last = React.useRef<A>(undefined as A);
  const run = async (arg: A, currentPassword?: string) => {
    last.current = arg;
    setBusy(true);
    try {
      await action(arg, currentPassword);
      setReauth(null);
      return true;
    } catch (err) {
      if (err instanceof HttpError && err.code === "reauth_required") setReauth(o.hasPassword && !currentPassword ? "password" : "signin");
      else o.onError(err);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { reauth, busy, run, retry: (pw: string) => run(last.current, pw), cancel: () => setReauth(null) };
}

/** Asks a session that isn't fresh to prove it's still its owner before a security-sensitive change. */
export function ReauthDialog({ reauth, action, busy, onCancel, onSubmit }: { reauth: Reauth | null; action: string; busy: boolean; onCancel: () => void; onSubmit: (pw: string) => void }) {
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
