// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * DCO check (PLAN §17): every non-merge commit in a range must carry a
 * `Signed-off-by: Name <email>` trailer matching its author (what `git commit -s` adds).
 *
 *   bun scripts/ci/dco-check.ts origin/main..HEAD
 *   bun scripts/ci/dco-check.ts <base-sha>..<head-sha>      # CI, pull requests
 *
 * The author's email must match a sign-off email (case-insensitive). Bot commits
 * (`…[bot]@users.noreply.github.com`) are skipped.
 */

export interface Commit {
  sha: string;
  authorName: string;
  authorEmail: string;
  message: string;
}

export interface SignOff {
  name: string;
  email: string;
}

export interface DcoProblem {
  sha: string;
  subject: string;
  reason: string;
}

const FIELD = '\x1f';
const RECORD = '\x1e';

/** `git log` format that `parseLog` reads. */
export const LOG_FORMAT = `%H${FIELD}%an${FIELD}%ae${FIELD}%B${RECORD}`;

export function parseLog(raw: string): Commit[] {
  return raw
    .split(RECORD)
    .map((r) => r.replace(/^\s+/, ''))
    .filter((r) => r.length > 0)
    .map((r) => {
      const [sha = '', authorName = '', authorEmail = '', message = ''] = r.split(FIELD);
      return { sha: sha.trim(), authorName, authorEmail, message: message.trimEnd() };
    });
}

/** `Signed-off-by:` trailers in a commit message. */
export function signOffs(message: string): SignOff[] {
  const out: SignOff[] = [];
  for (const m of message.matchAll(/^Signed-off-by:\s*(.*?)\s*<([^>]+)>\s*$/gim)) {
    out.push({ name: (m[1] ?? '').trim(), email: (m[2] ?? '').trim() });
  }
  return out;
}

export function isBot(c: Commit): boolean {
  return /\[bot\]@users\.noreply\.github\.com$/i.test(c.authorEmail);
}

export function checkCommit(c: Commit): DcoProblem | null {
  const subject = c.message.split('\n')[0] ?? '';
  if (isBot(c)) return null;
  const offs = signOffs(c.message);
  if (offs.length === 0) {
    return { sha: c.sha, subject, reason: 'no Signed-off-by line' };
  }
  const email = c.authorEmail.toLowerCase();
  if (!offs.some((o) => o.email.toLowerCase() === email)) {
    const found = offs.map((o) => `${o.name} <${o.email}>`).join(', ');
    return {
      sha: c.sha,
      subject,
      reason: `Signed-off-by (${found}) does not match the author ${c.authorName} <${c.authorEmail}>`,
    };
  }
  return null;
}

export function checkCommits(commits: Commit[]): DcoProblem[] {
  return commits.map(checkCommit).filter((p): p is DcoProblem => p !== null);
}

async function gitLog(range: string): Promise<string> {
  const proc = Bun.spawn(['git', 'log', '--no-merges', `--format=${LOG_FORMAT}`, range], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git log ${range} failed: ${err.trim()}`);
  return out;
}

if (import.meta.main) {
  const range = process.argv[2];
  if (!range) {
    console.error('usage: bun scripts/ci/dco-check.ts <base>..<head>');
    process.exit(2);
  }
  let commits: Commit[];
  try {
    commits = parseLog(await gitLog(range));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
  const problems = checkCommits(commits);
  console.log(`DCO: checked ${commits.length} commit(s) in ${range}`);
  for (const p of problems) console.error(`  ${p.sha.slice(0, 12)} ${p.subject}\n    ${p.reason}`);
  if (problems.length > 0) {
    console.error(
      '\nEvery commit needs a sign-off (Developer Certificate of Origin, see CONTRIBUTING.md).\n' +
        'Fix the last commit with `git commit --amend -s --no-edit`, or all commits on the branch with\n' +
        '`git rebase --signoff <base>`, then force-push.',
    );
    process.exit(1);
  }
}
