import { importDocuments } from './import.core.js';
import { ImportPathError } from '../../src/import.js';
import { UnknownConnectorError, ConnectorAuthError, listConnectors } from '../../src/connectors/index.js';
import { UnknownWorkstreamError } from './role.core.js';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export async function importCommand(paths, opts = {}) {
  let result;
  try {
    result = await importDocuments({
      paths,
      from: opts.from,
      since: opts.since,
      workstreamId: opts.workstream,
      dryRun: !!opts.dryRun,
      // Reported before any distilling starts — on a large import the AI calls
      // take minutes, and "3 of your 12 files were skipped" is not news that
      // should wait until the end.
      onScanned: ({ skipped }) => {
        if (skipped.length === 0) return;
        console.log(`\nSkipped ${plural(skipped.length, 'file')}:`);
        skipped.forEach(s => console.log(`  ${s.id} — ${s.reason}`));
      },
      onProgress: ({ index, total, document }) => {
        process.stdout.write(`\r  distilling [${index + 1}/${total}] ${document.id}`.padEnd(72));
      },
    });
  } catch (err) {
    if (err instanceof UnknownConnectorError) {
      // The message already names them; the table adds what each one is for.
      console.error(`\nError: ${err.message}\n`);
      listConnectors().forEach(c => console.error(`  ${c.name.padEnd(10)} ${c.describe}`));
      console.error('');
      process.exit(1);
    }
    if (err instanceof ImportPathError
      || err instanceof ConnectorAuthError
      || err instanceof UnknownWorkstreamError) {
      console.error(`\nError: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const { documents, results, failures, dryRun } = result;

  if (documents.length === 0) {
    console.log('\nNothing to import.\n');
    return;
  }

  if (dryRun) {
    console.log(`\n${plural(documents.length, 'document')} would be imported:\n`);
    documents.forEach(d => console.log(`  ${d.id.padEnd(44)} ${d.title} (${Math.max(1, Math.round(d.bytes / 1024))}KB)`));
    console.log('\nThis was a dry-run. Drop --dry-run to distill these and send them for review.\n');
    return;
  }

  console.log(`\r${' '.repeat(72)}\r`);
  results.forEach(r => {
    const ops = r.mode === 'no-op'
      ? 'no changes proposed'
      : plural(r.operations.length, 'op');
    console.log(`  ✓ ${r.id} — ${ops}`);
    if (r.summary && r.mode !== 'no-op') console.log(`      ${r.summary}`);
  });

  failures.forEach(f => console.log(`  ✗ ${f.id} — ${f.error}`));

  const queuedCount = results.filter(r => r.mode === 'queued').length;
  console.log(`\n✓ ${plural(queuedCount, 'contribution')} queued for review from ${plural(documents.length, 'document')}.`);
  if (queuedCount > 0) console.log('  Review with `teamctx review list`, then `teamctx review approve <id>`.');
  if (failures.length > 0) {
    console.log(`\n${plural(failures.length, 'document')} failed — rerun import on just those paths to retry.`);
    process.exitCode = 1;
  }
  console.log();
}
