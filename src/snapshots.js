export function newSnapshotId() {
  return `snap-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function buildSnapshot({ workstream, author, message }) {
  return {
    id: newSnapshotId(),
    createdAt: new Date().toISOString(),
    createdBy: author,
    message: message || null,
    status: 'pending',
    shared: workstream,
    approvedAt: null,
    approvedBy: null,
    rejectedAt: null,
    rejectedBy: null,
    reason: null,
  };
}

export function buildApproved(snapshot, approvedBy) {
  return {
    ...snapshot,
    status: 'approved',
    approvedAt: new Date().toISOString(),
    approvedBy,
  };
}

export function buildRejected(snapshot, rejectedBy, reason) {
  return {
    ...snapshot,
    status: 'rejected',
    rejectedAt: new Date().toISOString(),
    rejectedBy,
    reason: reason || null,
  };
}

export function buildPointer(approvedSnapshot) {
  return {
    id: approvedSnapshot.id,
    approvedAt: approvedSnapshot.approvedAt,
    approvedBy: approvedSnapshot.approvedBy,
    message: approvedSnapshot.message,
  };
}
