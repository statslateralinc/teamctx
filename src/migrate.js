import { existsSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { readConfig, writeConfig, writeWorkstream, writeWorkstreamMd } from './storage.js';

export function migrateIfNeeded(teamctxDir) {
  const configPath = join(teamctxDir, 'config.json');
  if (!existsSync(configPath)) return false;

  const config = readConfig(teamctxDir);
  if (config.workstreamsMigrated) return false;

  const sharedPath = join(teamctxDir, 'shared.json');
  let workstream;
  if (existsSync(sharedPath)) {
    workstream = JSON.parse(readFileSync(sharedPath, 'utf-8'));
  } else {
    workstream = { id: 'main', name: config.project || '', whys: [] };
  }
  workstream.id = 'main';
  writeWorkstream('main', workstream, teamctxDir);

  const sharedMdPath = join(teamctxDir, 'context', 'shared.md');
  if (existsSync(sharedMdPath)) {
    writeWorkstreamMd('main', readFileSync(sharedMdPath, 'utf-8'), teamctxDir);
    unlinkSync(sharedMdPath);
  }

  const updated = {
    ...config,
    workstreams: [{ id: 'main', name: config.project || 'main', createdAt: new Date().toISOString() }],
    activeWorkstream: 'main',
    roles: (config.roles || []).map(r => ({ ...r, workstream: r.workstream || 'main' })),
    workstreamsMigrated: true,
  };
  writeConfig(updated, teamctxDir);

  if (existsSync(sharedPath)) unlinkSync(sharedPath);
  return true;
}
