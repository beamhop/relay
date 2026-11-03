/**
 * Refreshes the admin app screenshots in src/assets/screens/.
 *
 *   cd <repo> && bun run build:ui && bun run build:plugins     # the panel and the bundled plugin UIs
 *   cd site && bun run screens                                 # [only=dashboard,users …] to re-shoot some
 *
 * Boots a throwaway beamhop (e2e/harness/relay.ts: free port, temp data dir, freshly generated owner key), fills it
 * with invented demo data (people, notes, reports, uploads, invites, IP rules, a group, 24 hours of metrics), keeps a
 * few websocket clients publishing so the live views move, captures the pages with Playwright (light theme) and
 * throws the relay and its data dir away. Every name, note and IP address below is made up; IPs come from the
 * documentation ranges (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24).
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import sharp from "sharp";
import type { Event } from "nostr-tools";
import { startRelay, type Relay } from "../../e2e/harness/relay";
import { RelayClient, blossomAuth, newUser, nip98Header, now, sha256, sign } from "../../e2e/harness/client";

const SITE = resolve(import.meta.dir, "..");
const REPO = resolve(SITE, "..");
const OUT = join(SITE, "src/assets/screens");
const ONLY = new Set(process.argv.slice(2).flatMap((a) => a.replace(/^only=/, "").split(",")).filter(Boolean));
const want = (name: string) => !ONLY.size || ONLY.has(name);

// Playwright is a dependency of the e2e workspace, not of the site
const { chromium } = createRequire(join(REPO, "e2e/package.json"))("@playwright/test") as typeof import("@playwright/test");
type Page = import("@playwright/test").Page;
type BrowserContext = import("@playwright/test").BrowserContext;

// ---------------------------------------------------------------- deterministic randomness
let rngState = 7;
const rand = () => ((rngState = (rngState * 16807) % 2147483647) - 1) / 2147483646;
const pick = <T,>(a: readonly T[]) => a[Math.floor(rand() * a.length)]!;
const between = (lo: number, hi: number) => lo + rand() * (hi - lo);

// ---------------------------------------------------------------- generated pictures (no photos of anyone)
const svgToPng = (svg: string) => sharp(Buffer.from(svg)).png().toBuffer();
const svgToJpeg = (svg: string) => sharp(Buffer.from(svg)).jpeg({ quality: 84 }).toBuffer();

function avatarSvg(initials: string, hue: number) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="hsl(${hue},70%,62%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360},65%,42%)"/></linearGradient></defs>
  <rect width="256" height="256" fill="url(#g)"/>
  <circle cx="200" cy="52" r="70" fill="#fff" opacity=".12"/><circle cx="40" cy="230" r="90" fill="#000" opacity=".08"/>
  <text x="128" y="152" text-anchor="middle" font-family="Helvetica Neue, Arial, sans-serif" font-size="96" font-weight="700" fill="#fff">${initials}</text>
</svg>`;
}

const W = 1200, H = 800;
const ridge = (y: number, amp: number, color: string, peaks = 6) => {
  let d = `M0 ${H} L0 ${y}`;
  for (let i = 1; i <= peaks; i++) d += ` L${(W / peaks) * (i - 0.5)} ${y - between(amp * 0.4, amp)} L${(W / peaks) * i} ${y - between(0, amp * 0.3)}`;
  return `<path d="${d} L${W} ${H} Z" fill="${color}"/>`;
};
const SCENES: Record<string, () => string> = {
  mountains: () => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fbd3a6"/><stop offset="1" stop-color="#f6a1a0"/></linearGradient></defs>
    <rect width="${W}" height="${H}" fill="url(#s)"/><circle cx="820" cy="300" r="90" fill="#fff4dc"/>
    ${ridge(470, 260, "#b07aa1", 5)}${ridge(560, 200, "#7d5a8c", 7)}${ridge(660, 140, "#4b3a66", 9)}${ridge(740, 80, "#2c2442", 11)}</svg>`,
  sunset: () => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3b2a6b"/><stop offset=".55" stop-color="#f08a5d"/><stop offset=".56" stop-color="#2f4b7c"/><stop offset="1" stop-color="#14213d"/></linearGradient></defs>
    <rect width="${W}" height="${H}" fill="url(#s)"/><circle cx="600" cy="440" r="120" fill="#ffd27f"/><rect y="440" width="${W}" height="${H}" fill="#24375e"/>
    ${Array.from({ length: 14 }, (_, i) => `<rect x="${600 - 160 + i * 6}" y="${460 + i * 22}" width="${320 - i * 12}" height="5" rx="2" fill="#ffd27f" opacity="${0.8 - i * 0.05}"/>`).join("")}</svg>`,
  forest: () => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#dff1e6"/><circle cx="260" cy="200" r="70" fill="#fff8e1"/>
    ${ridge(520, 120, "#a8d5ba", 4)}
    ${Array.from({ length: 40 }, () => { const x = between(-40, W); const y = between(520, 760); const s = between(50, 120); return `<path d="M${x} ${y - s * 1.8} L${x - s / 2} ${y} L${x + s / 2} ${y} Z" fill="hsl(${between(130, 165)},${between(35, 55)}%,${between(22, 38)}%)"/>`; }).sort().join("")}</svg>`,
  city: () => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0b1026"/><stop offset="1" stop-color="#2b3a73"/></linearGradient></defs>
    <rect width="${W}" height="${H}" fill="url(#s)"/>${Array.from({ length: 80 }, () => `<circle cx="${between(0, W)}" cy="${between(0, 380)}" r="${between(0.8, 2.2)}" fill="#fff" opacity="${between(0.3, 0.9)}"/>`).join("")}
    <circle cx="980" cy="140" r="46" fill="#f4f1de"/>
    ${Array.from({ length: 22 }, (_, i) => { const w = between(50, 90); const x = i * 56 - 20; const h = between(180, 460); let win = ""; for (let yy = H - h + 16; yy < H - 20; yy += 26) for (let xx = x + 10; xx < x + w - 14; xx += 18) if (rand() > 0.45) win += `<rect x="${xx}" y="${yy}" width="8" height="12" fill="#ffd166" opacity="${between(0.5, 1)}"/>`; return `<rect x="${x}" y="${H - h}" width="${w}" height="${h}" fill="hsl(230,30%,${between(10, 18)}%)"/>${win}`; }).join("")}</svg>`,
  dunes: () => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fde2b8"/><circle cx="900" cy="220" r="80" fill="#fff3d6"/>
    <path d="M0 520 Q300 380 620 520 T1200 470 L1200 800 L0 800 Z" fill="#f2b880"/><path d="M0 620 Q380 470 760 640 T1200 600 L1200 800 L0 800 Z" fill="#e0955a"/><path d="M0 720 Q420 610 900 740 T1200 720 L1200 800 L0 800 Z" fill="#c1703d"/></svg>`,
  aurora: () => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><linearGradient id="a" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#5ef2b5" stop-opacity="0"/><stop offset=".5" stop-color="#5ef2b5" stop-opacity=".75"/><stop offset="1" stop-color="#7a6cf0" stop-opacity="0"/></linearGradient></defs>
    <rect width="${W}" height="${H}" fill="#0a1a2f"/>${Array.from({ length: 60 }, () => `<circle cx="${between(0, W)}" cy="${between(0, 500)}" r="${between(0.8, 2)}" fill="#fff" opacity="${between(0.3, 0.9)}"/>`).join("")}
    <path d="M-50 380 C200 160 420 420 640 220 S1000 120 1260 300" stroke="url(#a)" stroke-width="90" fill="none" opacity=".8"/><path d="M-50 300 C260 120 520 330 760 170 S1100 200 1260 120" stroke="url(#a)" stroke-width="50" fill="none" opacity=".5"/>
    ${ridge(700, 120, "#06101e", 8)}</svg>`,
  lake: () => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="400" fill="#bfe3f2"/><rect y="400" width="${W}" height="400" fill="#7fb7d1"/>
    ${ridge(400, 180, "#4f7d6b", 6)}<g transform="translate(0 800) scale(1 -1)" opacity=".35">${ridge(400, 180, "#2f5d4b", 6)}</g><rect y="400" width="${W}" height="400" fill="#7fb7d1" opacity=".45"/>
    ${Array.from({ length: 18 }, () => `<rect x="${between(0, W)}" y="${between(430, 780)}" width="${between(40, 160)}" height="3" rx="1.5" fill="#fff" opacity=".35"/>`).join("")}</svg>`,
  balloons: () => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9ad0ec"/><stop offset="1" stop-color="#fbe7c6"/></linearGradient></defs>
    <rect width="${W}" height="${H}" fill="url(#s)"/>${ridge(720, 90, "#8fb996", 6)}
    ${[[260, 260, 70, "#e76f51"], [620, 180, 95, "#2a9d8f"], [930, 330, 60, "#e9c46a"], [470, 430, 45, "#f4a261"], [1080, 160, 40, "#9b5de5"]].map(([x, y, r, c]) => `<ellipse cx="${x}" cy="${y}" rx="${r}" ry="${Number(r) * 1.15}" fill="${c}"/><path d="M${Number(x) - Number(r) * 0.5} ${Number(y) + Number(r)} L${Number(x) - Number(r) * 0.18} ${Number(y) + Number(r) * 1.6} M${Number(x) + Number(r) * 0.5} ${Number(y) + Number(r)} L${Number(x) + Number(r) * 0.18} ${Number(y) + Number(r) * 1.6}" stroke="#5a4636" stroke-width="2"/><rect x="${Number(x) - Number(r) * 0.2}" y="${Number(y) + Number(r) * 1.6}" width="${Number(r) * 0.4}" height="${Number(r) * 0.3}" fill="#7a5c3e"/>`).join("")}</svg>`,
  leaves: () => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#f3efe0"/>
    ${Array.from({ length: 34 }, () => { const x = between(0, W), y = between(0, H), r = between(40, 120), a = between(0, 180); return `<ellipse cx="${x}" cy="${y}" rx="${r}" ry="${r * 0.42}" transform="rotate(${a} ${x} ${y})" fill="hsl(${between(85, 150)},${between(30, 50)}%,${between(30, 55)}%)" opacity=".9"/>`; }).join("")}</svg>`,
  bread: () => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#efe3d0"/><rect y="560" width="${W}" height="240" fill="#a47148"/>
    <ellipse cx="600" cy="520" rx="330" ry="190" fill="#c68b4e"/><ellipse cx="600" cy="490" rx="300" ry="150" fill="#d9a066"/>
    ${[-150, -50, 50, 150].map((dx) => `<path d="M${600 + dx - 50} ${440} Q${600 + dx} ${400} ${600 + dx + 50} ${440}" stroke="#f3d9a4" stroke-width="16" fill="none" stroke-linecap="round"/>`).join("")}</svg>`,
};

// ---------------------------------------------------------------- the invented community
interface Person { key: string; name: string; display: string; about: string; hue: number; ip: string; website?: string; banner?: string; sk: Uint8Array; pubkey: string; picture?: string }
const PEOPLE: Omit<Person, "sk" | "pubkey">[] = [
  { key: "owner", name: "mara", display: "Mara Ellison", about: "Runs Driftwood Relay. Trail maps, strong coffee and a tidy moderation queue.", hue: 262, ip: "192.0.2.10" },
  { key: "juniper", name: "juniper", display: "Juniper Okafor", about: "Landscape photographer. Mostly mountains, sometimes lakes, never sunrise (too early).", hue: 18, ip: "203.0.113.21", website: "https://juniper.example" },
  { key: "theo", name: "theo", display: "Theo Marchetti", about: "Bikes, maps and slow climbs.", hue: 200, ip: "198.51.100.33" },
  { key: "saoirse", name: "saoirse", display: "Saoirse Lindqvist", about: "Sourdough every Sunday. Ask me about hydration ratios.", hue: 35, ip: "203.0.113.44" },
  { key: "ravi", name: "ravi", display: "Ravi Castellanos", about: "Writes software and the occasional long read about it.", hue: 150, ip: "198.51.100.52" },
  { key: "noor", name: "noor", display: "Noor Haddad", about: "Community moderator at Driftwood. Be kind, tag your NSFW.", hue: 320, ip: "192.0.2.61" },
  { key: "felix", name: "felix", display: "Felix Brandt", about: "Keeps an eye on the numbers.", hue: 230, ip: "198.51.100.70" },
  { key: "ines", name: "ines", display: "Ines Moreau", about: "Balcony gardener. Tomatoes are my love language.", hue: 95, ip: "203.0.113.82" },
  { key: "kenji", name: "kenji", display: "Kenji Albright", about: "Birdwatcher. 214 species and counting.", hue: 185, ip: "192.0.2.93" },
  { key: "talia", name: "talia", display: "Talia Novak", about: "Night owl, amateur astronomer.", hue: 280, ip: "198.51.100.104" },
  { key: "oskar", name: "oskar", display: "Oskar Lund", about: "New here, mostly reading.", hue: 10, ip: "203.0.113.115" },
  { key: "spammer", name: "prizedesk", display: "Prize Desk", about: "WINNERS ANNOUNCED DAILY", hue: 0, ip: "198.51.100.200" },
  { key: "fake", name: "mara_admin", display: "Mara Elison", about: "Relay admin. DM me to get verified.", hue: 262, ip: "198.51.100.201" },
  { key: "flooder", name: "echo", display: "Echo Chamber", about: "", hue: 60, ip: "198.51.100.202" },
];

const NOTES: [string, string][] = [
  ["juniper", "Spent the morning above the tree line. The light did that thing where every ridge gets its own colour."],
  ["theo", "120 km today, 1,900 m of climbing. Legs are filing a complaint."],
  ["saoirse", "Today's loaf: 78% hydration, 20% rye, and an ear I'm unreasonably proud of."],
  ["ravi", "Wrote up how we cut our sync time in half with negentropy. Long read, coffee recommended."],
  ["ines", "First tomato of the season is ripe. I may have taken forty photos of it."],
  ["kenji", "Heard a wren before I saw it. Tiny bird, enormous voice."],
  ["talia", "Clear skies tonight. Saturn's rings are visible in a small telescope, go look!"],
  ["noor", "Reminder: reports go to the moderators, not into the void. Thanks to everyone who flagged the spam wave this week."],
  ["oskar", "Hello Driftwood! Found this relay through a friend. What should I read first?"],
  ["juniper", "Lake at 6am, perfectly still. Posting the photo once I stop staring at it."],
  ["theo", "Does anyone have a good route around the north side of the reservoir? The usual road is closed."],
  ["saoirse", "Starter is three years old today. She gets extra flour as a birthday present."],
  ["kenji", "Kingfisher! Blue streak, gone in a second. Worth the cold feet."],
  ["ravi", "Small tip: if your relay list is long, keep your write relays short."],
  ["ines", "Basil is thriving, mint is plotting world domination."],
  ["talia", "The aurora forecast says maybe. Maybe is enough for me."],
  ["mara", "Driftwood just passed its first birthday. Thanks for being here, all of you."],
  ["mara", "Maintenance window on Thursday at 06:00 UTC, about ten minutes. Clients will reconnect on their own."],
  ["felix", "Weekly stats look healthy: more notes, fewer rejected events than last week."],
  ["juniper", "Desert trip photos are up. The dunes changed shape every hour."],
];
const LIVE_LINES = [
  "Good morning from the coast", "Anyone up for a ride this weekend?", "That sunset though.", "New loaf, new crumb shot.",
  "Just finished a great book about lighthouses.", "Rain all day. Perfect for reading.", "Spotted a heron by the canal.",
  "Coffee number two. Productivity pending.", "Tomatoes: 3. Squirrels: 1.", "Clear skies tonight, telescope is out.",
  "Shipping a small fix for the photo uploader.", "Map nerds: what's your favourite projection?", "Trail was muddy but worth it.",
];

// ---------------------------------------------------------------- helpers
const log = (...a: unknown[]) => console.log("[screens]", ...a);

/** where the demo owner works from (the relay trusts X-Forwarded-For here, as behind a reverse proxy) */
const OWNER_IP = "192.0.2.10";

