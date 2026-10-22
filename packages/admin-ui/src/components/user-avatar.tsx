import * as React from "react";
import type { Profile } from "@beamhop/sdk/admin-contract";
import { cn } from "@/lib/utils";
import { displayName, pubkeyHue } from "@/lib/nostr";

/** Avatar with profile picture and a deterministic identicon fallback. */
export function UserAvatar({ pubkey, profile, className, size = 36 }: { pubkey: string; profile?: Profile; className?: string; size?: number }) {
  const [failed, setFailed] = React.useState(false);
  const pic = profile?.picture && !failed ? profile.picture : undefined;
  const hue = pubkeyHue(pubkey);
  const name = displayName(pubkey, profile);
  return (
    <span
      className={cn("relative inline-flex shrink-0 overflow-hidden rounded-full bg-muted ring-1 ring-border", className)}
      style={{ width: size, height: size }}
      title={name}
    >
      {pic ? (
        <img src={pic} alt="" loading="lazy" referrerPolicy="no-referrer" className="size-full object-cover" onError={() => setFailed(true)} />
      ) : (
        <Identicon pubkey={pubkey} hue={hue} />
      )}
    </span>
  );
}

function Identicon({ pubkey, hue }: { pubkey: string; hue: number }) {
  const cells: React.ReactNode[] = [];
  for (let y = 0; y < 5; y++)
    for (let x = 0; x < 3; x++) {
      const nib = parseInt(pubkey[(y * 3 + x + 8) % pubkey.length] || "0", 16);
      if (nib % 2 === 0) {
        cells.push(<rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} />);
        if (x < 2) cells.push(<rect key={`m${x}-${y}`} x={4 - x} y={y} width={1} height={1} />);
      }
    }
  return (
    <svg viewBox="-0.5 -0.5 6 6" className="size-full" style={{ background: `hsl(${hue} 70% 92%)` }} aria-hidden>
      <g fill={`hsl(${hue} 65% 45%)`}>{cells}</g>
    </svg>
  );
}
