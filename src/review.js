import { applyOps } from './ops.js';

export function applyQueueItem(workstream, item) {
  return applyOps(workstream, item.operations || [], item.id);
}

export function buildRejected(item, rejectedBy, reason) {
  return {
    ...item,
    status: 'rejected',
    rejectedAt: new Date().toISOString(),
    rejectedBy,
    reason: reason || null,
  };
}

export function canApprove(config) {
  if (!config.manager) return true;
  return config.me === config.manager;
}
