export interface RunningServer {
  runtime: "bun" | "node";
  hostname: string;
  port: number;
  /** stop accepting new connections (open sockets stay up) */
  stopAccepting(): void;
  /** force-close everything that is still open */
  stop(): Promise<void>;
}

export interface ServeOptions {
  host?: string;
  port?: number;
}

/** Strips IPv4-mapped IPv6 prefix and brackets/ports. */
export function normalizeIp(ip: string | undefined | null): string {
  if (!ip) return "unknown";
  let s = ip.trim();
  if (s.startsWith("[")) s = s.slice(1, s.indexOf("]"));
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(s)) s = s.slice(0, s.lastIndexOf(":"));
  if (s.toLowerCase().startsWith("::ffff:") && s.includes(".")) s = s.slice(7);
  return s || "unknown";
}

type HeaderGetter = (name: string) => string | null | undefined;

/** Client IP = socket address, or first X-Forwarded-For hop / X-Real-IP when trustProxy is on. */
export function clientIp(remote: string | undefined | null, header: HeaderGetter, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = header("x-forwarded-for");
    const first = xff?.split(",")[0]?.trim();
    if (first) return normalizeIp(first);
    const real = header("x-real-ip")?.trim();
    if (real) return normalizeIp(real);
  }
  return normalizeIp(remote);
}
