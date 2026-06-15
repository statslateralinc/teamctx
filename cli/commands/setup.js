import { existsSync } from 'fs';
import { execFile, spawnSync } from 'child_process';
import { promisify } from 'util';
import { ask } from '../prompt.js';
import { checkGitRepo } from '../../src/git.js';
import { initCommand } from './init.js';

const execFileAsync = promisify(execFile);

async function getGitRemoteUrl() {
  const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin']);
  return stdout.trim();
}

function parseGitHubUrl(url) {
  const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (!m) throw new Error(`Cannot parse GitHub URL: ${url}`);
  return { owner: m[1], repo: m[2] };
}

async function getCurrentBranch() {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
    return stdout.trim() || 'main';
  } catch {
    return 'main';
  }
}

function vercelInstalled() {
  const r = spawnSync('vercel', ['--version'], { stdio: 'pipe' });
  return r.status === 0;
}

function setVercelEnv(key, value) {
  const r = spawnSync('vercel', ['env', 'add', key, 'production'], {
    input: value + '\n',
    stdio: ['pipe', 'inherit', 'inherit'],
    encoding: 'utf-8',
  });
  if (r.status !== 0) throw new Error(`vercel env add ${key} failed`);
}

export async function setupCommand() {
  console.log('\nSetting up teamctx.');
  console.log('Step 1: create a private GitHub repo at github.com/new, clone it, and cd into it.');
  console.log('Once you\'ve done that, this command handles the rest.\n');

  await checkGitRepo();

  // Auto-detect repo from git remote
  let owner, repoName;
  try {
    const remoteUrl = await getGitRemoteUrl();
    ({ owner, repo: repoName } = parseGitHubUrl(remoteUrl));
    console.log(`Detected: ${owner}/${repoName}`);
  } catch {
    const manual = await ask('GitHub repo (e.g. myorg/my-repo)');
    if (!manual?.includes('/')) { console.error('Invalid repo.'); process.exit(1); }
    [owner, repoName] = manual.split('/');
  }

  const branch = await getCurrentBranch();
  const rawBase = `https://raw.githubusercontent.com/${owner}/${repoName}/${branch}`;

  // GitHub token
  console.log('\nYou need a GitHub personal access token with read+write access to this repo.');
  console.log('Create one at github.com/settings/tokens/new — check the "repo" scope.\n');
  const token = await ask('GitHub token');
  if (!token) { console.error('Token is required.'); process.exit(1); }

  // Verify token can access the repo
  process.stdout.write('→ Verifying access...');
  const verifyRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!verifyRes.ok) {
    console.error(`\nCannot access ${owner}/${repoName} with that token (HTTP ${verifyRes.status}).`);
    console.error('Make sure the token has "repo" scope and access to this repository.');
    process.exit(1);
  }
  console.log(' ok.\n');

  // teamctx init (skip if already done)
  if (existsSync('.teamctx')) {
    console.log('✓ teamctx already initialized in this repo.\n');
  } else {
    console.log('Initializing teamctx...');
    console.log(`When prompted for "GitHub raw base URL", enter:\n  ${rawBase}\n`);
    await initCommand();
  }

  // Connect to Vercel
  const envVars = {
    GITHUB_REPO: `${owner}/${repoName}`,
    GITHUB_RAW_BASE: rawBase,
    GITHUB_TOKEN: token,
  };

  if (vercelInstalled()) {
    const auto = await ask('Auto-set Vercel env vars? (y/n)', 'y');
    if (auto.toLowerCase() === 'y') {
      console.log();
      for (const [key, value] of Object.entries(envVars)) {
        process.stdout.write(`→ Setting ${key}... `);
        try {
          setVercelEnv(key, value);
          console.log('✓');
        } catch (err) {
          console.log(`failed: ${err.message}`);
        }
      }
      const deploy = await ask('\nDeploy to production now? (y/n)', 'y');
      if (deploy.toLowerCase() === 'y') {
        spawnSync('vercel', ['--prod'], { stdio: 'inherit' });
      }
      return;
    }
  }

  // Manual fallback
  console.log('\n──────────────────────────────────────────────────────');
  console.log('Set these env vars in your Vercel project, then deploy:');
  console.log('──────────────────────────────────────────────────────');
  for (const [key, value] of Object.entries(envVars)) {
    console.log(`  ${key.padEnd(18)} ${value}`);
  }
  console.log('──────────────────────────────────────────────────────');
  console.log('Then run: vercel --prod\n');
}
