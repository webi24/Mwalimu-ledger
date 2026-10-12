import assert from 'node:assert/strict'
import test from 'node:test'
import { getStudentBalance, getTermPaid, getTermTotals } from './ledger.js'

const student = { id: 'student-1', grade: 'Grade 4' }
const terms = [
  { id: '2026-t1', fees: { 'Grade 4': 15000 } },
  { id: '2026-t2', fees: { 'Grade 4': 20000 } },
]
const payments = [
  { id: 'payment-1', studentId: 'student-1', termId: '2026-t1', amount: 5000 },
  { id: 'payment-2', studentId: 'student-1', termId: '2026-t2', amount: 8000 },
]

test('balance keeps each term history and carries unpaid fees into the next term', () => {
  assert.equal(getStudentBalance(student, '2026-t1', terms, payments), 10000)
  assert.equal(getStudentBalance(student, '2026-t2', terms, payments), 22000)
})

test('term paid totals include only payments recorded in that term', () => {
  assert.equal(getTermPaid(student.id, '2026-t2', payments), 8000)
})

test('term overview reports collections and cumulative outstanding debt', () => {
  assert.deepEqual(getTermTotals('2026-t2', [student], terms, payments), {
    collected: 8000,
    outstanding: 22000,
  })
})

test('a student enrolled in a later term is not charged for earlier terms', () => {
  const lateStudent = { id: 'student-2', grade: 'Grade 4', startTermId: '2026-t2' }

  assert.equal(getStudentBalance(lateStudent, '2026-t1', terms, payments), 0)
  assert.equal(getStudentBalance(lateStudent, '2026-t2', terms, payments), 20000)
  assert.equal(getStudentBalance(lateStudent, '2026-t2', terms, [
    ...payments,
    { id: 'payment-3', studentId: lateStudent.id, termId: '2026-t2', amount: 5000 },
  ]), 15000)
})