import assert from 'node:assert/strict'
import test from 'node:test'
import {
  cleanAdmission,
  cleanName,
  normalizeMethod,
  normalizePhone,
  parseAmount,
  parseDate,
} from './normalize.js'
import {
  buildFeePlan,
  buildPaymentPlan,
  buildStudentPlan,
  detectUnknownClasses,
  matchTerm,
} from './validate.js'

let idCounter = 0
const generateId = () => `draft-${(idCounter += 1)}`

test('admission numbers keep leading zeros and survive float pollution', () => {
  assert.equal(cleanAdmission(' 0045 '), '0045')
  assert.equal(cleanAdmission('1043.0'), '1043')
  assert.equal(cleanAdmission('1.2345E9'), '1234500000')
})

test('phone numbers normalize to 2547/2541 format from messy inputs', () => {
  assert.equal(normalizePhone('0712 345 678').value, '254712345678')
  assert.equal(normalizePhone('+254712345678').value, '254712345678')
  assert.equal(normalizePhone('712345678').value, '254712345678')
  assert.equal(normalizePhone('0712-345-678').value, '254712345678')
  assert.equal(normalizePhone('254712345678').value, '254712345678')
  assert.equal(normalizePhone('0110 123 456').value, '254110123456')
  assert.ok(normalizePhone('12345').error)
  assert.ok(normalizePhone('020 234 5678').error)
})

test('amounts accept commas, currency labels and decimals but reject negatives', () => {
  assert.equal(parseAmount('12,500').value, 12500)
  assert.equal(parseAmount('KES 12500').value, 12500)
  assert.equal(parseAmount('12500.00').value, 12500)
  assert.equal(parseAmount('Ksh 2,500.50').value, 2500.5)
  assert.ok(parseAmount('-500').error)
  assert.ok(parseAmount('abc').error)
  assert.ok(parseAmount('').error)
})

test('dates convert excel serials, day-first and month-name formats, flagging ambiguity', () => {
  assert.equal(parseDate('03-Sep-2026').value, '2026-09-03')
  assert.equal(parseDate('Sep 3, 2026').value, '2026-09-03')
  const septemberThird = parseDate('3/9/2026')
  assert.equal(septemberThird.value, '2026-09-03')
  assert.equal(septemberThird.ambiguous, true)
  assert.equal(parseDate('25/09/2026').value, '2026-09-25')
  assert.equal(parseDate('25/09/2026').ambiguous, false)
  const serial = Math.round(Date.UTC(2026, 8, 3) / 86400000) + 25569
  assert.equal(parseDate(serial).value, '2026-09-03')
  assert.equal(parseDate(new Date(Date.UTC(2026, 8, 3))).value, '2026-09-03')
  assert.ok(parseDate('31/31/2026').error)
})

test('names fix all-caps and all-lowercase but leave mixed case alone', () => {
  assert.equal(cleanName('  AMINA   WANJIKU '), 'Amina Wanjiku')
  assert.equal(cleanName('amina wanjiku'), 'Amina Wanjiku')
  assert.equal(cleanName("ochieng' omingo"), "Ochieng' Omingo")
  assert.equal(cleanName('McHarus mixed'), 'McHarus mixed')
})

test('payment methods normalize to the three app methods', () => {
  assert.equal(normalizeMethod('M-PESA').value, 'M-Pesa')
  assert.equal(normalizeMethod('bank transfer').value, 'Bank')
  assert.equal(normalizeMethod('').value, 'Cash')
  assert.ok(normalizeMethod('bitcoin').error)
})

const classes = ['Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5', 'Grade 6'].map((name, index) => ({ id: `class-${index + 1}`, name }))
const terms = [
  { id: '2026-t1', label: 'Term 1, 2026', year: 2026, termNumber: 1, fees: { 'Grade 4': 15000, 'Grade 1': 12000 } },
  { id: '2026-t2', label: 'Term 2, 2026', year: 2026, termNumber: 2, fees: { 'Grade 4': 20000, 'Grade 1': 12000 } },
]
const existingStudent = {
  id: 'student-1043',
  admissionNumber: '1043',
  name: 'Kelvin Mutua',
  grade: 'Grade 4',
  classId: 'class-4',
  guardianName: 'Agnes Mutua',
  phone: '254712345678',
  status: 'active',
  startTermId: '2026-t1',
}
const secondStudent = {
  id: 'student-1044',
  admissionNumber: '1044',
  name: 'Faith Njeri',
  grade: 'Grade 1',
  classId: 'class-1',
  guardianName: 'Peter Njeri',
  phone: '254701234567',
  status: 'active',
  startTermId: '2026-t1',
}
const snapshot = { classes, terms, students: [existingStudent, secondStudent], payments: [], charges: [] }

const studentMapping = { admissionNumber: 0, studentName: 1, class: 2, guardianName: 3, guardianPhone: 4, status: 5, openingBalance: 6 }
const row = (rowNumber, cells) => ({ rowNumber, cells })

