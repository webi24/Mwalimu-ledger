export function getTermIndex(terms, termId) {
  return terms.findIndex((term) => term.id === termId)
}

export function getStudentBalance(student, termId, terms, payments, charges = []) {
  const selectedTermIndex = getTermIndex(terms, termId)
  const enrolledTermIndex = getTermIndex(terms, student.startTermId)
  const firstTermIndex = enrolledTermIndex < 0 ? 0 : enrolledTermIndex

  if (selectedTermIndex < firstTermIndex) return 0

  const expected = terms
    .slice(firstTermIndex, selectedTermIndex + 1)
    .reduce((total, term) => total + (term.fees[student.grade] ?? 0), 0)
  // Opening balances imported from Excel are charges that predate the app. They
  // count once, from the term they were attached to onwards.
  const opening = (charges ?? [])
    .filter((charge) => charge.studentId === student.id && String(charge.sourceKey ?? '').startsWith('import:opening:'))
    .filter((charge) => {
      const chargeTermIndex = getTermIndex(terms, charge.termId)
      return chargeTermIndex >= firstTermIndex && chargeTermIndex <= selectedTermIndex
    })
    .reduce((total, charge) => total + Number(charge.amount ?? 0), 0)
  const paid = payments
    .filter((payment) => payment.studentId === student.id)
    .filter((payment) => {
      const paymentTermIndex = getTermIndex(terms, payment.termId)
      return paymentTermIndex >= firstTermIndex && paymentTermIndex <= selectedTermIndex
    })
    .reduce((total, payment) => total + Number(payment.amount), 0)

  return Math.max(expected + opening - paid, 0)
}

export function getTermPaid(studentId, termId, payments) {
  return payments
    .filter((payment) => payment.studentId === studentId && payment.termId === termId)
    .reduce((total, payment) => total + Number(payment.amount), 0)
}

export function getTermTotals(termId, students, terms, payments) {
  const termIndex = getTermIndex(terms, termId)
  const term = terms[termIndex]

  if (!term) return { collected: 0, outstanding: 0 }

  const collected = payments
    .filter((payment) => payment.termId === termId)
    .reduce((total, payment) => total + Number(payment.amount), 0)
  const outstanding = students.reduce(
    (total, student) => total + getStudentBalance(student, termId, terms, payments),
    0,
  )

  return { collected, outstanding }
}