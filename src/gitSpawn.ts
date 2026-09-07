import * as cp from 'node:child_process';

export class GitTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitTimeoutError';
  }
}

export type SpawnGitOptions = {
  cwd: string;
  // Kill the child and reject once this many milliseconds have passed.
  timeoutMs?: number;
  // Tests point this at another executable; production always runs git.
  command?: string;
};

/**
 * Runs git without a shell and returns all of stdout, however large. GitRunner.exec() caps
 * stdout at 10 MB, which `git log --numstat` over a whole history can exceed.
 */
export function spawnGit(args: string[], options: SpawnGitOptions): Promise<string> {
  const command = options.command ?? 'git';
  return new Promise((resolve, reject) => {
    const child = cp.spawn(command, args, { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, options.timeoutMs)
      : undefined;

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error) => {
      if (timer) {
        clearTimeout(timer);
      }
      reject(error);
    });
    child.on('close', (code) => {
      if (timer) {
        clearTimeout(timer);
      }
      if (timedOut) {
        reject(new GitTimeoutError(`${command} ${args[0] ?? ''} took longer than ${options.timeoutMs} ms`));
        return;
      }
      if (code !== 0) {
        reject(new Error(Buffer.concat(stderr).toString('utf8').trim() || `${command} exited with code ${code}`));
        return;
      }
      resolve(Buffer.concat(stdout).toString('utf8'));
    });
  });
}