test('student plan separates new, updated, unchanged and broken rows', () => {
  const rows = [
    row(2, ['0045', 'AMINA WANJIKU', 'Grade 1', 'Mary Wanjiku', '0712 345 678', '', 8500]),
    row(3, ['1044', 'Faith Njeri', 'Grade 1', 'Peter Njeri', '0701 234 567', 'active', '']),
    row(4, ['1043', 'Kelvin Mutua', 'Grade 4', 'Agnes Mutua', '0722 333 444', 'active', '']),
    row(5, ['1043', 'Kelvin Mutua', 'Grade 4', 'Agnes Mutua', '254712345678', 'active', '']),
    row(6, ['', 'No admission', 'Grade 1', 'Guardian', '0712000001', '', '']),
    row(7, ['0055', 'New Pupil', 'Grd 5', 'Guardian Five', '0712000002', '', '']),
  ]
  const plan = buildStudentPlan({ rows, mapping: studentMapping, snapshot, options: { termId: '2026-t1', batchId: 'batch-1' }, generateId })

  assert.equal(plan.toCreate.length, 1)
  assert.equal(plan.toCreate[0].draft.name, 'Amina Wanjiku')
  assert.equal(plan.toCreate[0].draft.phone, '254712345678')
  assert.equal(plan.toCreate[0].draft.startTermId, '2026-t1')
  assert.equal(plan.openingCharges.length, 1)
  assert.equal(plan.openingCharges[0].amount, 8500)
  assert.equal(plan.openingCharges[0].sourceKey, 'import:opening:batch-1:0045')

  assert.equal(plan.toUpdate.length, 1)
  assert.deepEqual(Object.keys(plan.toUpdate[0].changes), ['phone'])
  assert.equal(plan.toUpdate[0].changes.phone.before, '254712345678')
  assert.equal(plan.toUpdate[0].changes.phone.after, '254722333444')

  assert.equal(plan.unchanged.length, 1)
  assert.equal(plan.unchanged[0].student.admissionNumber, '1044')

  assert.equal(plan.errors.length, 3)
  assert.ok(plan.errors[0].reason.includes('Duplicate admission number 1043'))
  assert.ok(plan.errors[1].reason.includes('Admission number is missing'))
  assert.ok(plan.errors[2].reason.includes('Class "Grd 5" not found'))

  assert.equal(plan.missingStudents.length, 0)
})

test('unknown classes can be created or mapped instead of failing the import', () => {
  const rows = [row(2, ['0055', 'New Pupil', 'Grd 5', 'Guardian Five', '0712000002', '', ''])]
  assert.deepEqual(detectUnknownClasses(rows, 2, classes), ['Grd 5'])

  const created = buildStudentPlan({
    rows, mapping: studentMapping, snapshot,
    options: { termId: '2026-t1', batchId: 'b', classPlan: { 'grd 5': { action: 'create', target: 'Grade 5' } } },
    generateId,
  })
  assert.deepEqual(created.classesToCreate, ['Grade 5'])
  assert.equal(created.toCreate[0].draft.grade, 'Grade 5')

  const mapped = buildStudentPlan({
    rows, mapping: studentMapping, snapshot,
    options: { termId: '2026-t1', batchId: 'b', classPlan: { 'grd 5': { action: 'existing', target: 'Grade 5' } } },
    generateId,
  })
  assert.equal(mapped.toCreate[0].draft.grade, 'Grade 5')
  assert.equal(mapped.toCreate[0].draft.classId, 'class-5')
})

test('students missing from a later file are never auto-deleted, only optionally marked left', () => {
  const rows = [row(2, ['0045', 'Amina Wanjiku', 'Grade 1', 'Mary Wanjiku', '0712 345 678', '', ''])]

  const untouched = buildStudentPlan({ rows, mapping: studentMapping, snapshot, options: { termId: '2026-t1', batchId: 'b' }, generateId })
  assert.equal(untouched.missingStudents.length, 2)
  assert.ok(untouched.missingStudents.some((student) => student.admissionNumber === '1043'))
  assert.equal(untouched.toUpdate.length, 0)

  const markLeft = buildStudentPlan({ rows, mapping: studentMapping, snapshot, options: { termId: '2026-t1', batchId: 'b', missingAction: 'markLeft' }, generateId })
  assert.equal(markLeft.toUpdate.length, 2, 'both active students missing from the file are marked left')
  assert.ok(markLeft.toUpdate.every((update) => update.changes.status.after === 'inactive'))
})

