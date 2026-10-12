// Pure cleaning helpers for spreadsheet imports. No browser or I/O dependencies
// so they can run in node tests and inside the import worker alike.

function toText(value) {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  let text = String(value).trim()
  // Excel floats like 7123456.0 or scientific 1.2345E9 lose the plain digits.
  if (/^-?\d+\.0+$/.test(text)) text = text.slice(0, text.indexOf('.'))
  if (/\d(\.\d+)?[eE][+-]?\d+/.test(text)) {
    const expanded = Number(text)
    if (Number.isFinite(expanded) && Number.isInteger(expanded)) text = String(expanded)
  }
  return text
}

export function cleanAdmission(value) {
  return toText(value).replace(/\s+/g, '')
}

export function cleanName(value) {
  const text = toText(value).replace(/\s+/g, ' ')
  if (!text) return ''
  // Fix ALL CAPS or all-lower names; leave mixed-case names alone.
  const letters = text.replace(/[^a-zA-Z]/g, '')
  const needsCasing = letters.length > 2 && (letters === letters.toUpperCase() || letters === letters.toLowerCase())
  if (!needsCasing) return text
  return text
    .toLowerCase()
    .replace(/(^|[^a-z'])([a-z])/g, (_, prefix, letter) => prefix + letter.toUpperCase())
}

const KENYA_MOBILE = /^254(7\d{8}|1\d{8})$/

export function normalizePhone(value) {
  let text = toText(value)
  if (!text) return { value: '', error: 'Phone number is missing' }
  text = text.replace(/[\s()\-.]/g, '')
  if (text.startsWith('+')) text = text.slice(1)
  if (text.startsWith('00')) text = text.slice(2)

  if (/^\d+$/.test(text)) {
    if (text.startsWith('0') && text.length === 10) text = `254${text.slice(1)}`
    else if (text.length === 9 && (text.startsWith('7') || text.startsWith('1'))) text = `254${text}`
  }

  if (!KENYA_MOBILE.test(text)) {
    return { value: text, error: `Phone number "${toText(value)}" is not a Kenyan mobile number` }
  }
  return { value: text, error: '' }
}

export function normalizeStatus(value) {
  const text = toText(value).toLowerCase()
  if (!text) return { value: 'active', error: '' }
  if (['active', 'present', 'enrolled', 'in', 'yes', 'current', 'true', '1'].includes(text)) {
    return { value: 'active', error: '' }
  }
  if (['left', 'inactive', 'gone', 'transferred', 'out', 'no', 'false', '0', 'dropped'].includes(text)) {
    return { value: 'inactive', error: '' }
  }
  return { value: text, error: `Status "${toText(value)}" must be active or left` }
}

export function parseAmount(value) {
  const text = toText(value).replace(/[\s,]/g, '').replace(/^kes/i, '').replace(/ksh/i, '')
  if (!text) return { value: null, error: 'Amount is missing' }
  const number = Number(text)
  if (!Number.isFinite(number)) return { value: null, error: `"${toText(value)}" is not a number` }
  if (number < 0) return { value: null, error: 'Amount cannot be negative' }
  return { value: Math.round(number * 100) / 100, error: '' }
}

function serialToDate(serial) {
  // Excel day 1 = 1900-01-01, with the famous 1900 leap-year bug (day 60).
  const ms = Math.round((Number(serial) - 25569) * 86400 * 1000)
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return null
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  }
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }

export function parseDate(value) {
  if (value === null || value === undefined || value === '') return { value: '', error: 'Date is missing', ambiguous: false }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return { value: value.toISOString().slice(0, 10), error: '', ambiguous: false }
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value < 20000 || value > 80000) return { value: '', error: `"${value}" is not a date`, ambiguous: false }
    const parts = serialToDate(value)
    return { value: `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`, error: '', ambiguous: false }
  }

  const text = toText(value)
  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (iso) return { value: text.slice(0, 10), error: '', ambiguous: false }

  // "03-Sep-2026"
  const dayMonthName = text.match(/^(\d{1,2})[-/ ]([a-zA-Z]{3,})[-/ ](\d{4})$/)
  if (dayMonthName && MONTHS[dayMonthName[2].slice(0, 3).toLowerCase()]) {
    const day = Number(dayMonthName[1])
    const month = MONTHS[dayMonthName[2].slice(0, 3).toLowerCase()]
    const year = Number(dayMonthName[3])
    return { value: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, error: '', ambiguous: false }
  }
  // "Sep 3, 2026"
  const monthNameDay = text.match(/^([a-zA-Z]{3,})[-/ ](\d{1,2})[, ]+[- ]?(\d{4})$/)
  if (monthNameDay && MONTHS[monthNameDay[1].slice(0, 3).toLowerCase()]) {
    const month = MONTHS[monthNameDay[1].slice(0, 3).toLowerCase()]
    const day = Number(monthNameDay[2])
    const year = Number(monthNameDay[3])
    return { value: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, error: '', ambiguous: false }
  }

  const slashes = text.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/)
  if (slashes) {
    let [, first, second, year] = slashes
    year = Number(year)
    if (year < 100) year += year > 70 ? 1900 : 2000
    const day = Number(first)
    const month = Number(second)
    if (day < 1 || day > 31 || month < 1 || month > 12) {
      return { value: '', error: `"${text}" is not a valid date`, ambiguous: false }
    }
    // Kenya writes day first. Flag the rows where month-first reading would differ.
    const ambiguous = day <= 12 && month !== day
    return { value: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, error: '', ambiguous }
  }

  return { value: '', error: `"${text}" is not a recognized date`, ambiguous: false }
}

export function normalizeMethod(value) {
  const text = toText(value).toLowerCase().replace(/\s+/g, '')
  if (!text) return { value: 'Cash', error: '' }
  if (['mpesa', 'm-pesa', 'm_pesa', 'mobile'].includes(text)) return { value: 'M-Pesa', error: '' }
  if (['cash', 'cheque', 'money'].includes(text)) return { value: 'Cash', error: '' }
  if (['bank', 'banktransfer', 'transfer', 'deposit'].includes(text)) return { value: 'Bank', error: '' }
  return { value: text, error: `Payment method "${toText(value)}" must be cash, mpesa or bank` }
}

export function normalizeClassName(value) {
  return toText(value).replace(/\s+/g, ' ').replace(/^grade[- ]?(\d)$/i, 'Grade $1')
}
