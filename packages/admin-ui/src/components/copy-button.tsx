import * as React from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export async function copyText(text: string, label = "Copied to clipboard") {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(label);
    return true;
  } catch {
    toast.error("Clipboard not available");
    return false;
  }
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
