// SPDX-License-Identifier: AGPL-3.0-or-later
/** Guided playbooks (§6.10) linked from alert cards. Plain, step-by-step. */
import type { Playbook } from '@beamhop/core';

export const PLAYBOOKS: Playbook[] = [
  {
    id: 'spam-attack',
    title: 'Spam attack',
    steps: [
      {
        title: 'Take a breath — you are protected',
        body: 'Your filters and rate limits keep blocking spam on their own. Nothing you do here is urgent, and every change can be undone.',
      },
      {
        title: 'See what is being blocked',
        body: 'Look at which filters are turning posts away and how many. If most are from brand-new accounts, the next steps help most.',
        actionId: 'policy.stats',
        input: {},
      },
      {
        title: 'Review the spam wave card',
        body: 'If Beamhop grouped the spamming accounts into one card, you can block them all in one tap.',
        actionId: 'moderation.queue',
        input: { status: 'pending' },
      },
      {
        title: 'Tighten for a while',
        body: 'Move the "spam tolerance" goal toward strict, or ask new accounts to solve a small puzzle before posting. Loosen it again once things calm down.',
      },
      {
        title: 'Snooze this alert',
        body: 'Once you have acted, snooze the alert for a day so it does not keep pinging you.',
      },
    ],
  },
  {
    id: 'disk-full',
    title: 'Disk filling up',
    steps: [
      {
        title: 'Check how fast it is growing',
        body: 'Look at storage over the last days. A sudden jump often means a spam wave or one very active account.',
        actionId: 'insights.series',
        input: { metric: 'storage.bytes', hours: 168 },
      },
      {
        title: 'Find the biggest users',
        body: 'The Community page lists who uses the most media storage. Consider a lower quota for them.',
        actionId: 'insights.analytics',
        input: {},
      },
      {
        title: 'Keep less',
        body: 'Move the "storage" goal toward lean to keep posts for a shorter time, or add a retention rule for noisy post types.',
      },
      {
        title: 'Empty the recycle bin',
        body: 'Removed items stay recoverable for 30 days. Emptying it frees space right away.',
        actionId: 'moderation.recycle-bin',
        input: {},
      },
      {
        title: 'Add more space',
        body: 'If growth is healthy, give the server a bigger disk or move media to S3-compatible storage.',
      },
    ],
  },
  {
    id: 'slow-relay',
    title: 'Relay is slow or failing',
    steps: [
      {
        title: 'Look at the overview',
        body: 'Check the health score, error rate and response times to see which part is struggling.',
        actionId: 'insights.overview',
        input: {},
      },
      {
        title: 'Check the server',
        body: 'Is the server out of memory, CPU or disk? A restart often clears a stuck process. On Cloudflare, check your plan limits.',
      },
      {
        title: 'Look for unusual traffic',
        body: 'A flood of connections or requests can slow everything down. Tightening the rate limits for a while helps.',
        actionId: 'insights.series',
        input: { metric: 'req.served', hours: 6 },
      },
      {
        title: 'Check recent changes',
        body: 'If it started right after a settings change, restore the previous version from the config history.',
      },
    ],
  },
  {
    id: 'cert-problem',
    title: 'Certificate problem',
    steps: [
      {
        title: 'Check that your domain points here',
        body: 'Certificates renew automatically only if your domain name still points to this server. Check its DNS records.',
      },
      {
        title: 'Make sure port 80 and 443 are open',
        body: "The certificate authority must be able to reach this server to confirm it's yours.",
      },
      {
        title: 'Behind a proxy?',
        body: 'If a proxy or Cloudflare handles HTTPS for you, renew the certificate there instead.',
      },
      {
        title: 'Restart to retry',
        body: 'Restarting Beamhop tries renewal again right away. The alert clears once a fresh certificate is in place.',
      },
    ],
  },
];