test('opening balances apply once; a re-import flags differences instead of double-charging', () => {
  const rows = [row(2, ['0045', 'Amina Wanjiku', 'Grade 1', 'Mary Wanjiku', '0712 345 678', '', 8500])]
  const firstRun = buildStudentPlan({ rows, mapping: studentMapping, snapshot, options: { termId: '2026-t1', batchId: 'batch-1' }, generateId })
  assert.equal(firstRun.openingCharges.length, 1)

  const charges = [{ id: 'charge-1', studentId: firstRun.toCreate[0].draft.id, termId: '2026-t1', amount: 8500, sourceKey: 'import:opening:batch-1:0045' }]
  const snapshotWithCharge = { ...snapshot, students: [firstRun.toCreate[0].draft], charges }
  const sameAgain = buildStudentPlan({ rows, mapping: studentMapping, snapshot: snapshotWithCharge, options: { termId: '2026-t1', batchId: 'batch-2' }, generateId })
  assert.equal(sameAgain.openingCharges.length, 0)
  assert.equal(sameAgain.toCreate.length, 0)
  assert.equal(sameAgain.unchanged.length, 1)

  const changed = row(2, ['0045', 'Amina Wanjiku', 'Grade 1', 'Mary Wanjiku', '0712 345 678', '', 9000])
  const diffRun = buildStudentPlan({ rows: [changed], mapping: studentMapping, snapshot: snapshotWithCharge, options: { termId: '2026-t1', batchId: 'batch-2' }, generateId })
  assert.equal(diffRun.openingCharges.length, 0)
  assert.equal(diffRun.balanceDifferences.length, 1)
  assert.equal(diffRun.balanceDifferences[0].applied, 8500)
  assert.equal(diffRun.balanceDifferences[0].incoming, 9000)
})

test('term labels in any common format match the school terms', () => {
  assert.equal(matchTerm('Term 2, 2026', terms).id, '2026-t2')
  assert.equal(matchTerm('2026-t2', terms).id, '2026-t2')
  assert.equal(matchTerm('term 2 2026', terms).id, '2026-t2')
  assert.equal(matchTerm('Term 3, 2026', terms), null)
})

const paymentMapping = { admissionNumber: 0, date: 1, amount: 2, method: 3, reference: 4, term: 5 }

test('payment plan imports new payments and skips duplicates by receipt or full match', () => {
  const rows = [
    row(2, ['1043', '25/9/2026', 5000, 'mpesa', 'QX12AB34C', 'Term 1, 2026']),
    row(3, ['1043', '03-Sep-2026', 5000, 'mpesa', 'QX12AB34C', 'Term 1, 2026']),
    row(4, ['1043', '04-Sep-2026', '2,500', 'cash', '', '']),
    row(5, ['9999', '04-Sep-2026', 1000, 'cash', '', '']),
    row(6, ['1043', '5/9/2026', 1000, 'cash', '', '']),
  ]
  const payments = [{ id: 'p-1', studentId: 'student-1043', termId: '2026-t1', amount: 5000, method: 'M-Pesa', code: 'QX12AB34C', reference: '', date: '2026-09-03', source: 'manual' }]
  const plan = buildPaymentPlan({ rows, mapping: paymentMapping, snapshot: { ...snapshot, payments }, options: { fallbackTermId: '2026-t2' } })

  assert.equal(plan.duplicates.length, 2, 'both rows with the same receipt are already imported')
  assert.equal(plan.errors.length, 2, 'unknown admission and ambiguous date are flagged')
  assert.ok(plan.errors[0].reason.includes('No student with admission number 9999'))
  assert.ok(plan.errors[1].reason.includes('ambiguous'))

  assert.equal(plan.toCreate.length, 1)
  assert.equal(plan.toCreate[0].payment.source, 'import')
  assert.equal(plan.toCreate[0].payment.method, 'Cash')
  assert.equal(plan.toCreate[0].payment.code, '')
  assert.equal(plan.toCreate[0].payment.termId, '2026-t2', 'missing term falls back to the selected term')

  const referenceOnlyMatch = buildPaymentPlan({
    rows: [row(2, ['1043', '10/10/2026', 777, 'cash', 'RCPT-9', ''])],
    mapping: paymentMapping,
    snapshot: { ...snapshot, payments: [{ id: 'p-2', studentId: 'student-1043', termId: '2026-t1', amount: 999, method: 'Cash', code: '', reference: 'RCPT-9', date: '2026-01-01', source: 'manual' }] },
    options: { fallbackTermId: '2026-t1' },
  })
  assert.equal(referenceOnlyMatch.duplicates.length, 1, 'same reference counts as already imported')
})

test('fee plan updates amounts, skips unchanged, and warns about terms with payments', () => {
  const feeMapping = { className: 0, term: 1, amount: 2 }
  const rows = [
    row(2, ['Grade 1', 'Term 1, 2026', 14500]),
    row(3, ['Grade 1', 'Term 2, 2026', 12000]),
    row(4, ['Grade 9', 'Term 1, 2026', 1000]),
    row(5, ['Grade 4', 'Term 5, 2026', 1000]),
  ]
  const plan = buildFeePlan({
    rows, mapping: feeMapping,
    snapshot: { ...snapshot, payments: [{ id: 'p-1', studentId: 'student-1043', termId: '2026-t1', amount: 500, method: 'Cash', code: '', reference: '', date: '2026-01-05', source: 'manual' }] },
    options: {},
  })
  assert.equal(plan.feeUpdates.length, 1)
  assert.equal(plan.feeUpdates[0].before, 12000)
  assert.equal(plan.feeUpdates[0].after, 14500)
  assert.equal(plan.feeUpdates[0].termId, '2026-t1')
  assert.equal(plan.errors.length, 2)
  assert.deepEqual(plan.paidTermWarnings.map((warning) => warning.termId), ['2026-t1'])
})
