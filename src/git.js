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

export async function commitContext(message) {
  await execFileAsync('git', ['add', '.teamctx/']);
  try {
    await execFileAsync('git', ['commit', '-m', message]);
  } catch (err) {
    if (!String(err.stdout || '').includes('nothing to commit')) throw err;
  }
}

export async function pushContext() {
  await execFileAsync('git', ['push']);
}

export async function pullContext() {
  await execFileAsync('git', ['pull', '--no-rebase']);
}
