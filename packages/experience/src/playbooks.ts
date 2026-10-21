// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Guided playbooks (§6.10): plain step-by-step help for the moments an admin
 * feels lost. Steps may point at an action (with prefilled input) — running it
 * still goes through the normal preview → apply → undo path. Steps that change
 * settings point at `experience.simulate-change` first, so the admin sees the
 * effect on recent traffic before applying anything.
 */
import type { Playbook } from '@beamhop/core';

export const PLAYBOOKS: Playbook[] = [
  {
    id: 'spam-attack',
    title: 'Spam attack',
    steps: [
      {
        title: 'Breathe — your filters are already working',
        body: 'Your current rules keep blocking spam while you decide. Nothing you do here is permanent: every change can be undone.',
      },
      {
        title: 'See what is being blocked',
        body: 'Look at which filters are catching the spam right now. Lots of "too fast" or "duplicate" means a bot wave.',
        actionId: 'policy.stats',
        input: {},
      },
      {
        title: 'Try stricter spam blocking first',
        body: 'Preview what a stricter spam setting would have done to the last day of posts — before you apply it.',
        actionId: 'experience.simulate-change',
        input: { merge: { goals: { spamTolerance: 15 } }, hours: 24 },
      },
      {
        title: 'Ask brand-new accounts to do a little work',
        body: 'New accounts must solve a small puzzle before posting. Real people barely notice; bots slow down a lot. Preview it first.',
        actionId: 'experience.simulate-change',
        input: { merge: { limits: { newKeyPowDifficulty: 20 } }, hours: 24 },
      },
      {
        title: 'Block the accounts behind the wave',
        body: 'If a "spam wave" card is on Home, approve it to block those accounts in one go (you can undo it).',
        actionId: 'experience.inbox',
        input: {},
      },
      {
        title: 'Clean up what got through',
        body: 'Review the moderation queue and remove anything that slipped past.',
        actionId: 'moderation.queue',
        input: { status: 'pending' },
      },
      {
        title: 'Relax again later',
        body: 'When things are quiet for a day, move the spam setting back. The settings history shows exactly what you changed.',
      },
    ],
  },
  {
    id: 'disk-full',
    title: 'Disk filling up',
    steps: [
      {
        title: 'See what takes the space',
        body: 'Check the Media tab and the storage tile on Home: posts and files are counted separately.',
      },
      {
        title: 'Empty the recycle bin',
        body: 'Removed posts and files stay for 30 days so mistakes can be undone. If you are sure, emptying it frees space now.',
        actionId: 'moderation.recycle-bin',
        input: {},
      },
      {
        title: 'Keep less history',
        body: 'Move the Storage goal toward "Keep it lean" so old posts are cleaned up automatically. Preview it first.',
        actionId: 'experience.simulate-change',
        input: { merge: { goals: { storage: 30 } }, hours: 24 },
      },
      {
        title: 'Lower upload limits',
        body: 'Smaller file limits and quotas slow down growth from large uploads.',
      },
      {
        title: 'Move files to cheaper storage',
        body: 'Files can live in any S3-compatible bucket instead of the server disk. Set it up under Settings → Storage.',
      },
      {
        title: 'Or give the server more room',
        body: 'Sometimes the simplest fix is a bigger disk. Take a backup first.',
      },
    ],
  },
  {
    id: 'moving-servers',
    title: 'Moving servers',
    steps: [
      {
        title: 'Take a fresh backup',
        body: 'Make sure a backup finished in the last hour. Your settings, posts and files are all included.',
      },
      {
        title: 'Install Beamhop on the new server',
        body: 'Run the installer there, but do not point your domain at it yet.',
      },
      {
        title: 'Restore the backup on the new server',
        body: 'Use "beamhop restore" with your backup. Your settings, admins and keys come along.',
      },
      {
        title: 'Lower the DNS cache time',
        body: 'A day before switching, set your domain’s TTL to a few minutes so the move takes effect quickly.',
      },
      {
        title: 'Point your domain to the new server',
        body: 'Change the DNS record to the new address. Apps reconnect automatically.',
      },
      {
        title: 'Test from the outside',
        body: 'Check that people can connect, post, read and upload on the new server.',
        actionId: 'experience.test-relay',
        input: {},
      },
      {
        title: 'Keep the old server for a few days',
        body: 'Leave it running read-only until you are confident, then shut it down.',
      },
    ],
  },
  {
    id: 'lost-admin-access',
    title: 'Lost admin access',
    steps: [
      {
        title: 'Use a recovery code',
        body: 'On the sign-in screen choose "Use a recovery code". Each code works once and makes you owner again.',
      },
      {
        title: 'Ask the other owner',
        body: 'If someone else is an owner, they can give your new key access from People → Admins.',
        actionId: 'admins.invite',
        input: { role: 'owner' },
      },
      {
        title: 'Use the server itself',
        body: 'Whoever can log in to the server can run "beamhop admin claim" to get a fresh one-time sign-in code.',
      },
      {
        title: 'Start in safe mode if settings are broken',
        body: 'Run "beamhop --safe" to start with the last settings that were known to work.',
      },
      {
        title: 'Make new recovery codes',
        body: 'Once you are back in, create new codes and store them somewhere safe. The old ones stop working.',
        actionId: 'admins.recovery-codes',
        input: {},
      },
      {
        title: 'Add a second owner',
        body: 'A trusted second owner means this never locks you out again.',
        actionId: 'admins.invite',
        input: { role: 'owner' },
      },
    ],
  },
  {
    id: 'relay-is-slow',
    title: 'Relay is slow',
    steps: [
      {
        title: 'Check whether it is busy or stuck',
        body: 'Look at the connections and events-per-second tiles on Home. A sudden jump usually means a bot or a spam wave.',
      },
      {
        title: 'Look for a flood',
        body: 'If filters are rejecting a lot, follow the spam playbook — blocking a wave often fixes speed too.',
        actionId: 'policy.stats',
        input: {},
      },
      {
        title: 'Favor speed over cost',
        body: 'Move the "Speed vs cost" goal toward Fastest: bigger caches and more workers. Preview it first.',
        actionId: 'experience.simulate-change',
        input: { merge: { goals: { speedVsCost: 80 } }, hours: 1 },
      },
      {
        title: 'Limit very heavy requests',
        body: 'Lowering how many results one request may ask for keeps a few greedy apps from slowing everyone down.',
      },
      {
        title: 'Check the server itself',
        body: 'Low free memory or a full disk slow everything down. The Home health score shows which part is struggling.',
      },
      {
        title: 'Test from the outside',
        body: 'Sometimes the relay is fine and the network in front of it is slow.',
        actionId: 'experience.test-relay',
        input: {},
      },
    ],
  },
  {
    id: 'certificate-problem',
    title: 'Certificate problem',
    steps: [
      {
        title: 'Confirm what people see',
        body: 'Run the outside test. If connecting fails while the server is up, the certificate (the padlock) is the usual suspect.',
        actionId: 'experience.test-relay',
        input: {},
      },
      {
        title: 'Check your domain points here',
        body: 'Automatic certificates only work when your domain’s DNS record points to this server.',
      },
      {
        title: 'Make sure port 80 and 443 are open',
        body: 'The certificate authority needs to reach the server on these ports to renew the certificate.',
      },
      {
        title: 'Behind a proxy or Cloudflare?',
        body: 'Then the proxy handles certificates. Set the security mode to "proxy" under Settings → Domains and check the proxy’s certificate instead.',
      },
      {
        title: 'Check the server clock',
        body: 'A wrong date on the server makes valid certificates look expired.',
      },
      {
        title: 'Test again',
        body: 'After fixing, run the outside test once more.',
        actionId: 'experience.test-relay',
        input: {},
      },
    ],
  },
];

/** Register our playbooks, skipping ids another module already provides. Returns the ids added. */
export function registerPlaybooks(target: Playbook[]): string[] {
  const have = new Set(target.map((p) => p.id));
  const added: string[] = [];
  for (const p of PLAYBOOKS) {
    if (have.has(p.id)) continue;
    target.push(p);
    added.push(p.id);
  }
  return added;
}
