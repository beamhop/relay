// SPDX-License-Identifier: AGPL-3.0-or-later
/** @jsxImportSource hono/jsx */
import type { BlobOwnership } from '@beamhop/core';
import type { PageCtx } from '../config.ts';
import { formatBytes } from '../strings.ts';
import { Layout, jsonForScript } from './layout.tsx';
import { Time } from './status.tsx';

export interface Flash {
  kind: 'ok' | 'err';
  text: string;
}

function FlashNote(props: { flash?: Flash | undefined }) {
  if (!props.flash) return null;
  return (
    <output class={props.flash.kind === 'err' ? 'note err' : 'note'}>{props.flash.text}</output>
  );
}

const SHA_HEX = (s: string) => `${s.slice(0, 10)}…${s.slice(-6)}`;

export function LoginPage(props: { ctx: PageCtx; flash?: Flash | undefined }) {
  const { ctx } = props;
  const { t, base } = ctx;
  const script = `(()=>{const C=${jsonForScript({
    challenge: `${base}/portal/challenge`,
    noext: t('portal.login.noext'),
    failed: t('portal.login.failed'),
  })};
const b=document.getElementById('login'),m=document.getElementById('msg');document.getElementById('nojs').hidden=true;b.hidden=false;
const hex=a=>[...new Uint8Array(a)].map(x=>x.toString(16).padStart(2,'0')).join('');
b.addEventListener('click',async()=>{if(!window.nostr){m.textContent=C.noext;return}b.disabled=true;m.textContent='';
try{const r=await fetch(C.challenge,{method:'POST'});if(!r.ok)throw 0;const{challenge,url}=await r.json();const body=JSON.stringify({challenge});
const ev=await window.nostr.signEvent({kind:27235,created_at:Math.floor(Date.now()/1e3),content:'',tags:[['u',url],['method','POST'],['payload',hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(body)))]]});
const res=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:'Nostr '+btoa(JSON.stringify(ev))},body});if(!res.ok)throw 0;location.reload()}
catch(e){m.textContent=C.failed;b.disabled=false}})})()`;
  return (
    <Layout ctx={ctx} title={t('portal.login.title')} page="portal" script={script}>
      <h1>{t('portal.login.title')}</h1>
      <FlashNote flash={props.flash} />
      <section class="card">
        <p>{t('portal.login.body')}</p>
        <p id="nojs" class="muted">
          {t('portal.login.nojs')}
        </p>
        <button type="button" id="login" hidden>
          {t('portal.login.button')}
        </button>
        <p id="msg" role="status" aria-live="polite" class="muted" />
      </section>
    </Layout>
  );
}

export interface PortalData {
  pubkey: string;
  npub: string;
  tierName: string;
  member: boolean | null;
  plan: string[];
  storage: { used: number; quota: number } | null;
  files: BlobOwnership[];
  filesLimit: number;
  csrf: string;
  invite: { show: boolean; code: string };
  flash?: Flash | undefined;
}

function Csrf(props: { token: string }) {
  return <input type="hidden" name="csrf" value={props.token} />;
}

