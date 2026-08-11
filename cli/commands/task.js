import { createHash } from 'crypto';
import {
  readConfig, listTasks, readTask, writeTask, deleteTask,
  listWorkstreamIds, readWorkstream, readContributions,
  writeTaskFile, taskFilePath, taskFileExists,
} from '../../src/storage.js';
import { compileTaskPrompt } from '../../src/context.js';
import { commitContext, pushContext } from '../../src/git.js';
import { currentIdentity } from '../identity.js';

function whysHash(workstream) {
  const material = JSON.stringify({
    name: workstream?.name || '',
    whys: workstream?.whys || [],
  });
  return createHash('sha1').update(material).digest('hex').slice(0, 16);
}

function slugify(title) {
  const base = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!base) throw new Error('title must contain at least one alphanumeric character');
  return `t-${base}`.slice(0, 60);
}

function uniqueTaskId(base, dir) {
  const existing = new Set(listTasks({}, dir).map(t => t.id));
  if (!existing.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error('could not generate a unique task id');
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

async function resolveTargetWorkstream(config, requested) {
  const targetId = requested || (await currentIdentity(config)).activeWorkstream;
  const known = new Set((config.workstreams || []).map(w => w.id));
  if (known.size > 0 && !known.has(targetId)) {
    console.error(`Error: no workstream "${targetId}". Run \`teamctx workstream list\`.`);
    process.exit(1);
  }
  return targetId;
}

function resolveTaskOrExit(idOrPrefix) {
  try {
    return readTask(idOrPrefix);
  } catch (err) {
    console.error(`Error: ${err.message}. Run \`teamctx task list --all\` to see tasks.`);
    process.exit(1);
  }
}

async function commitAndPush(config, msg, successLine) {
  await commitContext(msg);
  if (config.autoPush) {
    try {
      await pushContext();
      console.log(`\n${successLine} — committed and pushed.\n`);
    } catch (err) {
      const detail = err.message?.split('\n')[0] || err.stderr?.trim() || 'no remote?';
      console.log(`\n${successLine} — committed. Push failed (${detail}) — run \`git push\` manually.\n`);
    }
  } else {
    console.log(`\n${successLine} — committed. Run \`git push\` to share with your team.\n`);
  }
}

export async function taskAddCommand(title, opts = {}) {
  const config = readConfig();
  const workstream = await resolveTargetWorkstream(config, opts.workstream);
  const base = slugify(title);
  const id = uniqueTaskId(base, undefined);
  const task = {
    id,
    title: String(title),
    owner: opts.owner || (await currentIdentity(config)).me,
    status: 'open',
    workstream,
    createdAt: todayIso(),
    doneAt: null,
    compiledAt: null,
  };
  writeTask(task);
  const wsLabel = workstream === 'main' ? '' : ` [workstream: ${workstream}]`;
  await commitAndPush(config, `task: add ${id} by ${(await currentIdentity(config)).me}${wsLabel}`,
    `✓ Task ${id} added${wsLabel}`);
  console.log(`  Owner: ${task.owner}`);
  console.log(`  Compile a prompt for it with: teamctx task compile ${id}`);
}

export async function taskListCommand(opts = {}) {
  const config = readConfig();
  const scope = opts.all ? {} : { workstream: (await currentIdentity(config)).activeWorkstream };
  let tasks = listTasks(scope);
  if (opts.status) tasks = tasks.filter(t => t.status === opts.status);
  if (opts.owner) tasks = tasks.filter(t => t.owner === opts.owner);
  if (opts.workstream) tasks = tasks.filter(t => t.workstream === opts.workstream);
  if (!opts.status && !opts.all) tasks = tasks.filter(t => t.status === 'open');

  if (tasks.length === 0) {
    console.log('\nNo tasks match. Try `teamctx task list --all`.\n');
    return;
  }

  tasks.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  const header = ['ID', 'Status', 'Owner', 'Workstream', 'Compiled', 'Title'];
  const rows = tasks.map(t => [
    t.id,
    t.status || '-',
    t.owner || '-',
    t.workstream || '-',
    t.compiledAt ? 'yes' : '-',
    (t.title || '').slice(0, 60),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
  const fmt = cells => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  const label = opts.all ? 'all workstreams' : `workstream ${scope.workstream}`;
  console.log(`\n${tasks.length} task${tasks.length !== 1 ? 's' : ''} (${label}):\n`);
  console.log(fmt(header));
  console.log(widths.map(w => '-'.repeat(w)).join('  '));
  rows.forEach(r => console.log(fmt(r)));
  console.log('');
}

export async function taskShowCommand(idOrPrefix) {
  const { task, workstream } = resolveTaskOrExit(idOrPrefix);
  console.log(`\n# Task ${task.id}`);
  console.log(`  Title:      ${task.title}`);
  console.log(`  Owner:      ${task.owner || '-'}`);
  console.log(`  Status:     ${task.status}`);
  console.log(`  Workstream: ${workstream}`);
  console.log(`  Created:    ${task.createdAt || '-'}`);
  if (task.doneAt) console.log(`  Done at:    ${task.doneAt}`);
  console.log(`  Compiled:   ${task.compiledAt ? task.compiledAt : 'not yet — run `teamctx task compile ' + task.id + '`'}`);
  console.log('');
}

export async function taskDoneCommand(idOrPrefix) {
  const config = readConfig();
  const { task } = resolveTaskOrExit(idOrPrefix);
  if (task.status === 'done') {
    console.log(`\nTask ${task.id} is already done.\n`);
    return;
  }
  writeTask({ ...task, status: 'done', doneAt: todayIso() });
  await commitAndPush(config, `task: done ${task.id} by ${(await currentIdentity(config)).me}`,
    `✓ Task ${task.id} marked done`);
}

export async function taskReopenCommand(idOrPrefix) {
  const config = readConfig();
  const { task } = resolveTaskOrExit(idOrPrefix);
  if (task.status === 'open') {
    console.log(`\nTask ${task.id} is already open.\n`);
    return;
  }
  writeTask({ ...task, status: 'open', doneAt: null });
  await commitAndPush(config, `task: reopen ${task.id} by ${(await currentIdentity(config)).me}`,
    `✓ Task ${task.id} reopened`);
}

export async function taskAssignCommand(idOrPrefix, opts = {}) {
  if (!opts.owner) {
    console.error('Error: --owner <name> is required.');
    process.exit(1);
  }
  const config = readConfig();
  const { task } = resolveTaskOrExit(idOrPrefix);
  writeTask({ ...task, owner: opts.owner });
  await commitAndPush(config, `task: assign ${task.id} to ${opts.owner}`,
    `✓ Task ${task.id} assigned to ${opts.owner}`);
}

export async function taskRmCommand(idOrPrefix) {
  const config = readConfig();
  const { id, workstream } = deleteTask(idOrPrefix);
  await commitAndPush(config, `task: rm ${id} by ${(await currentIdentity(config)).me}`,
    `✓ Task ${id} removed (workstream: ${workstream})`);
}

export async function taskCompileCommand(idOrPrefix, opts = {}) {
  const config = readConfig();
  const { task } = resolveTaskOrExit(idOrPrefix);
  const wsId = task.workstream || 'main';
  const workstream = readWorkstream(wsId);
  const currentHash = whysHash(workstream);

  if (!opts.force && taskFileExists(task.id) && task.compiledFromHash === currentHash) {
    console.log(`\n✓ Task ${task.id} already compiled (workstream Whys unchanged since ${task.compiledAt}).`);
    console.log(`  Prompt file: ${taskFilePath(task.id)}`);
    console.log(`  Re-run with --force to regenerate.\n`);
    return;
  }

  const contributions = readContributions();
  let role = null;
  if (opts.role) {
    role = (config.roles || []).find(r => r.slug === opts.role);
    if (!role) {
      console.error(`Error: no role "${opts.role}". Run \`teamctx role list\`.`);
      process.exit(1);
    }
  }

  console.log(`\n→ Compiling prompt for task ${task.id}${opts.role ? ` (role: ${opts.role})` : ''}...`);
  const markdown = await compileTaskPrompt({ task, workstream, role, contributions, config });
  writeTaskFile(task.id, markdown);
  writeTask({ ...task, compiledAt: new Date().toISOString(), compiledFromHash: currentHash });

  const roleTag = opts.role ? ` (role: ${opts.role})` : '';
  await commitAndPush(config, `task: compile ${task.id} by ${(await currentIdentity(config)).me}${roleTag}`,
    `✓ Task prompt compiled for ${task.id}${roleTag}`);
  console.log(`  Prompt file: ${taskFilePath(task.id)}`);
  console.log(`  Copy that file's contents into your AI (ChatGPT, Claude, Cursor, ...).\n`);
}

export { slugify, uniqueTaskId };
