import { supabase } from './supabaseClient.js'
import {
  readPendingOperations,
  readSchoolCursor,
  removeSchoolOfflineData,
  settleSchoolOperations,
  writeSchoolCursor,
  writeSchoolSnapshot,
} from './offlineStore.js'

// push_sync_batch accepts at most 100 operations per call; imports produce many
// more, so pushes are sent in chunks. The operation ids stay stable, so a
// dropped connection followed by a retry replays results instead of duplicating.
const PUSH_CHUNK_SIZE = 100

function requireSupabase() {
  if (!supabase) throw new Error('Cloud sync is not configured.')
}

function parseTerm(label) {
  const match = label.match(/Term\s+(\d+)\s*,?\s*(\d{4})/i)
  if (!match) throw new Error('Term name must include its term number and year.')
  return { term_number: Number(match[1]), year: Number(match[2]) }
}

export async function loadCloudSnapshot(school) {
  requireSupabase()
  if (school.role === 'admin') {
    const { error: initError } = await supabase.rpc('initialize_school', {
      target_school_id: school.school_id,
    })
    if (initError) throw initError
  }

  const [classesResult, termsResult, feesResult, studentsResult, paymentsResult, chargesResult] = await Promise.all([
    supabase.from('classes').select('id, name, version').order('name'),
    supabase.from('terms').select('id, name, year, term_number, due_date, status, version').order('year').order('term_number'),
    supabase.from('fee_structures').select('id, term_id, class_id, amount, version'),
    supabase.from('students').select('id, admission_number, name, class_id, guardian_name, guardian_phone, status, enrolled_term_id, version'),
    supabase.from('payments').select('id, student_id, term_id, amount, method, mpesa_receipt, reference, paid_at, source, voided_at'),
    supabase.from('student_charges').select('id, student_id, term_id, amount, type, source_key').like('source_key', 'import:opening:%'),
  ])

  for (const result of [classesResult, termsResult, feesResult, studentsResult, paymentsResult, chargesResult]) {
    if (result.error) throw result.error
  }

  const classes = classesResult.data ?? []
  const classById = new Map(classes.map((schoolClass) => [schoolClass.id, schoolClass]))
  const terms = (termsResult.data ?? []).map((term) => ({
    id: term.id,
    label: term.name,
    year: term.year,
    termNumber: term.term_number,
    dueDate: term.due_date,
    status: term.status,
    version: term.version,
    fees: {},
  }))
  const termById = new Map(terms.map((term) => [term.id, term]))

  for (const fee of feesResult.data ?? []) {
    const term = termById.get(fee.term_id)
    const schoolClass = classById.get(fee.class_id)
    if (term && schoolClass) term.fees[schoolClass.name] = Number(fee.amount)
  }

  return {
    schoolId: school.school_id,
    schoolName: school.name,
    classes,
    charges: (chargesResult.data ?? []).map((charge) => ({
      id: charge.id,
      studentId: charge.student_id,
      termId: charge.term_id,
      amount: Number(charge.amount),
      type: charge.type,
      sourceKey: charge.source_key,
    })),
    terms,
    students: (studentsResult.data ?? []).map((student) => ({
      id: student.id,
      admissionNumber: student.admission_number,
      name: student.name,
      grade: classById.get(student.class_id)?.name ?? 'Unassigned',
      classId: student.class_id,
      guardianName: student.guardian_name,
      phone: student.guardian_phone,
      status: student.status,
      startTermId: student.enrolled_term_id,
      version: student.version,
    })),
    payments: (paymentsResult.data ?? []).filter((payment) => !payment.voided_at).map((payment) => ({
      id: payment.id,
      studentId: payment.student_id,
      termId: payment.term_id,
      amount: Number(payment.amount),
      method: payment.method === 'mpesa' ? 'M-Pesa' : payment.method === 'bank' ? 'Bank' : 'Cash',
      code: payment.mpesa_receipt ?? '',
      reference: payment.reference ?? '',
      date: payment.paid_at.slice(0, 10),
      source: payment.source,
    })),
  }
}

function applyChange(snapshot, event) {
  const record = event.record
  if (event.entity === 'classes') {
    const classes = snapshot.classes ?? []
    const nextClasses = [...classes.filter((item) => item.id !== record.id), record]
    return { ...snapshot, classes: nextClasses }
  }

  if (event.entity === 'terms') {
    const existing = snapshot.terms.find((term) => term.id === record.id)
    const term = {
      ...existing,
      id: record.id,
      label: record.name,
      year: record.year,
      termNumber: record.term_number,
      dueDate: record.due_date,
      status: record.status,
      version: record.version,
      fees: existing?.fees ?? {},
    }
    return { ...snapshot, terms: [...snapshot.terms.filter((item) => item.id !== term.id), term] }
  }

  if (event.entity === 'fee_structures') {
    const schoolClass = snapshot.classes.find((item) => item.id === record.class_id)
    if (!schoolClass) return snapshot
    return {
      ...snapshot,
      terms: snapshot.terms.map((term) => term.id === record.term_id
        ? { ...term, fees: { ...term.fees, [schoolClass.name]: Number(record.amount) } }
        : term),
    }
  }

  if (event.entity === 'students') {
    const schoolClass = snapshot.classes.find((item) => item.id === record.class_id)
    const student = {
      id: record.id,
      admissionNumber: record.admission_number,
      name: record.name,
      grade: schoolClass?.name ?? 'Unassigned',
      classId: record.class_id,
      guardianName: record.guardian_name,
      phone: record.guardian_phone,
      status: record.status,
      startTermId: record.enrolled_term_id,
      version: record.version,
    }
    return { ...snapshot, students: [...snapshot.students.filter((item) => item.id !== student.id), student] }
  }

  if (event.entity === 'student_charges') {
    // Only imported opening balances live in the client snapshot; rollover
    // adjustments are part of the server's authoritative balance model.
    if (!String(record.source_key ?? '').startsWith('import:opening:')) return snapshot
    const charge = {
      id: record.id,
      studentId: record.student_id,
      termId: record.term_id,
      amount: Number(record.amount),
      type: record.type,
      sourceKey: record.source_key,
    }
    return { ...snapshot, charges: [...(snapshot.charges ?? []).filter((item) => item.id !== charge.id), charge] }
  }

  if (event.entity === 'payments') {
    if (record.voided_at) return { ...snapshot, payments: snapshot.payments.filter((item) => item.id !== record.id) }
    const payment = {
      id: record.id,
      studentId: record.student_id,
      termId: record.term_id,
      amount: Number(record.amount),
      method: record.method === 'mpesa' ? 'M-Pesa' : record.method === 'bank' ? 'Bank' : 'Cash',
      code: record.mpesa_receipt ?? '',
      reference: record.reference ?? '',
      date: record.paid_at.slice(0, 10),
      source: record.source,
    }
    return { ...snapshot, payments: [...snapshot.payments.filter((item) => item.id !== payment.id), payment] }
  }

  return snapshot
}

