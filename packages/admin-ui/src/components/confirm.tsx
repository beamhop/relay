import * as React from "react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface ConfirmOptions {
  title: string;
  description?: React.ReactNode;
  confirmText?: string;
  destructive?: boolean;
  /** optional checkboxes shown in the dialog; result contains their values */
  options?: { key: string; label: string; default?: boolean }[];
  /** optional free-text input (e.g. reason) */
  input?: { label: string; placeholder?: string };
}
export interface ConfirmResult { options: Record<string, boolean>; input: string }

type Pending = ConfirmOptions & { resolve: (r: ConfirmResult | null) => void };
const Ctx = React.createContext<(o: ConfirmOptions) => Promise<ConfirmResult | null>>(async () => null);

/** `const confirm = useConfirm(); if (await confirm({...})) …` */
export const useConfirm = () => React.useContext(Ctx);

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = React.useState<Pending | null>(null);
  const [opts, setOpts] = React.useState<Record<string, boolean>>({});
  const [input, setInput] = React.useState("");

  const confirm = React.useCallback(
    (o: ConfirmOptions) =>
      new Promise<ConfirmResult | null>((resolve) => {
        setOpts(Object.fromEntries((o.options ?? []).map((x) => [x.key, !!x.default])));
        setInput("");
        setPending({ ...o, resolve });
      }),
    [],
  );

  const close = (ok: boolean) => {
    pending?.resolve(ok ? { options: opts, input } : null);
    setPending(null);
  };

  return (
    <Ctx.Provider value={confirm}>
      {children}
      <AlertDialog open={!!pending} onOpenChange={(o) => !o && close(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pending?.title}</AlertDialogTitle>
            {pending?.description && <AlertDialogDescription asChild><div>{pending.description}</div></AlertDialogDescription>}
          </AlertDialogHeader>
          {pending?.input && (
            <div className="space-y-2">
              <Label htmlFor="confirm-input">{pending.input.label}</Label>
              <Input id="confirm-input" value={input} placeholder={pending.input.placeholder} onChange={(e) => setInput(e.target.value)} />
            </div>
          )}
          {!!pending?.options?.length && (
            <div className="space-y-3">
              {pending.options.map((o) => (
                <label key={o.key} className="flex min-h-8 cursor-pointer items-center gap-3 text-sm">
                  <Checkbox checked={opts[o.key]} onCheckedChange={(v) => setOpts((s) => ({ ...s, [o.key]: v === true }))} />
                  {o.label}
                </label>
              ))}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={cn(pending?.destructive && buttonVariants({ variant: "destructive" }))}
              onClick={(e) => {
                e.preventDefault();
                close(true);
              }}
            >
              {pending?.confirmText ?? "Confirm"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Ctx.Provider>
  );
}
