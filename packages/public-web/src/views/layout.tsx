// SPDX-License-Identifier: AGPL-3.0-or-later
/** @jsxImportSource hono/jsx */
import { raw } from 'hono/html';
import type { Child } from 'hono/jsx';
import type { PageCtx } from '../config.ts';

const DARK =
  '--bg:#0f1115;--fg:#e7e9ee;--muted:#9aa3b2;--card:#171a21;--line:#2a303c;--accent:#8ab4ff;--ok:#3fb950;--warn:#d29922;--bad:#f85149;--none:#3a404c;color-scheme:dark';
const LIGHT =
  '--bg:#f7f7f8;--fg:#15171c;--muted:#596273;--card:#fff;--line:#dfe3ea;--accent:#2f55d4;--ok:#1a7f37;--warn:#9a6700;--bad:#cf222e;--none:#d0d5dd;color-scheme:light';

const BASE_CSS = `*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent)}a:focus-visible,button:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.skip{position:absolute;left:-999px}.skip:focus{left:8px;top:8px;background:var(--card);padding:8px;z-index:9}
header,main,footer{max-width:42rem;margin:0 auto;padding:0 1rem}
header{display:flex;align-items:center;gap:.75rem;padding-top:1rem;flex-wrap:wrap}
header .brand{display:flex;align-items:center;gap:.6rem;font-weight:600;text-decoration:none;color:var(--fg);margin-right:auto}
header img{width:36px;height:36px;border-radius:8px;object-fit:cover}
nav{display:flex;gap:.9rem;font-size:.95rem}nav a{text-decoration:none;color:var(--muted)}nav a[aria-current]{color:var(--fg)}
.banner{width:100%;max-height:180px;object-fit:cover;border-radius:12px;margin-top:1rem;display:block}
h1{font-size:1.6rem;line-height:1.25;margin:1.25rem 0 .5rem}h2{font-size:1.1rem;margin:0 0 .5rem}
p{margin:.4rem 0}.muted{color:var(--muted)}.small{font-size:.875rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:1rem;margin:1rem 0}
.row{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9rem;word-break:break-all}
.url{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:.5rem .65rem;flex:1;min-width:0}
button,.btn{font:inherit;background:var(--accent);color:var(--bg);border:0;border-radius:8px;padding:.5rem .9rem;cursor:pointer;min-height:44px;text-decoration:none;display:inline-flex;align-items:center}
button.ghost{background:transparent;color:var(--fg);border:1px solid var(--line)}button.danger{background:var(--bad);color:#fff}
button[disabled]{opacity:.6;cursor:wait}
input[type=text]{font:inherit;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:.5rem .65rem;min-height:44px;flex:1;min-width:0}
label{display:block;font-size:.9rem;margin-bottom:.25rem}
.qr{display:flex;justify-content:center;margin-top:.75rem}.qr svg{border-radius:8px;max-width:100%;height:auto}
.badge{display:inline-flex;align-items:center;gap:.4rem;font-size:.85rem;padding:.2rem .6rem;border-radius:999px;border:1px solid var(--line);text-decoration:none;color:var(--fg)}
.dot{width:.6rem;height:.6rem;border-radius:50%;background:var(--ok)}.s-minor .dot{background:var(--warn)}.s-major .dot,.s-outage .dot{background:var(--bad)}
.bars{display:flex;gap:2px;height:34px;margin:.5rem 0}.bars span{flex:1;border-radius:2px;background:var(--ok)}
.bars .b-warn{background:var(--warn)}.bars .b-bad{background:var(--bad)}.bars .b-none{background:var(--none)}
ul.plain{list-style:none;padding:0;margin:0}ul.plain li{padding:.5rem 0;border-top:1px solid var(--line)}ul.plain li:first-child{border-top:0}
.note{display:block;border-left:3px solid var(--accent);padding:.25rem .75rem}.note.err{border-color:var(--bad)}
progress{width:100%;height:10px;accent-color:var(--accent)}
.rules{white-space:pre-wrap}
footer{padding-top:1rem;padding-bottom:2rem;color:var(--muted);font-size:.85rem}
@media (prefers-reduced-motion:no-preference){button{transition:opacity .15s}}`;

function themeCss(ctx: PageCtx): string {
  const accent = ctx.branding.accent ? `;--accent:${ctx.branding.accent}` : '';
  const theme = ctx.branding.theme;
  if (theme === 'dark') return `:root{${DARK}${accent}}`;
  if (theme === 'light') return `:root{${LIGHT}${accent}}`;
  return `:root{${DARK}${accent}}@media (prefers-color-scheme:light){:root{${LIGHT}${accent}}}`;
}

/** Inline JSON for scripts, safe inside <script>. */
export function jsonForScript(v: unknown): string {
  return JSON.stringify(v).replace(
    /[<\u2028\u2029]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

export function Layout(props: {
  ctx: PageCtx;
  title: string;
  page: 'home' | 'portal' | 'status' | 'error';
  children: Child;
  script?: string;
}) {
  const { ctx } = props;
  const { relay, t, base } = ctx;
  const pub = relay.public;
  const cur = (p: string) => (props.page === p ? { 'aria-current': 'page' as const } : {});
  const name = relay.info.name;
  return (
    <>
      {raw('<!doctype html>')}
      <html lang={ctx.locale}>
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width,initial-scale=1" />
          <title>{props.title === name ? name : `${props.title} · ${name}`}</title>
          {relay.info.description ? (
            <meta name="description" content={relay.info.description} />
          ) : null}
          <meta name="color-scheme" content="dark light" />
          {relay.info.icon ? <link rel="icon" href={relay.info.icon} /> : null}
          <style nonce={ctx.nonce}>{raw(themeCss(ctx) + BASE_CSS)}</style>
        </head>
        <body>
          <a class="skip" href="#main">
            {t('nav.skip')}
          </a>
          <header>
            <a class="brand" href={pub.landing ? `${base}/` : '#main'}>
              {relay.info.icon ? <img src={relay.info.icon} alt="" /> : null}
              <span>{name}</span>
            </a>
            <nav aria-label="Main">
              {pub.landing ? (
                <a href={`${base}/`} {...cur('home')}>
                  {t('nav.home')}
                </a>
              ) : null}
              {pub.portal ? (
                <a href={`${base}/portal`} {...cur('portal')}>
                  {t('nav.portal')}
                </a>
              ) : null}
              {pub.status ? (
                <a href={`${base}/status`} {...cur('status')}>
                  {t('nav.status')}
                </a>
              ) : null}
            </nav>
          </header>
          <main id="main">{props.children}</main>
          <footer>
            {ctx.branding.footer ? <p>{ctx.branding.footer}</p> : null}
            <p>
              {t('footer.powered')} · <a href={ctx.cfg.sourceUrl}>{t('footer.source')}</a>
            </p>
          </footer>
          {props.script ? <script nonce={ctx.nonce}>{raw(props.script)}</script> : null}
        </body>
      </html>
    </>
  );
}
