// SPDX-License-Identifier: AGPL-3.0-or-later
/** @jsxImportSource hono/jsx */
import type { PageCtx } from '../config.ts';
import type { Incident } from '../incidents.ts';
import type { StatusLevel } from '../status.ts';
import { formatDuration } from '../strings.ts';
import type { UptimeDay } from '../uptime.ts';
import { StatusBadge } from './landing.tsx';
import { Layout } from './layout.tsx';

export function Time(props: { at: number }) {
  const iso = new Date(props.at * 1000).toISOString();
  return <time datetime={iso}>{`${iso.slice(0, 16).replace('T', ' ')} UTC`}</time>;
}

function barClass(r: number | null): string {
  if (r === null) return 'b-none';
  if (r >= 0.999) return '';
  if (r >= 0.95) return 'b-warn';
  return 'b-bad';
}

function pct(r: number): string {
  return (Math.floor(r * 10000) / 100).toFixed(2);
}

function IncidentItem(props: { ctx: PageCtx; inc: Incident }) {
  const { t } = props.ctx;
  const inc = props.inc;
  return (
    <li>
      <p>
        <strong>{inc.title}</strong>{' '}
        <span class="badge">
          {t(`status.state.${inc.state}`)} · {t(`status.impact.${inc.impact}`)}
        </span>
      </p>
      <ul class="plain small">
        {[...inc.updates].reverse().map((u) => (
          <li key={`${u.at}-${u.state}`}>
            <span class="muted">
              <Time at={u.at} /> — {t(`status.state.${u.state}`)}
            </span>
            <br />
            {u.message}
          </li>
        ))}
      </ul>
    </li>
  );
}

export function StatusPage(props: {
  ctx: PageCtx;
  level: StatusLevel;
  days: UptimeDay[];
  overall: number | null;
  upSeconds: number;
  open: Incident[];
  resolved: Incident[];
}) {
  const { ctx } = props;
  const { t } = ctx;
  return (
    <Layout ctx={ctx} title={t('status.title')} page="status">
      <h1>{t('status.title')}</h1>
      <StatusBadge ctx={ctx} level={props.level} />

      <section class="card" aria-labelledby="up-h">
        <h2 id="up-h">{t('status.uptime', { days: props.days.length })}</h2>
        <div
          class="bars"
          role="img"
          aria-label={
            props.overall === null
              ? t('status.uptime.nodata')
              : t('status.uptime.pct', { pct: pct(props.overall) })
          }
        >
          {props.days.map((d) => (
            <span
              key={d.day}
              class={barClass(d.ratio)}
              title={`${new Date(d.day * 1000).toISOString().slice(0, 10)}: ${
                d.ratio === null ? t('status.uptime.nodata') : `${pct(d.ratio)}%`
              }`}
            />
          ))}
        </div>
        <p class="small muted">
          {props.overall === null
            ? t('status.uptime.nodata')
            : t('status.uptime.pct', { pct: pct(props.overall) })}{' '}
          · {t('status.uptime.since', { duration: formatDuration(props.upSeconds) })}
        </p>
        <p class="small muted">{t('status.uptime.legend')}</p>
      </section>

      <section class="card" aria-labelledby="cur-h">
        <h2 id="cur-h">{t('status.current')}</h2>
        {props.open.length === 0 ? (
          <p class="muted">{t('status.none')}</p>
        ) : (
          <ul class="plain">
            {props.open.map((inc) => (
              <IncidentItem key={inc.id} ctx={ctx} inc={inc} />
            ))}
          </ul>
        )}
      </section>

      {props.resolved.length > 0 ? (
        <section class="card" aria-labelledby="past-h">
          <h2 id="past-h">{t('status.past')}</h2>
          <ul class="plain">
            {props.resolved.map((inc) => (
              <IncidentItem key={inc.id} ctx={ctx} inc={inc} />
            ))}
          </ul>
        </section>
      ) : null}
    </Layout>
  );
}
