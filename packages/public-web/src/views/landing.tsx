// SPDX-License-Identifier: AGPL-3.0-or-later
/** @jsxImportSource hono/jsx */
import { raw } from 'hono/html';
import type { PageCtx } from '../config.ts';
import { npub } from '../session.ts';
import type { StatusLevel } from '../status.ts';
import { Layout, jsonForScript } from './layout.tsx';

export function StatusBadge(props: { ctx: PageCtx; level: StatusLevel }) {
  const { t, base } = props.ctx;
  const label = props.level === 'ok' ? t('status.badge.ok') : t(`status.badge.${props.level}`);
  return (
    <a id="status" class={`badge s-${props.level}`} href={`${base}/status`}>
      <span class="dot" aria-hidden="true" />
      <span class="t">{label}</span>
    </a>
  );
}

function CopyRow(props: { ctx: PageCtx; value: string; id: string }) {
  return (
    <div class="row">
      <code class="url" id={props.id}>
        {props.value}
      </code>
      <button
        type="button"
        class="ghost"
        data-copy={props.value}
        hidden
        aria-describedby={props.id}
      >
        {props.ctx.t('landing.copy')}
      </button>
    </div>
  );
}

function Rules(props: { rules: string; ctx: PageCtx }) {
  if (/^https?:\/\/\S+$/.test(props.rules.trim())) {
    return (
      <p>
        <a href={props.rules.trim()} rel="noopener">
          {props.ctx.t('landing.rules.link')}
        </a>
      </p>
    );
  }
  return <p class="rules">{props.rules}</p>;
}

function Access(props: { ctx: PageCtx }) {
  const { relay, t, base } = props.ctx;
  const a = relay.access;
  const portal = relay.public.portal;
  return (
    <section class="card" aria-labelledby="access-h">
      <h2 id="access-h">{t('landing.access.title')}</h2>
      {a.mode === 'open' ? <p>{t('landing.access.open')}</p> : null}
      {a.mode === 'allowlist' ? (
        <p>
          {a.authRequired.read
            ? t('landing.access.allowlist.private')
            : t('landing.access.allowlist')}
        </p>
      ) : null}
      {a.mode === 'wot' ? (
        <>
          <p>{t('landing.access.wot', { depth: a.wot.depth })}</p>
          {a.wot.minFollowers > 1 ? (
            <p class="muted">{t('landing.access.wot.min', { count: a.wot.minFollowers })}</p>
          ) : null}
        </>
      ) : null}
      {a.authRequired.read ? <p class="muted">{t('landing.access.readAuth')}</p> : null}
      {!a.authRequired.read && a.authRequired.write ? (
        <p class="muted">{t('landing.access.writeAuth')}</p>
      ) : null}
      {a.mode === 'allowlist' && portal ? (
        <form method="get" action={`${base}/portal`}>
          <h2>{t('landing.join.title')}</h2>
          <p class="muted">{t('landing.join.body')}</p>
          <label for="invite">{t('landing.join.code')}</label>
          <div class="row">
            <input
              type="text"
              id="invite"
              name="invite"
              required
              autocomplete="off"
              maxlength={128}
            />
            <button type="submit">{t('landing.join.submit')}</button>
          </div>
        </form>
      ) : null}
      {a.mode === 'wot' ? (
        <>
          <h2>{t('landing.wot.title')}</h2>
          <p class="muted">{t('landing.wot.body')}</p>
        </>
      ) : null}
    </section>
  );
}

export function LandingPage(props: { ctx: PageCtx; level: StatusLevel | null; qrSvg: string }) {
  const { ctx } = props;
  const { relay, t } = ctx;
  const info = relay.info;
  const script = `(()=>{const C=${jsonForScript({ copied: t('landing.copied'), statusUrl: `${ctx.base}/status.json` })};
const live=document.getElementById('live');
document.querySelectorAll('[data-copy]').forEach(b=>{b.hidden=false;b.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(b.dataset.copy);const o=b.textContent;b.textContent=C.copied;live.textContent=C.copied;setTimeout(()=>{b.textContent=o;live.textContent=''},1500)}catch(e){}})});
const s=document.getElementById('status');if(s)setInterval(async()=>{try{const r=await fetch(C.statusUrl,{headers:{accept:'application/json'}});if(!r.ok)return;const j=await r.json();s.className='badge s-'+j.level;s.querySelector('.t').textContent=j.label}catch(e){}},60000)})()`;
  return (
    <Layout ctx={ctx} title={info.name} page="home" script={script}>
      {info.banner ? <img class="banner" src={info.banner} alt="" /> : null}
      <h1>{info.name}</h1>
      {props.level ? <StatusBadge ctx={ctx} level={props.level} /> : null}
      {info.description ? <p>{info.description}</p> : null}
      <div aria-live="polite" class="skip" id="live" />

      <section class="card" aria-labelledby="connect-h">
        <h2 id="connect-h">{t('landing.connect.title')}</h2>
        <p class="muted">{t('landing.connect.body')}</p>
        <CopyRow ctx={ctx} value={ctx.wsUrl} id="ws-url" />
        <figure class="qr" aria-label={t('landing.connect.qr')}>
          {raw(props.qrSvg)}
        </figure>
      </section>

      {relay.blossom.enabled ? (
        <section class="card" aria-labelledby="media-h">
          <h2 id="media-h">{t('landing.media.title')}</h2>
          <p class="muted">{t('landing.media.body')}</p>
          <CopyRow ctx={ctx} value={ctx.publicUrl} id="media-url" />
        </section>
      ) : null}

      <Access ctx={ctx} />

      {info.rules ? (
        <section class="card" aria-labelledby="rules-h">
          <h2 id="rules-h">{t('landing.rules.title')}</h2>
          <Rules rules={info.rules} ctx={ctx} />
        </section>
      ) : null}

      {info.contact || info.pubkey ? (
        <section class="card small">
          {info.contact ? (
            <p>
              {t('landing.contact')}:{' '}
              {/^(mailto:|https?:)/.test(info.contact) ? (
                <a href={info.contact}>{info.contact.replace(/^mailto:/, '')}</a>
              ) : (
                info.contact
              )}
            </p>
          ) : null}
          {info.pubkey && /^[0-9a-f]{64}$/.test(info.pubkey) ? (
            <p>
              {t('landing.owner')}: <span class="mono">{npub(info.pubkey)}</span>
            </p>
          ) : null}
        </section>
      ) : null}
    </Layout>
  );
}
