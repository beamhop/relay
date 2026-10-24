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

/** a queued dialog carries its own checkbox/input state, initialised when it's enqueued */
type Pending = ConfirmOptions & { resolve: (r: ConfirmResult | null) => void; values: Record<string, boolean>; text: string };
const Ctx = React.createContext<(o: ConfirmOptions) => Promise<ConfirmResult | null>>(async () => null);

/** `const confirm = useConfirm(); if (await confirm({...})) …` */
export const useConfirm = () => React.useContext(Ctx);

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  // queued so a second confirm() while one is open waits its turn instead of orphaning the first promise
  const [queue, setQueue] = React.useState<Pending[]>([]);
  const pending = queue[0] ?? null;
  const updateCurrent = (patch: Partial<Pick<Pending, "values" | "text">>) =>
    setQueue((q) => (q.length ? [{ ...q[0], ...patch }, ...q.slice(1)] : q));

  const confirm = React.useCallback(
    (o: ConfirmOptions) =>
      new Promise<ConfirmResult | null>((resolve) =>
        setQueue((q) => [...q, { ...o, resolve, values: Object.fromEntries((o.options ?? []).map((x) => [x.key, !!x.default])), text: "" }]),
      ),
    [],
  );

  const close = (ok: boolean) => {
    if (!pending) return;
    pending.resolve(ok ? { options: pending.values, input: pending.text } : null);
    // drop only the dialog just resolved (items are copied on edit, so match by its resolver): a second close
    // before the re-render must not drop the next queued dialog
    const done = pending.resolve;
    setQueue((q) => (q[0]?.resolve === done ? q.slice(1) : q));
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
              <Input id="confirm-input" value={pending.text} placeholder={pending.input.placeholder} onChange={(e) => updateCurrent({ text: e.target.value })} />
            </div>
          )}
          {!!pending?.options?.length && (
            <div className="space-y-3">
              {pending.options.map((o) => (
                <label key={o.key} className="flex min-h-8 cursor-pointer items-center gap-3 text-sm">
                  <Checkbox
                    checked={!!pending.values[o.key]}
                    onCheckedChange={(v) => updateCurrent({ values: { ...pending.values, [o.key]: v === true } })}
                  />
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
