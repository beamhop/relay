// SPDX-License-Identifier: AGPL-3.0-or-later
/** `beamhop status`: the Home screen in a terminal — health score and attention cards. */
import { type FlagValues, bool, str } from '../args.ts';
import { type AdminClient, NODE, expectOk, relayPath } from '../client.ts';
import type { CliContext } from '../context.ts';
import { json } from '../format.ts';
import { EXIT, line, paint } from '../io.ts';

interface Health {
  score: number;
  status: 'ok' | 'warn' | 'critical';
  message: string;
  subsystems: Array<{ subsystem: string; score: number; status: string; message: string }>;
  checks: Array<{ id: string; status: string; message: string; technical?: string }>;
}

interface Card {
  severity: 'info' | 'warning' | 'critical';
  title: string;
  body: string;
  technical?: string;
  count?: number;
  primary?: { label: string; actionId: string; input: unknown };
}

export async function statusCommand(
  ctx: CliContext,
  client: AdminClient,
  flags: FlagValues,
): Promise<number> {
  const { io } = ctx;
  const p = paint(io);
  const relay = str(flags.relay);
  const prefix = relay ? relayPath(relay) : NODE;
  const [h, c] = await Promise.all([
    expectOk(client.request('GET', `${prefix}/health`)),
    expectOk(client.request('GET', `${prefix}/cards`)),
  ]);
  const health = h.json as Health;
  const cards = (c.json?.cards ?? []) as Card[];
  if (bool(flags.json)) {
    json(io, { health, cards });
  } else {
    const technical = bool(flags.technical);
    const mark = (s: string) =>
      s === 'ok' ? p.green('✓') : s === 'warn' ? p.yellow('!') : p.red('✗');
    const scoreColor =
      health.status === 'ok' ? p.green : health.status === 'warn' ? p.yellow : p.red;
    line(io, `${p.bold('Health')} ${scoreColor(`${health.score}/100`)} — ${health.message}`);
    line(
      io,
      p.dim(`  ${client.mode === 'remote' ? client.target : `local data at ${client.target}`}`),
    );
    for (const s of health.subsystems ?? [])
      line(
        io,
        `  ${mark(s.status)} ${s.subsystem.padEnd(12)} ${String(s.score).padStart(3)}  ${s.message}`,
      );
    if (technical)
      for (const ch of health.checks ?? [])
        if (ch.technical) line(io, p.dim(`      ${ch.id}: ${ch.technical}`));
    if (!cards.length) line(io, `\n${p.green('Nothing needs your attention.')}`);
    else {
      line(io, `\n${p.bold(`Needs attention (${cards.length})`)}`);
      for (const card of cards) {
        const sev =
          card.severity === 'critical'
            ? p.red('✗')
            : card.severity === 'warning'
              ? p.yellow('!')
              : '•';
        line(io, `  ${sev} ${card.title}${card.count && card.count > 1 ? ` (${card.count})` : ''}`);
        line(io, `    ${card.body}`);
        if (card.primary)
          line(
            io,
            `    → ${card.primary.label}: ${p.cyan(`beamhop ${card.primary.actionId.split('.').join(' ')} --input '${JSON.stringify(card.primary.input ?? {})}'`)}`,
          );
        if (technical && card.technical) line(io, p.dim(`    ${card.technical}`));
      }
    }
  }
  return health.status === 'critical' ? EXIT.error : EXIT.ok;
}
