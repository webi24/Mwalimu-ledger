import {
  cleanAdmission,
  cleanName,
  normalizeClassName,
  normalizePhone,
  normalizeStatus,
  parseAmount,
  parseDate,
  normalizeMethod,
} from './normalize.js'

// Terms may appear in files as "Term 2, 2026", "2026-t2", "term 2 2026" or a term id.
export function matchTerm(text, terms) {
  const raw = String(text ?? '').trim()
  if (!raw) return null
  const byId = terms.find((term) => term.id === raw)
  if (byId) return byId
  const compact = raw.toLowerCase().replace(/[\s,]+/g, ' ').trim()
  const longForm = compact.match(/^term\s*(\d)\s*(\d{4})$/)
  const shortForm = compact.match(/^(\d{4})[-\s]*t(\d)$/)
  for (const term of terms) {
    const label = String(term.label ?? '').toLowerCase().replace(/[\s,]+/g, ' ').trim()
    if (label === compact) return term
    if (longForm && term.termNumber === Number(longForm[1]) && term.year === Number(longForm[2])) return term
    if (shortForm && term.termNumber === Number(shortForm[2]) && term.year === Number(shortForm[1])) return term
    if (term.id && term.id.toLowerCase() === compact) return term
  }
  return null
}

export function findExistingClass(name, classes) {
  const clean = normalizeClassName(name).toLowerCase()
  if (!clean) return null
  return classes.find((schoolClass) => schoolClass.name.toLowerCase() === clean) ?? null
}

// Collect class names in the file that the school does not have yet, before the
// user decides between creating them or mapping them onto existing classes.
export function detectUnknownClasses(rows, classIndex, classes) {
  const unknown = new Map()
  for (const row of rows) {
    const raw = normalizeClassName(row.cells[classIndex] ?? '')
    if (!raw) continue
    if (findExistingClass(raw, classes)) continue
    unknown.set(raw.toLowerCase(), raw)
  }
  return [...unknown.values()]
}

export const OPENING_KEY_PREFIX = 'import:opening:'

export function openingChargeKey(batchId, admissionNumber) {
  return `${OPENING_KEY_PREFIX}${batchId}:${String(admissionNumber).toLowerCase()}`
}

export function openingDeltaKey(batchId, admissionNumber) {
  return `${OPENING_KEY_PREFIX}${batchId}:delta:${String(admissionNumber).toLowerCase()}`
}

// Sum every imported opening charge (including later deltas) for a student.
function appliedOpeningBalance(charges, studentId) {
  return (charges ?? [])
    .filter((charge) => charge.studentId === studentId && String(charge.sourceKey ?? '').startsWith(OPENING_KEY_PREFIX))
    .reduce((total, charge) => total + Number(charge.amount ?? 0), 0)
}