/** Admin API call as the owner, NIP-98 signed. */
async function api(relay: Relay, method: string, path: string, body?: unknown) {
  const url = `${relay.http}/admin/api${path}`;
  const raw = body === undefined ? (method === "GET" || method === "DELETE" ? undefined : "{}") : JSON.stringify(body);
  const headers: Record<string, string> = { "X-Requested-With": "beamhop", Accept: "application/json", "X-Forwarded-For": OWNER_IP, Authorization: nip98Header(relay.owner.sk, url, method, raw) };
  if (raw !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(url, { method, headers, body: raw });
  const text = await res.text();
  if (res.status >= 300) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return text ? JSON.parse(text) : undefined;
}

async function upload(relay: Relay, sk: Uint8Array, bytes: Buffer, type: string, ip: string): Promise<string> {
  const hash = sha256(bytes);
  const res = await fetch(`${relay.http}/upload`, {
    method: "PUT",
    headers: { Authorization: blossomAuth(sk, "upload", { hash }), "Content-Type": type, "X-SHA-256": hash, "X-Forwarded-For": ip },
    body: new Uint8Array(bytes),
  });
  if (!res.ok) throw new Error(`upload failed ${res.status} ${await res.text()}`);
  return ((await res.json()) as { url: string }).url;
}

async function importEvents(relay: Relay, events: Event[], bypass = false) {
  for (let i = 0; i < events.length; i += 500) {
    const chunk = events.slice(i, i + 500);
    const url = `${relay.http}/admin/api/events/import${bypass ? "?bypassPolicies=true" : ""}`;
    const body = chunk.map((e) => JSON.stringify(e)).join("\n");
    const res = await fetch(url, {
      method: "POST",
      headers: { "X-Requested-With": "beamhop", Accept: "application/json", "Content-Type": "application/x-ndjson", "X-Forwarded-For": OWNER_IP, Authorization: nip98Header(relay.owner.sk, url, "POST", body) },
      body,
    });
    const j = (await res.json()) as { imported: number; rejected: number; errors: string[] };
    if (!res.ok || j.rejected) log("import:", res.status, j.imported, "imported,", j.rejected, "rejected", j.errors?.slice(0, 3));
  }
}

async function connect(relay: Relay, ip: string, ua?: string) {
  const headers: Record<string, string> = { "X-Forwarded-For": ip };
  if (ua) headers["User-Agent"] = ua;
  return RelayClient.connect(relay.ws, { headers });
}

async function publishAs(relay: Relay, p: Person, events: Event[]) {
  const c = await connect(relay, p.ip);
  try {
    for (const e of events) {
      const r = await c.publish(e);
      if (!r.ok) log(`publish by ${p.key} refused: ${r.message}`);
    }
  } finally {
    c.close();
  }
}

// ---------------------------------------------------------------- seeding
async function seed(relay: Relay) {
  const people = new Map<string, Person>();
  for (const p of PEOPLE) {
    const u = p.key === "owner" ? { sk: relay.owner.sk, pubkey: relay.owner.pubkey } : newUser();
    people.set(p.key, { ...p, ...u });
  }
  const P = (k: string) => people.get(k)!;

  // relay identity first, so the panel and NIP-11 carry the demo name
  await api(relay, "PATCH", "/settings", { info: { name: "Driftwood Relay", description: "A friendly community relay for photographers, cyclists and bakers.", contact: "hello@driftwood.example" } });

  // pictures: avatars (on this relay's Blossom, so the panel shows them without the remote-media opt-in) and photos
  for (const p of people.values()) {
    if (p.key === "spammer" || p.key === "flooder") continue;
    const initials = p.display.split(" ").map((w) => w[0]).join("").slice(0, 2);
    p.picture = await upload(relay, p.sk, await svgToPng(avatarSvg(initials, p.hue)), "image/png", p.ip);
  }
  P("owner").banner = await upload(relay, P("owner").sk, await svgToJpeg(SCENES.lake!().replace(`height="${H}"`, `height="${H}"`)), "image/jpeg", P("owner").ip);
  P("juniper").banner = await upload(relay, P("juniper").sk, await svgToJpeg(SCENES.mountains!()), "image/jpeg", P("juniper").ip);
  const photoOwners: [string, string][] = [
    ["juniper", "sunset"], ["juniper", "dunes"], ["juniper", "forest"], ["theo", "balloons"], ["saoirse", "bread"],
    ["ines", "leaves"], ["talia", "aurora"], ["ravi", "city"], ["kenji", "lake"],
  ];
  const photos: Record<string, string> = {};
  for (const [who, scene] of photoOwners) photos[scene] = await upload(relay, P(who).sk, await svgToJpeg(SCENES[scene]!()), "image/jpeg", P(who).ip);

  // profiles + notes, published like a client would (fills first/last seen and event counts)
  const t0 = now();
  const notesByKey: Record<string, Event[]> = {};
  for (const p of people.values()) {
    const meta: Record<string, string> = { name: p.name, display_name: p.display, about: p.about };
    if (p.picture) meta.picture = p.picture;
    if (p.banner) meta.banner = p.banner;
    if (p.website) meta.website = p.website;
    if (["owner", "noor", "juniper", "ravi"].includes(p.key)) meta.nip05 = `${p.name}@driftwood.example`;
    await publishAs(relay, p, [sign(p.sk, { kind: 0, content: JSON.stringify(meta), created_at: t0 - 86400 * 20 })]);
  }
  let age = NOTES.length * 1500;
  for (const [key, text] of NOTES) {
    const p = P(key === "mara" ? "owner" : key);
    const scene = key === "juniper" && /Lake/.test(text) ? "lake" : key === "juniper" && /Desert/.test(text) ? "dunes" : key === "saoirse" && /loaf/.test(text) ? "bread" : key === "talia" && /aurora/.test(text) ? "aurora" : undefined;
    const content = scene ? `${text}\n${photos[scene]}` : text;
    const ev = sign(p.sk, { kind: 1, content, created_at: t0 - (age -= 1500) - 600, tags: scene ? [["imeta", `url ${photos[scene]}`, "m image/jpeg"]] : [] });
    (notesByKey[p.key] ??= []).push(ev);
  }
  for (const [key, evs] of Object.entries(notesByKey)) await publishAs(relay, P(key), evs);
  const allNotes = Object.values(notesByKey).flat();

  // a long-form article, replies, reactions and reposts
  const article = sign(P("ravi").sk, {
    kind: 30023,
    content: "# Halving our sync time\n\nWe moved our mirrors to negentropy and the difference was immediate...",
    tags: [["d", "halving-sync-time"], ["title", "Halving our sync time"], ["summary", "What changed when our mirrors switched to set reconciliation."], ["published_at", String(t0 - 7200)]],
    created_at: t0 - 7200,
  });
  await publishAs(relay, P("ravi"), [article]);
  const welcome = allNotes.find((e) => e.content.startsWith("Hello Driftwood"))!;
  await publishAs(relay, P("noor"), [sign(P("noor").sk, { kind: 1, content: "Welcome Oskar! The pinned guide in the help group is a good start.", tags: [["e", welcome.id, "", "reply"], ["p", welcome.pubkey]], created_at: t0 - 500 })]);
  await publishAs(relay, P("saoirse"), [sign(P("saoirse").sk, { kind: 1, content: "Welcome! Bring snacks.", tags: [["e", welcome.id, "", "reply"], ["p", welcome.pubkey]], created_at: t0 - 400 })]);

  // background history: reactions, reposts, follows and older notes, imported straight into storage
  const bulk: Event[] = [];
  const regulars = [...people.values()].filter((p) => !["spammer", "fake", "flooder"].includes(p.key));
  for (let i = 0; i < 1400; i++) {
    const who = pick(regulars);
    const target = pick(allNotes);
    bulk.push(sign(who.sk, { kind: 7, content: pick(["+", "+", "❤️", "🔥", "🌄", "👏"]), tags: [["e", target.id], ["p", target.pubkey]], created_at: t0 - Math.floor(between(3600, 86400 * 30)) }));
  }
  for (let i = 0; i < 160; i++) {
    const who = pick(regulars);
    const target = pick(allNotes);
    bulk.push(sign(who.sk, { kind: 6, content: "", tags: [["e", target.id], ["p", target.pubkey]], created_at: t0 - Math.floor(between(3600, 86400 * 30)) }));
  }
  for (let i = 0; i < 520; i++) {
    const who = pick(regulars);
    bulk.push(sign(who.sk, { kind: 1, content: `${pick(LIVE_LINES)}`, created_at: t0 - Math.floor(between(86400, 86400 * 45)) }));
  }
  for (const p of regulars) bulk.push(sign(p.sk, { kind: 3, content: "", tags: regulars.filter((o) => o !== p && rand() > 0.3).map((o) => ["p", o.pubkey]), created_at: t0 - 86400 * 10 }));
  await importEvents(relay, bulk, true);

  // trouble: a spam wave and an impersonator (spam goes in directly; the spam filter would refuse it over the wire)
  const spamNotes = [
    "🎉 YOU WON! Claim your prize now at https://prizes.example/claim https://prizes.example/win https://prizes.example/now",
    "Last chance!!! Free followers, limited offer https://prizes.example/followers",
  ].map((content, i) => sign(P("spammer").sk, { kind: 1, content, created_at: t0 - 300 + i }));
  await importEvents(relay, [sign(P("spammer").sk, { kind: 0, content: JSON.stringify({ name: "prizedesk", display_name: "Prize Desk", about: "WINNERS ANNOUNCED DAILY" }) }), ...spamNotes], true);
  const fakeNote = sign(P("fake").sk, { kind: 1, content: "Hi all, I'm the relay admin. Please DM me your login details so I can verify your account.", created_at: t0 - 240 });
  await publishAs(relay, P("fake"), [fakeNote]);
  const rudeReply = sign(P("flooder").sk, { kind: 1, content: "Nobody cares about your tomatoes. Absolute garbage hobby.", tags: [["p", P("ines").pubkey]], created_at: t0 - 200 });
  await publishAs(relay, P("flooder"), [rudeReply]);

  // NIP-56 reports, filed by members
  const report = (by: Person, tags: string[][], content: string) => publishAs(relay, by, [sign(by.sk, { kind: 1984, content, tags })]);
  const photoHash = photos.dunes!.split("/").pop()!.split(".")[0]!;
  await report(P("saoirse"), [["x", photoHash, "other"], ["p", P("juniper").pubkey]], "Is this one of mine? Looks a lot like the photo from my trip last spring.");
  await report(P("ines"), [["e", rudeReply.id, "profanity"], ["p", P("flooder").pubkey]], "Nasty reply under my garden thread.");
  await report(P("kenji"), [["e", fakeNote.id, "impersonation"], ["p", P("fake").pubkey]], "Pretending to be Mara and asking people for their login details.");
  await report(P("juniper"), [["e", spamNotes[0]!.id, "spam"], ["p", P("spammer").pubkey]], "Same prize link in every thread this morning.");
  await report(P("theo"), [["e", spamNotes[0]!.id, "spam"], ["p", P("spammer").pubkey]], "Spam, posted under my ride report too.");

  // people management: roles, tags, notes, a ban, a mute, the allow-list
  await api(relay, "PUT", `/users/${P("noor").pubkey}/role`, { role: "moderator" });
  await api(relay, "PUT", `/users/${P("felix").pubkey}/role`, { role: "viewer" });
  await api(relay, "PATCH", `/users/${P("juniper").pubkey}`, { tags: ["photographers", "regulars"], notes: "Shares a lot of photos; raised her quota.", blossomQuota: 4 * 1024 ** 3, nip05Name: "juniper", allowed: true });
  await api(relay, "PATCH", `/users/${P("saoirse").pubkey}`, { tags: ["regulars"], allowed: true });
  await api(relay, "PATCH", `/users/${P("kenji").pubkey}`, { tags: ["photographers"] });
  await api(relay, "PATCH", `/users/${P("theo").pubkey}`, { tags: ["regulars"] });
  await api(relay, "PATCH", `/users/${P("ravi").pubkey}`, { tags: ["writers"], nip05Name: "ravi" });
  await api(relay, "POST", `/users/${P("talia").pubkey}/mute`, {});
  const banned = newUser();
  await importEvents(relay, [sign(banned.sk, { kind: 0, content: JSON.stringify({ name: "quickprizes", display_name: "Quick Prizes" }) }), sign(banned.sk, { kind: 1, content: "Click here for prizes https://prizes.example" })], true);
  await api(relay, "POST", "/users", { pubkey: banned.pubkey });
  await api(relay, "POST", `/users/${banned.pubkey}/ban`, { reason: "spam links in replies" });

  // invites and IP rules
  const walk = (await api(relay, "POST", "/invites", { count: 1, maxUses: 25, note: "Photo walk meetup", expiresAt: t0 + 86400 * 14 })).items[0].code as string;
  const bakers = (await api(relay, "POST", "/invites", { count: 1, maxUses: 0, note: "Bakers' club" })).items[0].code as string;
  const friends = (await api(relay, "POST", "/invites", { count: 2, maxUses: 1, note: "Friends of Theo" })).items[0].code as string;
  // newcomers redeem some of them, the way the invite page does it (NIP-98 signed POST /invite/redeem)
  const redeem = async (code: string, n: number) => {
    for (let i = 0; i < n; i++) {
      const u = newUser();
      const url = `${relay.http}/invite/redeem`;
      const body = JSON.stringify({ code });
      const res = await fetch(url, { method: "POST", headers: { Authorization: nip98Header(u.sk, url, "POST", body), "Content-Type": "application/json", "X-Forwarded-For": `203.0.113.${130 + i}` }, body });
      if (!res.ok) log("redeem failed", res.status, await res.text());
    }
  };
  await redeem(walk, 7);
  await redeem(bakers, 3);
  await redeem(friends, 1);
  await api(relay, "POST", "/ip-rules", { cidr: "198.51.100.200", action: "block", reason: "prize spam bot" });
  await api(relay, "POST", "/ip-rules", { cidr: "203.0.113.224/27", action: "block", reason: "scraper hammering REQs" });
  await api(relay, "POST", "/ip-rules", { cidr: "192.0.2.50", action: "allow", reason: "our uptime monitor" });

  // NIP-29 groups, created by the owner
  const groups = [
    { id: "photo-walks", name: "Photo walks", about: "Plan walks, share the results. All cameras welcome.", members: ["juniper", "kenji", "theo", "talia"] },
    { id: "sourdough", name: "Sourdough club", about: "Starters, crumb shots and gentle troubleshooting.", members: ["saoirse", "ines", "oskar"] },
    { id: "help", name: "Help desk", about: "New to Driftwood or Nostr? Ask here.", members: ["noor", "oskar", "ravi", "felix", "ines"] },
  ];
  const o = P("owner");
  for (const g of groups) {
    const evs = [sign(o.sk, { kind: 9007, tags: [["h", g.id], ["name", g.name], ["about", g.about], ...(g.id === "sourdough" ? [["closed"]] : [])] })];
    for (const m of g.members) evs.push(sign(o.sk, { kind: 9000, tags: [["h", g.id], ["p", P(m).pubkey, ...(m === "noor" ? ["moderator"] : [])]] }));
    await publishAs(relay, o, evs);
  }

  // some uploads wait for review: turn approval on for two more pictures
  await api(relay, "PATCH", "/settings", { blossom: { requireApproval: true } });
  await upload(relay, P("oskar").sk, await svgToJpeg(SCENES.mountains!()), "image/jpeg", P("oskar").ip);
  await upload(relay, P("theo").sk, await svgToJpeg(SCENES.forest!()), "image/jpeg", P("theo").ip);

  // moderation policy the relay "has been running with"
  await api(relay, "PATCH", "/settings", {
    moderation: {
      kindBlocklist: [4],
      wordFilters: [
        { id: "prize-links", pattern: "prizes.example", isRegex: false, kinds: [], action: "reject", enabled: true },
        { id: "phishing", pattern: "(send|dm) me your (login|password|keys?)", isRegex: true, kinds: [1, 1111], action: "report", enabled: true },
        { id: "slurs", pattern: "garbage hobby", isRegex: false, kinds: [], action: "shadow", enabled: false },
      ],
    },
    retention: { rules: [{ id: "old-reactions", enabled: true, kinds: [7], maxAgeDays: 180, exemptPubkeys: [] }] },
  });

  // let the user activity buffer flush (every ~2s), then give the list the history imported straight into storage:
  // event counts and first-seen times from the stored events
  await Bun.sleep(3000);
  const db = relay.beamhop.stores.db;
  await db.run("UPDATE users SET event_count = (SELECT COUNT(*) FROM events e WHERE e.pubkey = users.pubkey) WHERE EXISTS (SELECT 1 FROM events e WHERE e.pubkey = users.pubkey)");
  await db.run("UPDATE users SET first_seen_at = (SELECT MIN(created_at) FROM events e WHERE e.pubkey = users.pubkey) WHERE EXISTS (SELECT 1 FROM events e WHERE e.pubkey = users.pubkey)");
  return { people, P, notes: allNotes };
}

// ---------------------------------------------------------------- 30 days of metrics history
async function backfillMetrics(relay: Relay, people: Map<string, Person>) {
  const db = relay.beamhop.stores.db;
  const nowS = now();
  const minuteNow = Math.floor(nowS / 60) * 60;
  const daily = (t: number) => 0.55 + 0.45 * Math.sin(((t / 3600 + 4) / 24) * 2 * Math.PI); // quiet at night, busy in the evening
  const rows: [string, number, number][] = [];
  // minute rows for the last 26 hours, then hourly-spaced rows (one per 10 min) back to 30 days
  for (let t = minuteNow - 26 * 3600; t < minuteNow - 120; t += 60) {
    const d = daily(t) * between(0.85, 1.15);
    rows.push(["events_in", t, Math.round(4 + 10 * d)], ["events_out", t, Math.round(30 + 70 * d)], ["req", t, Math.round(6 + 14 * d)], ["rejected", t, Math.round(2 * d * rand())]);
    rows.push(["connections", t, Math.round(8 + 14 * d)], ["subscriptions", t, Math.round(25 + 50 * d)], ["cpu", t, 0.8 + 3 * d + between(0, 0.6)]);
    rows.push(["memory", t, (140 + 30 * d) * 1024 * 1024], ["heap", t, (40 + 12 * d) * 1024 * 1024], ["req_latency_p95", t, 1 + 3 * d + between(0, 0.8)], ["loop_lag", t, 0.5 + 2.5 * d * rand()]);
  }
  for (let t = minuteNow - 30 * 86400; t < minuteNow - 26 * 3600; t += 600) {
    const grow = 0.6 + 0.4 * (1 - (minuteNow - t) / (30 * 86400));
    const d = daily(t) * grow * between(0.85, 1.15);
    rows.push(["events_in", t, Math.round((4 + 10 * d) * 10)], ["events_out", t, Math.round((30 + 70 * d) * 10)], ["req", t, Math.round((6 + 14 * d) * 10)], ["rejected", t, Math.round(2 * d * rand() * 10)]);
    rows.push(["connections", t, Math.round(8 + 14 * d)], ["cpu", t, 0.8 + 3 * d], ["memory", t, (140 + 30 * d) * 1024 * 1024], ["req_latency_p95", t, 1 + 3 * d], ["loop_lag", t, 0.5 + 2 * d * rand()]);
  }
  await db.tx(async (tx) => {
    for (const r of rows) await tx.run("INSERT INTO metrics_series (name, bucket, value) VALUES (?, ?, ?) ON CONFLICT (name, bucket) DO UPDATE SET value = excluded.value", r);
  });

  const hourNow = Math.floor(nowS / 3600) * 3600;
  const kinds: [number, number][] = [[1, 0.42], [7, 0.33], [6, 0.07], [3, 0.04], [0, 0.03], [1111, 0.04], [10002, 0.02], [30023, 0.01], [1984, 0.004], [9, 0.03]];
  const top = [...people.values()].filter((p) => !["fake"].includes(p.key));
  const weights = new Map(top.map((p) => [p.key, p.key === "spammer" ? 0.6 : p.key === "flooder" ? 0.5 : between(0.2, 1)]));
  const geo: [string, string, string, number, number, number][] = [
    ["DE", "Germany", "Berlin", 52.52, 13.4, 0.2], ["US", "United States", "New York", 40.71, -74.0, 0.16], ["US", "United States", "San Francisco", 37.77, -122.42, 0.08],
    ["NL", "Netherlands", "Amsterdam", 52.37, 4.9, 0.1], ["JP", "Japan", "Tokyo", 35.68, 139.69, 0.09], ["BR", "Brazil", "São Paulo", -23.55, -46.63, 0.07],
    ["GB", "United Kingdom", "London", 51.5, -0.12, 0.08], ["FR", "France", "Lyon", 45.76, 4.84, 0.06], ["CA", "Canada", "Toronto", 43.65, -79.38, 0.05],
    ["AU", "Australia", "Melbourne", -37.81, 144.96, 0.04], ["SE", "Sweden", "Stockholm", 59.33, 18.07, 0.03], ["KE", "Kenya", "Nairobi", -1.29, 36.82, 0.02],
  ];
  const rejections: [string, string, number][] = [
    ["rate-limited", "slow down, too many events", 0.34], ["blocked", "looks like spam (new account posting <n>/min)", 0.22], ["blocked", "pubkey is banned", 0.16],
    ["invalid", "created_at is too far in the future", 0.1], ["blocked", "kind <n> is not allowed on this relay", 0.08], ["invalid", "too many tags (max <n>)", 0.05], ["duplicate", "already have this event", 0.05],
  ];
  await db.tx(async (tx) => {
    for (let h = hourNow - 30 * 86400; h < hourNow; h += 3600) {
      const vol = Math.round(600 * daily(h) * between(0.8, 1.2));
      for (const [k, share] of kinds) await tx.run("INSERT INTO metrics_kinds (bucket, kind, count) VALUES (?, ?, ?) ON CONFLICT DO NOTHING", [h, k, Math.round(vol * share)]);
      for (const p of top) {
        const w = weights.get(p.key)!;
        const ev = Math.round((vol / 18) * w * between(0.7, 1.3));
        const rej = p.key === "spammer" ? Math.round(ev * 0.8) : p.key === "flooder" ? Math.round(ev * 0.3) : rand() > 0.9 ? 1 : 0;
        await tx.run("INSERT INTO metrics_pubkeys (bucket, pubkey, events, rejected) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING", [h, p.pubkey, ev, rej]);
      }
      const rejVol = Math.round(vol * 0.04 * between(0.5, 1.5));
      for (const [code, reason, share] of rejections) await tx.run("INSERT INTO metrics_rejections (bucket, code, reason, count) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING", [h, code, reason, Math.max(0, Math.round(rejVol * share))]);
      for (const [cc, name, city, lat, lon, share] of geo) {
        const conns = Math.round(40 * daily(h) * share * between(0.7, 1.3));
        await tx.run("INSERT INTO metrics_geo (bucket, country, country_name, city, lat, lon, connections, events) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING", [h, cc, name, city, lat, lon, conns, Math.round(vol * share)]);
      }
    }
  });
}

// ---------------------------------------------------------------- live traffic while capturing
const UAS = ["Damus/1.10 (iPhone)", "Amethyst/0.94 (Android)", "Primal/2.1", "nostrudel/0.40 (Firefox)", "Coracle/0.6", "Gossip/0.12 (Linux)"];

async function startTraffic(relay: Relay, people: Map<string, Person>, notes: Event[]) {
  const clients: RelayClient[] = [];
  const authors = [...people.values()].filter((p) => !["spammer", "fake", "flooder", "owner"].includes(p.key));
  // one connection per person (some authenticated), plus readers without a key
  for (const p of authors) {
    const c = await connect(relay, p.ip, pick(UAS));
    if (rand() > 0.35) await c.auth(p.sk, relay.ws).catch(() => {});
    c.send(["REQ", "feed", { kinds: [1, 6, 7], limit: 20 }]);
    c.send(["REQ", "mentions", { "#p": [p.pubkey], limit: 10 }]);
    clients.push(c);
  }
  const readerIps = ["192.0.2.141", "192.0.2.152", "198.51.100.163", "203.0.113.174", "203.0.113.185", "192.0.2.196", "198.51.100.207"];
  for (const ip of readerIps) {
    const c = await connect(relay, ip, pick(UAS));
    c.send(["REQ", "global", { kinds: [1], limit: 50 }]);
    clients.push(c);
  }
  // a spam bot that keeps getting refused (banned key), from a fresh address
  const bot = await connect(relay, "198.51.100.212", "bot/0.1");
  const botKey = newUser();
  await api(relay, "POST", "/users", { pubkey: botKey.pubkey });
  await api(relay, "POST", `/users/${botKey.pubkey}/ban`, { reason: "spam bot" });
  clients.push(bot);

  let stopped = false;
  const byPubkey = new Map(authors.map((p, i) => [p.pubkey, clients[i]!]));
  (async () => {
    let n = 0;
    while (!stopped) {
      const p = pick(authors);
      const c = byPubkey.get(p.pubkey)!;
      const roll = rand();
      try {
        if (roll < 0.6) c.send(["EVENT", sign(p.sk, { kind: 1, content: pick(LIVE_LINES) })]);
        else if (roll < 0.9) {
          const target = pick(notes);
          c.send(["EVENT", sign(p.sk, { kind: 7, content: pick(["+", "❤️", "🔥"]), tags: [["e", target.id], ["p", target.pubkey]] })]);
        }
        else bot.send(["EVENT", sign(botKey.sk, { kind: 1, content: "Free prizes for everyone https://prizes.example" })]);
        if (++n % 5 === 0) pick(clients).send(["REQ", `r${n}`, { kinds: [1], limit: 10 }]);
      } catch {
        /* a closed socket: ignore */
      }
      // drain inboxes so they don't grow
      for (const cl of clients) cl.inbox.length = 0;
      await Bun.sleep(between(1500, 4000));
    }
  })();
  return () => {
    stopped = true;
    for (const c of clients) c.close();
  };
}

// ---------------------------------------------------------------- capture
async function settle(page: Page, ms = 1200) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(ms);
}

