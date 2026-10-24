import * as React from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** execCommand fallback for insecure contexts (plain http, e.g. a LAN IP), where navigator.clipboard is missing. */
function legacyCopy(text: string): boolean {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    ta.remove();
  }
}

export async function copyText(text: string, label = "Copied to clipboard") {
  let ok = false;
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch {
    /* fall through */
  }
  if (!ok) ok = legacyCopy(text);
  if (ok) toast.success(label);
  else toast.error("Clipboard not available");
  return ok;
}

export function CopyButton({ value, label, className, size = "icon-sm" }: { value: string; label?: string; className?: string; size?: "icon-sm" | "icon" | "icon-xs" }) {
  const [done, setDone] = React.useState(false);
  return (
    <Button
      type="button"
      variant="ghost"
      size={size}
      className={cn("text-muted-foreground", className)}
      aria-label={label ? `Copy ${label}` : "Copy"}
      onClick={async (e) => {
        e.stopPropagation();
        if (await copyText(value, label ? `${label} copied` : undefined)) {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        }
      }}
    >
      {done ? <Check className="text-success" /> : <Copy />}
    </Button>
  );
}