// Build the full preview plan for a students file. Nothing here mutates the
// snapshot; the wizard shows the plan and only commits it on confirm.
export function buildStudentPlan({ rows, mapping, snapshot, options, generateId }) {
  const { termId, classPlan = {}, missingAction = 'nothing', batchId } = options
  const classes = snapshot.classes ?? []
  const studentsByAdmission = new Map(
    (snapshot.students ?? []).map((student) => [String(student.admissionNumber).toLowerCase(), student]),
  )

  const plan = {
    toCreate: [],
    toUpdate: [],
    unchanged: [],
    errors: [],
    openingCharges: [],
    classesToCreate: [],
    missingStudents: [],
    balanceDifferences: [],
  }
  const seenAdmissions = new Map()

  for (const row of rows) {
    const at = (key) => (mapping[key] === undefined ? '' : row.cells[mapping[key]])
    const admission = cleanAdmission(at('admissionNumber'))
    const fail = (reason) => plan.errors.push({ rowNumber: row.rowNumber, admissionNumber: admission, reason })

    if (!admission) { fail('Admission number is missing'); continue }
    const previousRow = seenAdmissions.get(admission.toLowerCase())
    if (previousRow) {
      fail(`Duplicate admission number ${admission} (first seen on row ${previousRow})`)
      continue
    }
    seenAdmissions.set(admission.toLowerCase(), row.rowNumber)

    const name = cleanName(at('studentName'))
    if (!name) { fail('Student name is missing'); continue }

    const rawClass = normalizeClassName(at('class'))
    if (!rawClass) { fail('Class is missing'); continue }
    let schoolClass = findExistingClass(rawClass, classes)
    if (!schoolClass) {
      const resolution = classPlan[rawClass.toLowerCase()]
      if (resolution?.action === 'existing') schoolClass = findExistingClass(resolution.target, classes)
      else if (resolution?.action === 'create') {
        if (!plan.classesToCreate.includes(resolution.target ?? rawClass)) plan.classesToCreate.push(resolution.target ?? rawClass)
      }
      if (!schoolClass && resolution?.action !== 'create') { fail(`Class "${rawClass}" not found`); continue }
    }
    const gradeName = schoolClass?.name ?? (classPlan[rawClass.toLowerCase()]?.target ?? rawClass)

    const phone = normalizePhone(at('guardianPhone'))
    if (phone.error) { fail(phone.error); continue }

    const status = normalizeStatus(at('status'))
    if (status.error) { fail(status.error); continue }

    const opening = parseAmount(at('openingBalance'))
    if (opening.error && at('openingBalance') !== '') { fail(opening.error); continue }
    const openingAmount = opening.value ?? 0

    const guardianName = cleanName(at('guardianName'))
    if (!guardianName) { fail('Parent or guardian name is missing'); continue }

    const existing = studentsByAdmission.get(admission.toLowerCase())
    if (!existing) {
      const draft = {
        id: generateId(),
        admissionNumber: admission,
        name,
        grade: gradeName,
        classId: schoolClass?.id ?? null,
        guardianName,
        phone: phone.value,
        status: status.value,
        startTermId: termId,
      }
      plan.toCreate.push({ draft, rowNumber: row.rowNumber })
      if (openingAmount > 0) {
        plan.openingCharges.push({
          draftIndex: plan.toCreate.length - 1,
          studentId: null,
          admissionNumber: admission,
          amount: openingAmount,
          termId,
          sourceKey: openingChargeKey(batchId, admission),
        })
      }
      continue
    }

    const changes = {}
    if (existing.name !== name) changes.name = { before: existing.name, after: name }
    if (gradeName && existing.grade !== gradeName) changes.grade = { before: existing.grade, after: gradeName }
    if (existing.guardianName !== guardianName) changes.guardianName = { before: existing.guardianName, after: guardianName }
    if (existing.phone !== phone.value) changes.phone = { before: existing.phone, after: phone.value }
    if (existing.status !== status.value) changes.status = { before: existing.status, after: status.value }

    if (Object.keys(changes).length) {
      plan.toUpdate.push({ student: existing, changes, rowNumber: row.rowNumber })
    } else {
      plan.unchanged.push({ student: existing, rowNumber: row.rowNumber })
    }

    if (openingAmount > 0) {
      const applied = appliedOpeningBalance(snapshot.charges, existing.id)
      if (applied === 0) {
        plan.openingCharges.push({
          draftIndex: null,
          studentId: existing.id,
          admissionNumber: admission,
          amount: openingAmount,
          termId: existing.startTermId ?? termId,
          sourceKey: openingChargeKey(batchId, admission),
        })
      } else if (Math.abs(applied - openingAmount) > 0.001) {
        plan.balanceDifferences.push({
          student: existing,
          admissionNumber: admission,
          applied,
          incoming: openingAmount,
          rowNumber: row.rowNumber,
        })
      }
    }
  }

  // Students the school has that this file does not mention. Never deleted or
  // deactivated automatically — the user chooses.
  const fileAdmissions = new Set([...seenAdmissions.keys()])
  plan.missingStudents = (snapshot.students ?? []).filter((student) => !fileAdmissions.has(String(student.admissionNumber).toLowerCase()))
  if (missingAction === 'markLeft') {
    for (const student of plan.missingStudents) {
      if (student.status !== 'active') continue
      const queued = plan.toUpdate.find((update) => update.student.id === student.id)
      if (queued) queued.changes.status = { before: student.status, after: 'inactive' }
      else plan.toUpdate.push({ student, changes: { status: { before: student.status, after: 'inactive' } }, rowNumber: null, fromMissing: true })
    }
  }

  return plan
}

function paymentMatchesExisting(payment, { studentId, date, amount, reference }) {
  const incomingReceipt = String(reference ?? '').toLowerCase()
  const existingReceipts = [String(payment.code ?? '').toLowerCase(), String(payment.reference ?? '').toLowerCase()]
  if (incomingReceipt && existingReceipts.includes(incomingReceipt)) return true
  return payment.studentId === studentId
    && payment.date === date
    && Number(payment.amount) === Number(amount)
    && String(payment.reference ?? '').toLowerCase() === incomingReceipt
    && incomingReceipt !== ''
}

