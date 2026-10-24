import { autoMediaSrc } from "@/lib/media-policy";
import { useMediaPolicy } from "@/lib/prefs";

/** Group picture (set by group admins, so untrusted) under the same media policy as avatars; initials otherwise. */
export function GroupAvatar({ picture, name, size = 44 }: { picture?: string; name: string; size?: number }) {
  const src = autoMediaSrc(picture, useMediaPolicy());
  return src ? (
    <img src={src} alt="" referrerPolicy="no-referrer" className="shrink-0 rounded-xl object-cover" style={{ width: size, height: size }} loading="lazy" />
  ) : (
    <div className="flex shrink-0 items-center justify-center rounded-xl bg-primary/15 font-semibold text-primary uppercase" style={{ width: size, height: size }}>
      {name.slice(0, 2)}
    </div>
  );
}
