import { deleteDB, openDB } from 'idb'

const DB_VERSION = 1
const DB_PREFIX = 'mwalimu-ledger-v1-'

function databaseName(schoolId) {
  return `${DB_PREFIX}${String(schoolId).replace(/[^a-zA-Z0-9_-]/g, '_')}`
}

export function openSchoolStore(schoolId) {
  if (!schoolId) throw new Error('A school ID is required for offline storage.')

  return openDB(databaseName(schoolId), DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('snapshots')) db.createObjectStore('snapshots')
      if (!db.objectStoreNames.contains('syncQueue')) db.createObjectStore('syncQueue', { keyPath: 'operationId' })
      if (!db.objectStoreNames.contains('metadata')) db.createObjectStore('metadata')
    },
  })
}

export async function readSchoolSnapshot(schoolId) {
  const db = await openSchoolStore(schoolId)
  return db.get('snapshots', 'current')
}

export async function writeSchoolSnapshot(schoolId, snapshot) {
  const db = await openSchoolStore(schoolId)
  await db.put('snapshots', snapshot, 'current')
}

export async function persistSchoolMutation(schoolId, snapshot, operations) {
  const db = await openSchoolStore(schoolId)
  const transaction = db.transaction(['snapshots', 'syncQueue'], 'readwrite')
  await transaction.objectStore('snapshots').put(snapshot, 'current')
  for (const operation of operations) {
    transaction.objectStore('syncQueue').put({
      ...operation,
      status: 'pending',
      queuedAt: new Date().toISOString(),
      attempts: 0,
    })
  }
  await transaction.done
}

export async function queueSchoolOperations(schoolId, operations) {
  if (!operations.length) return
  const db = await openSchoolStore(schoolId)
  const transaction = db.transaction('syncQueue', 'readwrite')
  for (const operation of operations) {
    transaction.store.put({
      ...operation,
      status: 'pending',
      queuedAt: new Date().toISOString(),
      attempts: 0,
    })
  }
  await transaction.done
}

export async function readPendingOperations(schoolId, limit = 100) {
  const db = await openSchoolStore(schoolId)
  const operations = await db.getAll('syncQueue')
  return operations
    .filter((operation) => operation.status === 'pending')
    .sort((left, right) => left.queuedAt.localeCompare(right.queuedAt))
    .slice(0, limit)
}

export async function settleSchoolOperations(schoolId, results) {
  const db = await openSchoolStore(schoolId)
  const transaction = db.transaction('syncQueue', 'readwrite')
  for (const result of results) {
    const operation = await transaction.store.get(result.operation_id)
    if (!operation) continue
    if (result.status === 'accepted') {
      await transaction.store.delete(result.operation_id)
    } else {
      await transaction.store.put({
        ...operation,
        status: 'needs_attention',
        lastReason: result.reason ?? 'validation_failed',
        attempts: operation.attempts + 1,
      })
    }
  }
  await transaction.done
}

export async function readSchoolCursor(schoolId) {
  const db = await openSchoolStore(schoolId)
  return (await db.get('metadata', 'cursor')) ?? 0
}

export async function writeSchoolCursor(schoolId, cursor) {
  const db = await openSchoolStore(schoolId)
  await db.put('metadata', cursor, 'cursor')
}

export async function readSchoolQueueStatus(schoolId) {
  const db = await openSchoolStore(schoolId)
  const operations = await db.getAll('syncQueue')
  return {
    pending: operations.filter((operation) => operation.status === 'pending').length,
    needsAttention: operations.filter((operation) => operation.status === 'needs_attention').length,
  }
}

export async function removeSchoolOfflineData(schoolId) {
  if (!schoolId) return
  await deleteDB(databaseName(schoolId))
}