export async function syncSchool(schoolId, currentSnapshot) {
  requireSupabase()
  if (!navigator.onLine) return { snapshot: currentSnapshot, state: 'offline' }

  let snapshot = currentSnapshot
  const pending = await readPendingOperations(schoolId)
  let state = 'synced'
  for (let offset = 0; offset < pending.length; offset += PUSH_CHUNK_SIZE) {
    const chunk = pending.slice(offset, offset + PUSH_CHUNK_SIZE)
    const { data: results, error } = await supabase.rpc('push_sync_batch', {
      target_school_id: schoolId,
      operations: chunk.map(({ operationId, kind, data }) => ({ operation_id: operationId, kind, data })),
    })
    if (error) return { snapshot, state: 'needs_attention', reason: error.message }
    await settleSchoolOperations(schoolId, results ?? [])
    if ((results ?? []).some((result) => result.status === 'rejected')) state = 'needs_attention'
  }

  let cursor = await readSchoolCursor(schoolId)
  let pages = 0
  while (pages < 20) {
    const { data, error } = await supabase.rpc('pull_school_changes', {
      target_school_id: schoolId,
      after_cursor: cursor,
      batch_size: 500,
    })
    if (error) return { snapshot, state: 'needs_attention', reason: error.message }
    const changes = data.changes ?? []
    if (!changes.length) break
    for (const change of changes) snapshot = applyChange(snapshot, change)
    cursor = data.cursor
    await writeSchoolCursor(schoolId, cursor)
    pages += 1
    if (!data.has_more) break
  }

  await writeSchoolSnapshot(schoolId, snapshot)
  return { snapshot, state }
}

export function buildStudentOperation(student, classes, importBatchId) {
  const schoolClass = classes.find((item) => item.name === student.grade)
  return {
    kind: 'student.upsert',
    data: {
      id: student.id,
      admission_number: student.admissionNumber,
      name: student.name,
      class_id: student.classId ?? schoolClass?.id,
      guardian_name: student.guardianName,
      guardian_phone: student.phone,
      status: student.status ?? 'active',
      enrolled_term_id: student.startTermId,
      ...(importBatchId ? { import_batch_id: importBatchId } : {}),
    },
  }
}

export function buildPaymentOperation(payment, importBatchId) {
  return {
    kind: 'payment.create',
    data: {
      id: payment.id,
      student_id: payment.studentId,
      term_id: payment.termId,
      amount: payment.amount,
      method: payment.method === 'M-Pesa' ? 'mpesa' : payment.method.toLowerCase(),
      mpesa_receipt: payment.code,
      reference: payment.reference ?? '',
      paid_at: `${payment.date}T12:00:00.000Z`,
      ...(payment.source === 'import' ? { source: 'import' } : {}),
      ...(importBatchId ? { import_batch_id: importBatchId } : {}),
    },
  }
}

export function buildChargeOperation(charge, importBatchId) {
  return {
    kind: 'charge.create',
    data: {
      id: charge.id,
      student_id: charge.studentId,
      term_id: charge.termId,
      amount: charge.amount,
      source_key: charge.sourceKey,
      ...(importBatchId ? { import_batch_id: importBatchId } : {}),
    },
  }
}

// After an undo the server has deleted records; incremental sync cannot carry
// deletes, so the local snapshot is rebuilt from the cloud instead.
export async function reloadSnapshotAfterUndo(school) {
  requireSupabase()
  await removeSchoolOfflineData(school.school_id)
  const snapshot = await loadCloudSnapshot(school)
  await writeSchoolSnapshot(school.school_id, snapshot)
  return snapshot
}

export function buildTermOperations(term, classes) {
  const { year, term_number: termNumber } = parseTerm(term.label)
  const termOperation = {
    kind: 'term.upsert',
    data: {
      id: term.id,
      year,
      term_number: termNumber,
      name: term.label,
      due_date: term.dueDate,
      status: 'open',
    },
  }
  const feeOperations = classes.map((schoolClass) => ({
    kind: 'fee_structure.upsert',
    data: {
      term_id: term.id,
      class_id: schoolClass.id,
      amount: Number(term.fees[schoolClass.name] ?? 0),
    },
  }))
  return [termOperation, ...feeOperations, { kind: 'term.rollover', data: { term_id: term.id } }]
}
