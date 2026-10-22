export function GroupAvatar({ picture, name, size = 44 }: { picture?: string; name: string; size?: number }) {
  return picture ? (
    <img src={picture} alt="" className="shrink-0 rounded-xl object-cover" style={{ width: size, height: size }} loading="lazy" />
  ) : (
    <div className="flex shrink-0 items-center justify-center rounded-xl bg-primary/15 font-semibold text-primary uppercase" style={{ width: size, height: size }}>
      {name.slice(0, 2)}
    </div>
  );
}
