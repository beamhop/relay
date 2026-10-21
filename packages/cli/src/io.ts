// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Terminal I/O behind a small interface so every command is testable:
 * output, colors (only on a TTY and when NO_COLOR is unset), prompts and
 * hidden secret input (never echoed).
 */

export type Env = Record<string, string | undefined>;

export interface Io {
  out(text: string): void;
  err(text: string): void;
  /** stdout is a terminal (colors, interactive confirmations). */
  readonly isTTY: boolean;
  /** stdin is a terminal (prompts possible). */
  readonly interactive: boolean;
  color: boolean;
  prompt(question: string, def?: string): Promise<string>;
  /** Read a secret without echoing it. */
  promptSecret(question: string): Promise<string>;
  /** Read all of stdin (for `--nsec-stdin`, `--from-file -`). */
  readStdin(): Promise<string>;
}

export function processIo(env: Env = process.env): Io {
  const isTTY = !!process.stdout.isTTY;
  const interactive = !!process.stdin.isTTY;
  const color = isTTY && !env.NO_COLOR && env.TERM !== 'dumb';
  const readLine = async (): Promise<string> => {
    const reader = Bun.stdin.stream().getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      while (!buf.includes('\n')) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
      }
    } finally {
      reader.releaseLock();
    }
    return buf.split('\n')[0]?.replace(/\r$/, '') ?? '';
  };
  return {
    out: (t) => process.stdout.write(t),
    err: (t) => process.stderr.write(t),
    isTTY,
    interactive,
    color,
    async prompt(question, def) {
      process.stderr.write(`${question}${def ? ` [${def}]` : ''}: `);
      const answer = (await readLine()).trim();
      return answer || def || '';
    },
    async promptSecret(question) {
      process.stderr.write(`${question}: `);
      const stdin = process.stdin;
      const raw = stdin.isTTY;
      if (raw) stdin.setRawMode(true);
      try {
        return await new Promise<string>((resolve, reject) => {
          let value = '';
          const onData = (chunk: Buffer) => {
            for (const ch of chunk.toString('utf8')) {
              if (ch === '\r' || ch === '\n') {
                stdin.off('data', onData);
                stdin.pause();
                process.stderr.write('\n');
                resolve(value);
                return;
              }
              if (ch === '\u0003') {
                stdin.off('data', onData);
                reject(new Error('cancelled'));
                return;
              }
              if (ch === '\u007f') value = value.slice(0, -1);
              else value += ch;
            }
          };
          stdin.on('data', onData);
          stdin.resume();
        });
      } finally {
        if (raw) stdin.setRawMode(false);
      }
    },
    readStdin: () => Bun.stdin.text(),
  };
}

/** In-memory Io for tests: captures output, answers prompts from a script. */
export class BufferIo implements Io {
  stdout = '';
  stderr = '';
  color = false;
  prompts: string[] = [];
  constructor(
    private answers: string[] = [],
    readonly interactive = false,
    readonly isTTY = false,
    private stdin = '',
  ) {}
  out(t: string) {
    this.stdout += t;
  }
  err(t: string) {
    this.stderr += t;
  }
  async prompt(question: string, def?: string) {
    this.prompts.push(question);
    const a = this.answers.shift();
    return a === undefined || a === '' ? (def ?? '') : a;
  }
  async promptSecret(question: string) {
    this.prompts.push(question);
    return this.answers.shift() ?? '';
  }
  async readStdin() {
    return this.stdin;
  }
}

const wrap = (open: number, close: number) => (on: boolean, s: string) =>
  on ? `\x1b[${open}m${s}\x1b[${close}m` : s;

export const style = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  cyan: wrap(36, 39),
};

/** Color helpers bound to an Io's color setting. */
export function paint(io: Io) {
  return {
    bold: (s: string) => style.bold(io.color, s),
    dim: (s: string) => style.dim(io.color, s),
    red: (s: string) => style.red(io.color, s),
    green: (s: string) => style.green(io.color, s),
    yellow: (s: string) => style.yellow(io.color, s),
    cyan: (s: string) => style.cyan(io.color, s),
  };
}

export function line(io: Io, text = ''): void {
  io.out(`${text}\n`);
}

/** Exit codes (documented in `beamhop --help`). */
export const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  /** A change was previewed but not applied (no --yes, not interactive). */
  notApplied: 3,
  /** doctor: warnings only. */
  warnings: 4,
} as const;

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = EXIT.error,
    readonly technical?: string,
  ) {
    super(message);
  }
}

export class UsageError extends CliError {
  constructor(message: string, technical?: string) {
    super(message, EXIT.usage, technical);
  }
}
