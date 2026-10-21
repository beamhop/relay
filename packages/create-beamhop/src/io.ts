// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Side effects behind small interfaces so the setup flow can be tested with fakes:
 * running commands, reading/writing files, printing and asking questions.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  /** Written to the command's stdin (e.g. a secret value). Never printed. */
  input?: string;
  /** Hand the terminal to the command (e.g. `wrangler login` opens a browser). */
  interactive?: boolean;
  /** Show the command's output while also capturing it. */
  echo?: boolean;
}

export interface Runner {
  run(cmd: string[], opts?: RunOptions): Promise<RunResult>;
}

export interface Files {
  exists(path: string): boolean;
  read(path: string): string;
  write(path: string, content: string): void;
}

export interface Io {
  log(line?: string): void;
  /** Ask a question; empty answer returns `fallback` (or ''). */
  ask(question: string, fallback?: string): Promise<string>;
}

/** Real runner on Node/Bun via child_process. Missing programs return code 127. */
export const nodeRunner: Runner = {
  run(cmd, opts = {}) {
    const [bin, ...args] = cmd as [string, ...string[]];
    return new Promise((resolve) => {
      const child = spawn(bin, args, {
        cwd: opts.cwd,
        // npx/wrangler are .cmd shims on Windows
        shell: process.platform === 'win32',
        stdio: opts.interactive ? 'inherit' : ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d: Buffer) => {
        stdout += d.toString();
        if (opts.echo) process.stdout.write(d);
      });
      child.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString();
        if (opts.echo) process.stderr.write(d);
      });
      child.on('error', (err: NodeJS.ErrnoException) => {
        resolve({ code: err.code === 'ENOENT' ? 127 : 1, stdout, stderr: String(err.message) });
      });
      child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
      if (child.stdin) {
        if (opts.input !== undefined) child.stdin.write(opts.input);
        child.stdin.end();
      }
    });
  },
};

export const nodeFiles: Files = {
  exists: (p) => existsSync(p),
  read: (p) => readFileSync(p, 'utf8'),
  write(p, content) {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  },
};

export function terminalIo(): Io {
  return {
    log: (line = '') => console.log(line),
    async ask(question, fallback) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const hint = fallback ? ` (${fallback})` : '';
        const answer = (await rl.question(`? ${question}${hint} `)).trim();
        return answer || fallback || '';
      } finally {
        rl.close();
      }
    },
  };
}
