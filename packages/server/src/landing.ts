import type { RuntimeSettings } from "@beamhop/sdk";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function wsUrlFrom(publicUrl: string) {
  return publicUrl.replace(/^http/, "ws").replace(/\/+$/, "") + "/";
}

export function renderLanding(opts: { settings: RuntimeSettings; publicUrl: string; nip11: Record<string, unknown>; version: string; blossom: boolean; admin: boolean }): string {
  const { info } = opts.settings;
  const nips = Array.isArray(opts.nip11.supported_nips) ? (opts.nip11.supported_nips as number[]) : [];
  const ws = wsUrlFrom(opts.publicUrl);
  const icon = info.icon ? `<img class="icon" src="${esc(info.icon)}" alt="" width="72" height="72">` : `<div class="icon ph">⚡</div>`;
  const banner = info.banner ? `<div class="banner" style="background-image:url('${esc(info.banner)}')"></div>` : "";
  const nipLinks = nips
    .map((n) => {
      const id = String(n).padStart(2, "0");
      return `<a class="nip" href="https://github.com/nostr-protocol/nips/blob/master/${esc(id)}.md" target="_blank" rel="noopener">NIP-${esc(id)}</a>`;
    })
    .join("");
  const access = opts.settings.access.mode;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(info.name)}</title>
<meta name="description" content="${esc(info.description)}">
${info.icon ? `<link rel="icon" href="${esc(info.icon)}">` : ""}
<style>
:root{color-scheme:light dark;--bg:#f7f7fb;--card:#fff;--fg:#14161c;--muted:#5f6577;--line:#e3e5ee;--accent:#7c3aed}
@media (prefers-color-scheme:dark){:root{--bg:#0b0d12;--card:#12151d;--fg:#e8eaf1;--muted:#9097aa;--line:#232838;--accent:#a78bfa}}
*{box-sizing:border-box}body{margin:0;font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--fg)}
main{max-width:46rem;margin:0 auto;padding:3rem 1.25rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;overflow:hidden}
.banner{height:140px;background-size:cover;background-position:center}
.body{padding:1.75rem}
header{display:flex;gap:1rem;align-items:center}
.icon{width:72px;height:72px;border-radius:16px;object-fit:cover;flex:none}
.ph{display:grid;place-items:center;font-size:2rem;background:linear-gradient(135deg,var(--accent),#ec4899);color:#fff}
h1{margin:0;font-size:1.6rem}p.desc{color:var(--muted);margin:.25rem 0 0;white-space:pre-line}
.row{display:flex;gap:.5rem;align-items:center;margin-top:1.5rem;flex-wrap:wrap}
code.url{flex:1;min-width:14rem;padding:.7rem .9rem;border:1px solid var(--line);border-radius:10px;font-size:.95rem;background:var(--bg);overflow-x:auto;white-space:nowrap}
button,.btn{cursor:pointer;border:1px solid var(--line);background:var(--bg);color:var(--fg);padding:.65rem .95rem;border-radius:10px;font:inherit;text-decoration:none}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
h2{font-size:.8rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:1.75rem 0 .6rem}
.nips{display:flex;flex-wrap:wrap;gap:.4rem}
.nip{font-size:.8rem;padding:.2rem .55rem;border-radius:999px;border:1px solid var(--line);color:var(--fg);text-decoration:none}
.nip:hover{border-color:var(--accent)}
dl{display:grid;grid-template-columns:max-content 1fr;gap:.35rem 1rem;margin:0}dt{color:var(--muted)}dd{margin:0;word-break:break-all}
footer{color:var(--muted);font-size:.8rem;text-align:center;margin-top:1.5rem}footer a{color:inherit}
</style>
</head>
<body>
<main>
<div class="card">
${banner}
<div class="body">
<header>${icon}<div><h1>${esc(info.name)}</h1><p class="desc">${esc(info.description)}</p></div></header>
<div class="row"><code class="url" id="ws">${esc(ws)}</code><button type="button" onclick="navigator.clipboard.writeText(document.getElementById('ws').textContent);this.textContent='Copied'">Copy</button>${opts.admin ? `<a class="btn primary" href="/admin/">Admin</a>` : ""}</div>
<h2>Relay</h2>
<dl>
<dt>Access</dt><dd>${esc(access)}</dd>
${info.contact ? `<dt>Contact</dt><dd>${esc(info.contact)}</dd>` : ""}
${info.pubkey ? `<dt>Operator</dt><dd>${esc(info.pubkey)}</dd>` : ""}
${opts.blossom ? `<dt>Media</dt><dd>Blossom server at <code>${esc(opts.publicUrl)}</code></dd>` : ""}
${info.termsOfService ? `<dt>Terms</dt><dd><a href="${esc(info.termsOfService)}">${esc(info.termsOfService)}</a></dd>` : ""}
${info.postingPolicy ? `<dt>Posting policy</dt><dd><a href="${esc(info.postingPolicy)}">${esc(info.postingPolicy)}</a></dd>` : ""}
</dl>
${nips.length ? `<h2>Supported NIPs</h2><div class="nips">${nipLinks}</div>` : ""}
</div>
</div>
<footer>Powered by <a href="https://github.com/beamhop/beamhop">beamhop</a> v${esc(opts.version)}</footer>
</main>
</body>
</html>`;
}
