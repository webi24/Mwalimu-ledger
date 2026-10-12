import * as XLSX from 'xlsx'
import { getStudentBalance, getTermPaid } from '../ledger.js'

// Exported text cells that start with =, +, - or @ could execute as formulas in
// Excel. Prefix them so Excel treats them as text.
export function safeCell(value) {
  const text = String(value ?? '')
  return /^[=+\-@]/.test(text) ? `'${text}` : text
}

const STUDENT_TEMPLATE_COLUMNS = ['admission_number', 'student_name', 'class', 'guardian_name', 'guardian_phone', 'status', 'opening_balance']
const PAYMENT_TEMPLATE_COLUMNS = ['admission_number', 'date', 'amount', 'method', 'reference', 'term']
const FEE_TEMPLATE_COLUMNS = ['class', 'term', 'amount']

function noteSheet(lines) {
  return XLSX.utils.aoa_to_sheet([['How to fill this'], ...lines.map((line) => [line])])
}

function templateWorkbook(sheetName, columns, exampleRows, notes) {
  const sheet = XLSX.utils.aoa_to_sheet([columns, ...exampleRows])
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName)
  XLSX.utils.book_append_sheet(workbook, noteSheet(notes), 'How to fill this')
  return workbook
}

function download(workbook, fileName) {
  XLSX.writeFile(workbook, fileName, { bookType: 'xlsx' })
}

export function downloadStudentTemplate() {
  download(
    templateWorkbook('Students', STUDENT_TEMPLATE_COLUMNS, [
      ['0045', 'Amina Wanjiku', 'Grade 4', 'Mary Wanjiku', '0712 345 678', 'active', 8500],
      ['0046', 'Brian Otieno', 'Grade 1', 'Paul Otieno', '+254723456789', 'active', ''],
      ['0047', 'Cynthia Achieng', 'Grade 2', 'Grace Achieng', '254713456789', 'left', ''],
    ], [
      'admission_number: keep leading zeros. If Excel removed them, type the numbers as text.',
      'student_name: full name of the student.',
      'class: must match a class in the app, e.g. Grade 1. New classes are offered during import.',
      'guardian_name and guardian_phone: the phone is normalized to 2547XXXXXXXX.',
      'status: active or left. Leave blank for active.',
      'opening_balance: money the student already owed before using the app (optional).',
      'Do not delete the header row. Save this file as .xlsx or .csv.',
    ]),
    'students-import-template.xlsx',
  )
}

export function downloadPaymentTemplate() {
  download(
    templateWorkbook('Payments', PAYMENT_TEMPLATE_COLUMNS, [
      ['0045', '3/9/2026', 5000, 'mpesa', 'QX12AB34C', 'Term 1, 2026'],
      ['0046', '04-Sep-2026', '2,500', 'cash', '', 'Term 1, 2026'],
    ], [
      'admission_number: must match a student already in the app.',
      'date: any common date format works, e.g. 3/9/2026 or 04-Sep-2026.',
      'amount: numbers only, e.g. 12,500 or KES 12500.',
      'method: cash, mpesa or bank. Leave blank for cash.',
      'reference: receipt number or M-Pesa code. Used to avoid importing the same payment twice.',
      'term: e.g. Term 1, 2026. Leave blank to record in the term selected in the app.',
      'Import this file only once. A second import of the same rows is skipped as duplicates.',
    ]),
    'payments-import-template.xlsx',
  )
}

export function downloadFeeTemplate() {
  download(
    templateWorkbook('Fees', FEE_TEMPLATE_COLUMNS, [
      ['Grade 1', 'Term 1, 2026', 14500],
      ['Grade 2', 'Term 1, 2026', 15000],
    ], [
      'class: must match a class in the app.',
      'term: e.g. Term 1, 2026. The term must already exist in the app.',
      'amount: the total fee for the term.',
      'Careful: if payments are already recorded in that term, the app will ask you to confirm.',
    ]),
    'fees-import-template.xlsx',
  )
}

function studentOpeningBalance(charges, studentId) {
  return (charges ?? [])
    .filter((charge) => charge.studentId === studentId && String(charge.sourceKey ?? '').startsWith('import:opening:'))
    .reduce((total, charge) => total + Number(charge.amount ?? 0), 0)
}

function statusText(status) {
  return status === 'inactive' ? 'left' : 'active'
}