export function buildPaymentPlan({ rows, mapping, snapshot, options }) {
  const { fallbackTermId } = options
  const terms = snapshot.terms ?? []
  const studentsByAdmission = new Map(
    (snapshot.students ?? []).map((student) => [String(student.admissionNumber).toLowerCase(), student]),
  )

  const plan = { toCreate: [], errors: [], duplicates: [] }

  for (const row of rows) {
    const at = (key) => (mapping[key] === undefined ? '' : row.cells[mapping[key]])
    const admission = cleanAdmission(at('admissionNumber'))
    const fail = (reason) => plan.errors.push({ rowNumber: row.rowNumber, admissionNumber: admission, reason })

    if (!admission) { fail('Admission number is missing'); continue }
    const student = studentsByAdmission.get(admission.toLowerCase())
    if (!student) { fail(`No student with admission number ${admission} — import the student list first`); continue }

    const amount = parseAmount(at('amount'))
    if (amount.error || !amount.value) { fail(amount.error || 'Amount is missing'); continue }
    if (amount.value <= 0) { fail('Amount must be greater than zero'); continue }

    const date = parseDate(at('date'))
    if (date.error || !date.value) { fail(date.error || 'Date is missing'); continue }
    if (date.ambiguous) { fail(`Date "${at('date')}" is ambiguous (could be ${date.value} or day/month swapped) — fix it in the file`); continue }

    const method = normalizeMethod(at('method'))
    if (method.error) { fail(method.error); continue }

    const reference = cleanAdmission(at('reference'))
    const term = at('term') ? matchTerm(at('term'), terms) : terms.find((item) => item.id === fallbackTermId)
    if (!term) { fail(`Term "${at('term') || '—'}" not found in this school`); continue }

    const incoming = { studentId: student.id, date: date.value, amount: amount.value, reference }
    const duplicate = (snapshot.payments ?? []).find((payment) => paymentMatchesExisting(payment, incoming))
    if (duplicate) {
      plan.duplicates.push({ rowNumber: row.rowNumber, admissionNumber: admission, amount: amount.value, date: date.value, reference })
      continue
    }

    plan.toCreate.push({
      payment: {
        id: null, // assigned by the wizard so offline ids stay stable
        studentId: student.id,
        termId: term.id,
        amount: amount.value,
        method: method.value,
        code: method.value === 'M-Pesa' ? reference : '',
        reference,
        date: date.value,
        source: 'import',
      },
      rowNumber: row.rowNumber,
    })
  }

  return plan
}

export function buildFeePlan({ rows, mapping, snapshot, options }) {
  const { classPlan = {}, requireConfirmForPaidTerms = true } = options
  const terms = snapshot.terms ?? []
  const classes = snapshot.classes ?? []
  const students = snapshot.students ?? []
  const payments = snapshot.payments ?? []

  const plan = { feeUpdates: [], errors: [], classesToCreate: [], paidTermWarnings: [] }

  for (const row of rows) {
    const at = (key) => (mapping[key] === undefined ? '' : row.cells[mapping[key]])
    const rawClass = normalizeClassName(at('className'))
    const fail = (reason) => plan.errors.push({ rowNumber: row.rowNumber, admissionNumber: '', reason })

    if (!rawClass) { fail('Class is missing'); continue }
    let schoolClass = findExistingClass(rawClass, classes)
    if (!schoolClass) {
      const resolution = classPlan[rawClass.toLowerCase()]
      if (resolution?.action === 'existing') schoolClass = findExistingClass(resolution.target, classes)
      else if (resolution?.action === 'create' && !plan.classesToCreate.includes(resolution.target ?? rawClass)) {
        plan.classesToCreate.push(resolution.target ?? rawClass)
      }
      if (!schoolClass && resolution?.action !== 'create') { fail(`Class "${rawClass}" not found`); continue }
    }

    const term = matchTerm(at('term'), terms)
    if (!term) { fail(`Term "${at('term') || '—'}" not found in this school`); continue }

    const amount = parseAmount(at('amount'))
    if (amount.error || amount.value === null) { fail(amount.error || 'Amount is missing'); continue }

    const className = schoolClass?.name ?? (classPlan[rawClass.toLowerCase()]?.target ?? rawClass)
    const before = Number(term.fees?.[className] ?? 0)
    if (before === amount.value) continue
    plan.feeUpdates.push({ termId: term.id, termLabel: term.label, className, before, after: amount.value })
  }

  if (requireConfirmForPaidTerms) {
    for (const update of plan.feeUpdates) {
      const hasPayments = payments.some((payment) => payment.termId === update.termId)
        || students.some((student) => payments.some((payment) => payment.studentId === student.id && payment.termId === update.termId))
      if (hasPayments && !plan.paidTermWarnings.some((warning) => warning.termId === update.termId)) {
        const term = terms.find((item) => item.id === update.termId)
        plan.paidTermWarnings.push({ termId: update.termId, label: term?.label ?? update.termLabel })
      }
    }
  }

  return plan
}
