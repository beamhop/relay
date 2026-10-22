const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** Standalone page for invite links: redeems the code with a NIP-07 signer via NIP-98 `POST /invite/redeem`. */
export function invitePage(opts: { code: string; relayName: string; relayUrl: string; redeemUrl: string }): string {
  const name = esc(opts.relayName);
  // JSON inside <script>: escape "<" so the code can't close the tag
  const data = JSON.stringify({ code: opts.code, redeemUrl: opts.redeemUrl }).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Join ${name}</title>
<style>
body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5;color:#111;background:#fafafa}
@media(prefers-color-scheme:dark){body{color:#eee;background:#111}code{background:#222}}
code{background:#eee;padding:.1rem .3rem;border-radius:4px;word-break:break-all}
button{font:inherit;padding:.6rem 1.2rem;border-radius:8px;border:0;background:#7c3aed;color:#fff;cursor:pointer}
button:disabled{opacity:.6}#msg{margin-top:1rem}
</style></head><body>
<h1>Join ${name}</h1>
<p>You've been invited to publish to <code>${esc(opts.relayUrl)}</code>.</p>
<p>Invite code: <code id="code"></code></p>
<button id="go">Redeem with Nostr extension</button>
<p id="msg"></p>
<p><small>No extension? Ask the relay operator to add your pubkey, or send a NIP-98 signed <code>POST /invite/redeem</code> with body <code>{"code":"…"}</code>.</small></p>
<script type="application/json" id="data">${data}</script>
<script>
const { code, redeemUrl: url } = JSON.parse(document.getElementById("data").textContent);
const msg = document.getElementById("msg"), btn = document.getElementById("go");
document.getElementById("code").textContent = code;
const say = (t) => { msg.textContent = t; };
btn.onclick = async () => {
  if (!window.nostr) return say("No NIP-07 extension found (e.g. Alby, nos2x).");
  btn.disabled = true;
  try {
    const body = JSON.stringify({ code });
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const ev = await window.nostr.signEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: "", tags: [["u", url], ["method", "POST"], ["payload", hash]] });
    const res = await fetch(url, { method: "POST", headers: { Authorization: "Nostr " + btoa(JSON.stringify(ev)), "Content-Type": "application/json" }, body });
    const r = await res.json().catch(() => ({}));
    if (r.ok) say(r.alreadyMember ? "You're already a member. You can publish to this relay." : "Welcome! You can now publish to this relay.");
    else { say("Could not redeem: " + (r.error || res.status)); btn.disabled = false; }
  } catch (e) { say("Error: " + (e && e.message || e)); btn.disabled = false; }
};
</script></body></html>`;
}
