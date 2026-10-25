/**
 * GeoIP lookups backed by a MaxMind-format city database (`config.metrics.geoipDbPath`).
 *
 * Supported databases (any `.mmdb` with the GeoIP2 City layout):
 * - **DB-IP "IP to City Lite"** — free, CC-BY 4.0, no account needed. Download the monthly mmdb from
 *   https://db-ip.com/db/download/ip-to-city-lite (e.g. `dbip-city-lite-2026-10.mmdb.gz`), gunzip it and
 *   point `metrics.geoipDbPath` at it. Attribution "IP Geolocation by DB-IP" is required when shown publicly.
 * - **MaxMind GeoLite2-City** — free with a MaxMind account + license key:
 *   `https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-City&license_key=KEY&suffix=tar.gz`
 *   (or use `geoipupdate`).
 *
 * Raw IPs are never persisted — only the resolved country/city/coordinates are aggregated.
 */
import type { Logger } from "@beamhop/sdk";
import { isPrivateAddress } from "@beamhop/sdk/net";
import { LruCache } from "./lru";

export interface GeoInfo {
  country: string;
  countryName: string;
  city?: string;
  lat: number;
  lon: number;
}

export interface GeoLookup {
  readonly enabled: boolean;
  lookup(ip: string): GeoInfo | undefined;
}

interface CityRecord {
  country?: { iso_code?: string; names?: Record<string, string> };
  registered_country?: { iso_code?: string; names?: Record<string, string> };
  city?: { names?: Record<string, string> };
  location?: { latitude?: number; longitude?: number };
}
interface MmdbReader {
  get(ip: string): CityRecord | null;
}

const disabledGeo: GeoLookup = { enabled: false, lookup: () => undefined };

/** Opens the mmdb; returns a disabled lookup (and logs) if the path is unset or unreadable. */
export async function openGeoIp(path: string | undefined, logger?: Logger, cacheSize = 10_000): Promise<GeoLookup> {
  if (!path) return disabledGeo;
  try {
    const maxmind = (await import("maxmind")).default;
    const reader = (await maxmind.open(path, { watchForUpdates: false })) as unknown as MmdbReader;
    logger?.info("geoip database loaded", { path });
    return createGeoLookup(reader, cacheSize);
  } catch (err) {
    logger?.warn("geoip database could not be opened; geo stats disabled", { path, error: String(err) });
    return disabledGeo;
  }
}

export function createGeoLookup(reader: MmdbReader, cacheSize = 10_000): GeoLookup {
  const cache = new LruCache<string, GeoInfo | null>(cacheSize);
  return {
    enabled: true,
    lookup(raw: string) {
      const ip = stripMapped(raw);
      const hit = cache.get(ip);
      if (hit !== undefined) return hit ?? undefined;
      let info: GeoInfo | null = null;
      if (!isPrivateIp(ip)) {
        try {
          info = toGeoInfo(reader.get(ip));
        } catch {
          info = null;
        }
      }
      cache.set(ip, info);
      return info ?? undefined;
    },
  };
}

function toGeoInfo(r: CityRecord | null): GeoInfo | null {
  if (!r) return null;
  const c = r.country ?? r.registered_country;
  const lat = r.location?.latitude;
  const lon = r.location?.longitude;
  if (!c?.iso_code || lat === undefined || lon === undefined) return null;
  const city = r.city?.names?.en;
  return { country: c.iso_code, countryName: c.names?.en ?? c.iso_code, city: city || undefined, lat, lon };
}

const stripMapped = (ip: string) => {
  const s = ip.trim().toLowerCase();
  return s.startsWith("::ffff:") && s.includes(".") ? s.slice(7) : s;
};

/**
 * True for addresses GeoIP has nothing to say about: every non-public range (see @beamhop/sdk/net — including
 * documentation, benchmarking and IPv4-embedding IPv6 forms) and non-IP strings.
 */
export const isPrivateIp = (raw: string): boolean => isPrivateAddress(raw.trim());