export function PortalPage(props: { ctx: PageCtx; data: PortalData }) {
  const { ctx, data } = props;
  const { t, base } = ctx;
  const script = `(()=>{const C=${jsonForScript({ relay: ctx.wsUrl, needs: t('portal.vanish.needsSign') })};
const f=document.getElementById('vanish');if(!f)return;f.addEventListener('submit',async e=>{if(f.dataset.signed)return;e.preventDefault();const m=document.getElementById('vmsg');
try{if(!window.nostr)throw 0;const ev=await window.nostr.signEvent({kind:62,created_at:Math.floor(Date.now()/1e3),content:'',tags:[['relay',C.relay]]});
f.elements.event.value=JSON.stringify(ev);f.dataset.signed='1';f.submit()}catch(x){m.textContent=C.needs}})})()`;
  return (
    <Layout ctx={ctx} title={t('portal.title')} page="portal" script={script}>
      <h1>{t('portal.title')}</h1>
      <FlashNote flash={data.flash} />
      <div class="row small">
        <span class="muted">{t('portal.you')}</span>
        <code class="mono">{data.npub}</code>
        <form method="post" action={`${base}/portal/logout`}>
          <Csrf token={data.csrf} />
          <button type="submit" class="ghost">
            {t('portal.logout')}
          </button>
        </form>
      </div>

      <section class="card" aria-labelledby="plan-h">
        <h2 id="plan-h">{t('portal.plan.title')}</h2>
        <p>
          <strong>{t('portal.plan.tier', { name: data.tierName })}</strong>
        </p>
        {data.member === null ? null : (
          <p>{data.member ? t('portal.plan.access.member') : t('portal.plan.access.notMember')}</p>
        )}
        <ul>
          {data.plan.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>

      {data.invite.show ? (
        <section class="card" aria-labelledby="inv-h">
          <h2 id="inv-h">{t('portal.invite.title')}</h2>
          <form method="post" action={`${base}/portal/invite`}>
            <Csrf token={data.csrf} />
            <label for="code">{t('landing.join.code')}</label>
            <div class="row">
              <input
                type="text"
                id="code"
                name="code"
                required
                autocomplete="off"
                maxlength={128}
                value={data.invite.code}
              />
              <button type="submit">{t('landing.join.submit')}</button>
            </div>
          </form>
        </section>
      ) : null}

      {data.storage ? (
        <section class="card" aria-labelledby="st-h">
          <h2 id="st-h">{t('portal.storage.title')}</h2>
          <progress
            max={Math.max(1, data.storage.quota)}
            value={Math.min(data.storage.used, data.storage.quota)}
            aria-labelledby="st-txt"
            data-testid="storage-bar"
          />
          <p id="st-txt" class="small" data-testid="storage-text">
            {t('portal.storage.left', {
              used: formatBytes(data.storage.used),
              quota: formatBytes(data.storage.quota),
              left: formatBytes(Math.max(0, data.storage.quota - data.storage.used)),
            })}
          </p>
          {data.storage.used > data.storage.quota ? (
            <output class="note err small">
              {t('portal.storage.over', {
                over: formatBytes(data.storage.used - data.storage.quota),
              })}
            </output>
          ) : data.storage.used === data.storage.quota && data.storage.quota > 0 ? (
            <output class="note err small">{t('portal.storage.full')}</output>
          ) : null}
        </section>
      ) : null}

      {data.storage ? (
        <section class="card" aria-labelledby="files-h">
          <h2 id="files-h">{t('portal.files.title')}</h2>
          {data.files.length === 0 ? (
            <p class="muted">{t('portal.files.none')}</p>
          ) : (
            <ul class="plain">
              {data.files.map((f) => (
                <li class="row" key={f.sha256}>
                  <a class="mono" href={`${ctx.publicUrl}/${f.sha256}`} rel="noopener">
                    {SHA_HEX(f.sha256)}
                  </a>
                  <span class="small muted">
                    {f.type} · {formatBytes(f.size)} · <Time at={f.uploadedAt} />
                  </span>
                  <form method="post" action={`${base}/portal/files/delete`}>
                    <Csrf token={data.csrf} />
                    <input type="hidden" name="sha256" value={f.sha256} />
                    <button
                      type="submit"
                      class="ghost"
                      aria-label={`${t('portal.files.delete')} ${f.sha256}`}
                    >
                      {t('portal.files.delete')}
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          )}
          {data.files.length >= data.filesLimit ? (
            <p class="small muted">{t('portal.files.more', { n: data.filesLimit })}</p>
          ) : null}
        </section>
      ) : null}

      <section class="card" aria-labelledby="ex-h">
        <h2 id="ex-h">{t('portal.export.title')}</h2>
        <p class="muted">{t('portal.export.body')}</p>
        <a class="btn" href={`${base}/portal/export`} download>
          {t('portal.export.button')}
        </a>
      </section>

      <section class="card" aria-labelledby="va-h">
        <h2 id="va-h">{t('portal.vanish.title')}</h2>
        <p class="muted">{t('portal.vanish.body')}</p>
        <form method="post" action={`${base}/portal/vanish`} id="vanish">
          <Csrf token={data.csrf} />
          <input type="hidden" name="event" value="" />
          <label for="confirm">{t('portal.vanish.confirm')}</label>
          <div class="row">
            <input
              type="text"
              id="confirm"
              name="confirm"
              required
              pattern="DELETE"
              autocomplete="off"
            />
            <button type="submit" class="danger">
              {t('portal.vanish.button')}
            </button>
          </div>
          <p id="vmsg" role="status" aria-live="polite" class="small" />
        </form>
      </section>
    </Layout>
  );
}