async function shot(page: Page, name: string, opts: { fullPage?: boolean; clip?: { x: number; y: number; width: number; height: number } } = {}) {
  // hide toasts and the cursor focus ring left by clicks
  await page.addStyleTag({ content: "[data-sonner-toaster]{display:none!important} *:focus-visible{outline:none!important;box-shadow:none!important}" }).catch(() => {});
  await page.mouse.move(0, 0);
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: opts.fullPage, clip: opts.clip, animations: "disabled" });
  log("saved", `${name}.png`);
}

/**
 * This demo has no GeoIP database (and must not depend on one), so the dashboard's World card and the country flags
 * read invented locations: geo answers come from the backfilled metrics_geo rows, and the documentation-range IPs
 * used by the demo clients map to made-up cities.
 */
function demoGeo(relay: Relay) {
  const m = relay.beamhop.metrics as unknown as Record<string, unknown>;
  (relay.beamhop.config.metrics as { geoipDbPath?: string }).geoipDbPath = "demo-geoip.mmdb";
  m.geo = async (range: { from: number; to: number }) => {
    const rows = await relay.beamhop.stores.db.all<Record<string, unknown>>(
      `SELECT country, MAX(country_name) AS country_name, city, MAX(lat) AS lat, MAX(lon) AS lon, SUM(connections) AS connections, SUM(events) AS events
       FROM metrics_geo WHERE bucket >= ? AND bucket <= ? GROUP BY country, city ORDER BY connections DESC`,
      [Math.floor(range.from / 3600) * 3600, range.to],
    );
    return rows.map((r) => ({ country: String(r.country), countryName: String(r.country_name), city: String(r.city), lat: Number(r.lat), lon: Number(r.lon), connections: Number(r.connections), events: Number(r.events) }));
  };
  const places: [string, string][] = [["DE", "Berlin"], ["NL", "Amsterdam"], ["US", "New York"], ["JP", "Tokyo"], ["GB", "London"], ["BR", "São Paulo"], ["FR", "Lyon"], ["CA", "Toronto"], ["SE", "Stockholm"]];
  m.lookupIp = (ip: string) => {
    const n = Number(ip.split(".").pop());
    if (!/^(192\.0\.2|198\.51\.100|203\.0\.113)\./.test(ip) || !Number.isFinite(n)) return undefined;
    const [country, city] = places[n % places.length]!;
    return { country, city, lat: 0, lon: 0 };
  };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const PLUGINS = join(REPO, "plugins");
  const relay = await startRelay({
    overrides: { server: { trustProxy: true }, plugins: { packages: [join(PLUGINS, "hello"), join(PLUGINS, "spam-filter")] } },
    extras: { pluginsEnabled: ["hello", "spam-filter"] },
  });
  log("relay on", relay.http, "data in", relay.dir);
  demoGeo(relay);
  let stopTraffic: (() => void) | undefined;
  const browser = await chromium.launch();
  const cleanup = async () => {
    stopTraffic?.();
    await browser.close().catch(() => {});
    await relay.stop();
    log("relay stopped, data dir removed");
  };
  process.on("SIGINT", () => void cleanup().then(() => process.exit(130)));
  try {
    const { people, P, notes } = await seed(relay);
    await backfillMetrics(relay, people);

    const base = `${relay.http}/admin/`;
    const common = { baseURL: base, colorScheme: "light" as const, serviceWorkers: "block" as const, locale: "en-US", timezoneId: "Europe/Berlin", extraHTTPHeaders: { "X-Forwarded-For": OWNER_IP } };
    const phoneOpts = {
      ...common, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    };
    const prep = async (ctx: BrowserContext) => {
      await ctx.addInitScript(() => localStorage.setItem("beamhop-theme", "light"));
      return ctx;
    };

    // sign in once (the owner key, signed in the page as the Key tab does) and reuse the session cookie
    const desktop = await prep(await browser.newContext({ ...common, viewport: { width: 1440, height: 900 } }));
    const page = await desktop.newPage();
    await page.goto("login");
    if (want("login")) {
      await settle(page, 600);
      await shot(page, "login-desktop");
    }
    await page.getByRole("tab", { name: "Key", exact: true }).click();
    await page.getByLabel("Private key").fill(relay.owner.nsec);
    await page.getByRole("button", { name: /sign in with (private )?key/i }).click();
    await page.waitForURL((u) => !u.pathname.endsWith("/login"));
    const state = await desktop.storageState();
    const go = async (p: Page, path: string, ms = 1500) => {
      await p.goto(path);
      await settle(p, ms);
    };

    // pages that don't need traffic
    if (want("users")) {
      await go(page, "users");
      await shot(page, "users-desktop");
      await go(page, `users/${P("juniper").pubkey}`);
      await shot(page, "user-detail-desktop");
    }
    if (want("admins")) {
      await go(page, "admins");
      await shot(page, "admins-desktop");
    }
    if (want("invites")) {
      await go(page, "invites");
      await shot(page, "invites-desktop");
    }
    if (want("ip-rules")) {
      await go(page, "ip-rules");
      await shot(page, "ip-rules-desktop");
    }
    if (want("content")) {
      // the router JSON-decodes search params, and the page wants `f` as a JSON string: encode twice
      await go(page, `content?f=${encodeURIComponent(JSON.stringify(JSON.stringify({ kinds: [1] })))}`, 2500);
      await shot(page, "events-desktop");
    }
    if (want("reports")) {
      await go(page, "reports");
      await shot(page, "reports-desktop");
    }
    if (want("media")) {
      await go(page, "media", 2500);
      await shot(page, "media-desktop");
    }
    if (want("groups")) {
      await go(page, "groups");
      await shot(page, "groups-desktop");
    }
    if (want("settings")) {
      await go(page, "settings/info");
      await shot(page, "settings-desktop");
      await go(page, "settings/moderation");
      await shot(page, "settings-moderation-desktop");
    }
    if (want("plugins")) {
      await go(page, "plugins");
      await shot(page, "plugins-desktop");
    }
    if (want("audit")) {
      await go(page, "audit");
      await shot(page, "audit-desktop");
    }
    if (want("system")) {
      await go(page, "system");
      await shot(page, "system-desktop");
    }
    if (want("account")) {
      await go(page, "account");
      await shot(page, "account-desktop");
      await page.getByText("Get push notifications on this device").evaluate((el) => {
        el.closest("[data-slot=card]")?.scrollIntoView({ block: "start" });
        window.scrollBy(0, -80);
      });
      await page.waitForTimeout(400);
      await shot(page, "account-preferences-desktop");
    }
    if (want("palette")) {
      await go(page, "");
      await page.keyboard.press("ControlOrMeta+k");
      await page.keyboard.type("jun");
      await page.waitForTimeout(600);
      await shot(page, "command-palette-desktop");
      await page.keyboard.press("Escape");
    }

    const phone = await prep(await browser.newContext({ ...phoneOpts, storageState: state }));
    const m = await phone.newPage();
    if (want("users")) {
      await go(m, "users");
      await shot(m, "users-phone");
    }
    if (want("reports")) {
      await go(m, "reports");
      await shot(m, "reports-phone");
    }
    if (want("media")) {
      await go(m, "media", 2500);
      await shot(m, "media-phone");
    }
    if (want("more")) {
      await go(m, "users");
      await m.getByRole("button", { name: "More" }).click();
      await m.waitForTimeout(800);
      await shot(m, "more-menu-phone");
    }
    if (want("login")) {
      const anon = await prep(await browser.newContext(phoneOpts));
      const lp = await anon.newPage();
      await lp.goto("login");
      await settle(lp, 600);
      await shot(lp, "login-phone");
      await anon.close();
    }

    // live views: clients connected and publishing
    stopTraffic = await startTraffic(relay, people, notes);
    await Bun.sleep(4000);
    if (want("live")) {
      await go(page, "live", 40_000);
      await shot(page, "live-desktop");
    }
    if (want("dashboard")) {
      // the KPI sparklines draw from the live stream's snapshots (one every 2 s)
      await go(page, "", 1000);
      await page.waitForTimeout(20_000);
      await shot(page, "dashboard-desktop");
      await page.getByText("Where your users connect from").evaluate((el) => {
        el.closest("[data-slot=card]")?.scrollIntoView({ block: "start" });
        window.scrollBy(0, -80);
      });
      await page.waitForTimeout(600);
      await shot(page, "dashboard-breakdowns-desktop");
      await go(m, "", 1000);
      await m.waitForTimeout(20_000);
      await shot(m, "dashboard-phone");
    }
    await desktop.close();
    await phone.close();
  } finally {
    await cleanup();
  }
}

await main();
