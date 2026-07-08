import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export async function checkGitRepo() {
  try {
    await execFileAsync('git', ['rev-parse', '--git-dir']);
  } catch {
    throw new Error('teamctx must be run inside a git repository. Run `git init` first.');
  }
}

export async function commitContext(message, { cwd } = {}) {
  const opts = cwd ? { cwd } : undefined;
  await execFileAsync('git', ['add', '.teamctx/'], opts);
  try {
    await execFileAsync('git', ['commit', '-m', message], opts);
  } catch (err) {
    if (!String(err.stdout || '').includes('nothing to commit')) throw err;
  }
}

export async function pushContext({ cwd } = {}) {
  await execFileAsync('git', ['push'], cwd ? { cwd } : undefined);
}

export async function pullContext({ cwd } = {}) {
  await execFileAsync('git', ['pull', '--no-rebase'], cwd ? { cwd } : undefined);
}
