// Column mapping: schools' headers never match the template ("Adm No", "Name of
// pupil", "Parent Tel"). Guess a mapping, let the user fix it, then remember the
// final mapping per school so the next import needs no remapping.

export const IMPORT_TYPES = {
  students: {
    label: 'Students',
    fields: [
      { key: 'admissionNumber', label: 'Admission number', required: true, synonyms: ['admissionnumber', 'admno', 'admnumber', 'admission', 'adm', 'regno', 'registrationnumber', 'entrynumber', 'upin', 'studentid', 'idnumber', 'rollno', 'rollnumber', 'studentno'] },
      { key: 'studentName', label: 'Student name', required: true, synonyms: ['studentname', 'name', 'fullname', 'nameofpupil', 'pupilname', 'names', 'student', 'learnername', 'childname'] },
      { key: 'class', label: 'Class', required: true, synonyms: ['class', 'grade', 'classname', 'classgrade', 'stream', 'form', 'standard', 'level', 'classstream'] },
      { key: 'guardianName', label: 'Parent or guardian', required: true, synonyms: ['guardianname', 'parentname', 'parent', 'guardian', 'parentorguardian', 'parentguardianname', 'mothername', 'fathername', 'nextofkin'] },
      { key: 'guardianPhone', label: 'Parent phone number', required: true, synonyms: ['guardianphone', 'parentphone', 'phonenumber', 'phone', 'tel', 'telephone', 'parenttel', 'mobile', 'contact', 'parentcontact', 'parentmobilenumber', 'guardianphonenumber'] },
      { key: 'status', label: 'Status (active/left)', required: false, synonyms: ['status', 'active', 'state', 'enrollmentstatus'] },
      { key: 'openingBalance', label: 'Opening balance (optional)', required: false, synonyms: ['openingbalance', 'balance', 'balancebroughtforward', 'bbf', 'previousbalance', 'arrears', 'balanceforwarded', 'outstanding'] },
    ],
  },
  payments: {
    label: 'Payment history',
    fields: [
      { key: 'admissionNumber', label: 'Admission number', required: true, synonyms: ['admissionnumber', 'admno', 'admnumber', 'admission', 'adm', 'regno', 'registrationnumber', 'studentid', 'rollno', 'studentno'] },
      { key: 'date', label: 'Date paid', required: true, synonyms: ['date', 'datepaid', 'paymentdate', 'paidon', 'transactiondate', 'receiptdate', 'when'] },
      { key: 'amount', label: 'Amount paid', required: true, synonyms: ['amount', 'amountpaid', 'paid', 'payment', 'value', 'feespaid', 'cashreceived', 'total'] },
      { key: 'method', label: 'Payment method (cash/mpesa/bank)', required: false, synonyms: ['method', 'paymentmethod', 'mode', 'modetopay', 'paidvia', 'channel', 'means'] },
      { key: 'reference', label: 'Reference or receipt number', required: false, synonyms: ['reference', 'receipt', 'receiptnumber', 'ref', 'mpesacode', 'mpesareceipt', 'code', 'transactioncode', 'transactionid', 'receptno'] },
      { key: 'term', label: 'Term (optional)', required: false, synonyms: ['term', 'schoolterm', 'termname', 'period'] },
    ],
  },
  fees: {
    label: 'Fee structure',
    fields: [
      { key: 'className', label: 'Class', required: true, synonyms: ['class', 'grade', 'classname', 'stream', 'form', 'standard', 'level'] },
      { key: 'term', label: 'Term', required: true, synonyms: ['term', 'schoolterm', 'termname', 'period'] },
      { key: 'amount', label: 'Fee amount', required: true, synonyms: ['amount', 'fee', 'fees', 'feeamount', 'feescharge', 'charge', 'totalfees', 'schoolfees', 'feesperterm'] },
    ],
  },
}

const normalizeHeader = (header) => String(header ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')

export function guessMapping(headers, importType) {
  const mapping = {}
  const fields = IMPORT_TYPES[importType].fields
  const normalized = headers.map((header) => ({ raw: header, clean: normalizeHeader(header) }))

  for (const field of fields) {
    // 1. exact match on any synonym
    let hit = normalized.findIndex((header) => header.clean && field.synonyms.includes(header.clean))
    // 2. synonym contained in the header ("Parent Tel Number")
    if (hit === -1) hit = normalized.findIndex((header) => header.clean && field.synonyms.some((synonym) => header.clean.includes(synonym)))
    // 3. header contained in a synonym ("ParentTel")
    if (hit === -1) hit = normalized.findIndex((header) => header.clean && field.synonyms.some((synonym) => synonym.includes(header.clean) && header.clean.length > 2))
    if (hit !== -1) mapping[field.key] = hit
  }
  return mapping
}

const STORAGE_PREFIX = 'mwalimu-import-mapping:'

export function rememberMapping(schoolId, importType, mapping) {
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}${schoolId}:${importType}`, JSON.stringify(mapping))
  } catch {
    // Storage unavailable (private mode) — mapping just won't be remembered.
  }
}

export function loadRememberedMapping(schoolId, importType, headers) {
  try {
    const stored = window.localStorage.getItem(`${STORAGE_PREFIX}${schoolId}:${importType}`)
    if (!stored) return null
    const mapping = JSON.parse(stored)
    const maxIndex = headers.length - 1
    const valid = Object.entries(mapping).every(([, index]) => Number.isInteger(index) && index >= 0 && index <= maxIndex)
    return valid ? mapping : null
  } catch {
    return null
  }
}
