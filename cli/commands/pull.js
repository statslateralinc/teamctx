import { readdir, readFile, unlink } from 'fs/promises';
import { join } from 'path';
import { ask } from '../prompt.js';
import { getTeamctxDir, readConfig } from '../../src/storage.js';
import { pullContext } from '../../src/git.js';
import { contributeCommand } from './contribute.js';

export async function pullCommand() {
  process.stdout.write('→ Syncing with remote...');
  try {
    await pullContext();
    console.log(' done.');
  } catch (err) {
    console.log(` ${err.message?.split('\n')[0] || 'failed'}`);
    console.log('Resolve any git conflicts before running teamctx pull.');
    process.exit(1);
  }

  const pendingDir = join(getTeamctxDir(), 'pending');

  let files = [];
  try {
    const entries = await readdir(pendingDir);
    files = entries.filter(f => f.endsWith('.json'));
  } catch {
    // pending dir doesn't exist — no submissions
  }

  if (files.length === 0) { console.log('No pending web contributions.'); return; }

  console.log(`\n${files.length} pending web contribution${files.length !== 1 ? 's' : ''}:\n`);

  let processed = 0;
  for (let i = 0; i < files.length; i++) {
    const filePath = join(pendingDir, files[i]);
    const item = JSON.parse(await readFile(filePath, 'utf-8'));

    console.log(`[${i + 1}/${files.length}] Author: ${item.author || 'anonymous'}`);
    console.log(`  "${item.text}"\n`);

    const answer = await ask('Apply? (y/n/skip-all)', 'y');

    if (answer.toLowerCase() === 'skip-all') { console.log('Skipping remaining.'); break; }

    if (answer.toLowerCase() === 'y') {
      const config = readConfig();
      const text = item.author && item.author !== config.me
        ? `[From ${item.author}] ${item.text}`
        : item.text;
      try {
        await unlink(filePath);
        await contributeCommand(text, { autoApprove: false, decision: false });
        processed++;
      } catch (err) {
        console.error(`  Error processing contribution: ${err.message}`);
        console.log('  Skipping.\n');
      }
    }
  }

  if (processed > 0) console.log(`\n✓ Processed ${processed} contribution${processed !== 1 ? 's' : ''}.`);
}