export function buildStudentsSheetRows(snapshot, { termId, charges = [] }) {
  const { students, terms, payments, classes } = snapshot
  return students.map((student) => {
    const balance = getStudentBalance(student, termId, terms, payments, charges)
    return STUDENT_TEMPLATE_COLUMNS.concat(['paid_this_term', 'amount_owed']).map((column, index) => {
      switch (column) {
        case 'admission_number': return safeCell(student.admissionNumber)
        case 'student_name': return safeCell(student.name)
        case 'class': return classes.find((schoolClass) => schoolClass.id === student.classId)?.name ?? student.grade
        case 'guardian_name': return safeCell(student.guardianName)
        case 'guardian_phone': return safeCell(student.phone)
        case 'status': return statusText(student.status)
        case 'opening_balance': return studentOpeningBalance(charges, student.id)
        case 'paid_this_term': return getTermPaid(student.id, termId, payments)
        default: return balance
      }
    })
  })
}

export function exportStudentsWorkbook(snapshot, { termId, charges = [] } = {}) {
  const columns = STUDENT_TEMPLATE_COLUMNS.concat(['paid_this_term', 'amount_owed'])
  const rows = buildStudentsSheetRows(snapshot, { termId, charges })
  const sheet = XLSX.utils.aoa_to_sheet([columns, ...rows])
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, sheet, 'Students')
  download(workbook, `students-${slug(snapshot.schoolName)}.xlsx`)
  return rows.length
}

export function exportPaymentsWorkbook(snapshot, { termId, fromDate, toDate } = {}) {
  const terms = snapshot.terms ?? []
  const payments = (snapshot.payments ?? []).filter((payment) => {
    if (termId && payment.termId !== termId) return false
    if (fromDate && payment.date < fromDate) return false
    if (toDate && payment.date > toDate) return false
    return true
  }).sort((left, right) => right.date.localeCompare(left.date))
  const studentsById = new Map((snapshot.students ?? []).map((student) => [student.id, student]))

  const rows = payments.map((payment) => {
    const term = terms.find((item) => item.id === payment.termId)
    return PAYMENT_TEMPLATE_COLUMNS.map((column) => {
      switch (column) {
        case 'admission_number': return safeCell(studentsById.get(payment.studentId)?.admissionNumber ?? '')
        case 'date': return payment.date
        case 'amount': return Number(payment.amount)
        case 'method': return (payment.method ?? 'Cash').toLowerCase()
        case 'reference': return safeCell(payment.code || payment.reference || '')
        default: return term ? safeCell(term.label) : ''
      }
    })
  })

  const sheet = XLSX.utils.aoa_to_sheet([PAYMENT_TEMPLATE_COLUMNS, ...rows])
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, sheet, 'Payments')
  download(workbook, `payments-${slug(snapshot.schoolName)}.xlsx`)
  return rows.length
}

export function buildDefaultersRows(snapshot, { termId, charges = [] }) {
  const { students, terms, payments } = snapshot
  return students
    .map((student) => ({ student, balance: getStudentBalance(student, termId, terms, payments, charges) }))
    .filter((entry) => entry.balance > 0)
    .sort((left, right) => right.balance - left.balance)
    .map(({ student, balance }) => [
      safeCell(student.admissionNumber),
      safeCell(student.name),
      safeCell(student.grade),
      safeCell(student.guardianName),
      safeCell(student.phone),
      balance,
    ])
}

export function exportDefaultersWorkbook(snapshot, { termId, charges = [] } = {}) {
  const sheet = XLSX.utils.aoa_to_sheet([
    ['admission_number', 'student_name', 'class', 'guardian_name', 'guardian_phone', 'amount_owed'],
    ...buildDefaultersRows(snapshot, { termId, charges }),
  ])
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, sheet, 'Defaulters')
  download(workbook, `defaulters-${slug(snapshot.schoolName)}.xlsx`)
}

export function buildErrorReportWorkbook(errors, fileName = 'import-errors.xlsx') {
  const rows = (errors ?? []).map((error) => [error.rowNumber ?? '', safeCell(error.admissionNumber ?? ''), safeCell(error.reason)])
  const sheet = XLSX.utils.aoa_to_sheet([['sheet_row', 'admission_number', 'problem'], ...rows])
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, sheet, 'Errors')
  download(workbook, fileName)
  return rows.length
}

function slug(name) {
  return String(name ?? 'school').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
}
