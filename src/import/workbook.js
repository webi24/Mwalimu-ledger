import * as XLSX from 'xlsx'

export const MAX_FILE_BYTES = 5 * 1024 * 1024
export const MAX_DATA_ROWS = 5000

export function cellToText(value) {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return ''
    return value.toISOString().slice(0, 10)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return ''
    // Keep admission numbers and phones as their plain digits, never scientific notation.
    return Number.isInteger(value) ? String(value) : String(value)
  }
  return String(value).trim()
}

function isBlank(value) {
  return cellToText(value) === ''
}

export async function readWorkbookFile(file) {
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`"${file.name}" is larger than 5 MB. Split it into smaller files and import each one.`)
  }
  const buffer = await file.arrayBuffer()
  let workbook
  try {
    workbook = XLSX.read(buffer, { cellDates: true, cellText: true })
  } catch {
    throw new Error('This file could not be read. Save it as .xlsx or .csv and try again.')
  }
  return {
    fileName: file.name,
    fileType: file.name.toLowerCase().endsWith('.csv') ? 'students' : undefined,
    sheetNames: workbook.SheetNames,
    workbook,
  }
}

export function countSheetRows(worksheet) {
  const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1, raw: true, defval: '' })
  return rows.filter((row) => row.some((cell) => !isBlank(cell))).length
}

// The header row may not be row 1 (schools add title rows above the table).
// Pick the first row with at least two filled cells that are mostly words, not values.
export function detectHeaderRow(worksheet) {
  const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1, raw: true, defval: '' })
  for (let index = 0; index < Math.min(rows.length, 12); index += 1) {
    const row = rows[index]
    const filled = row.filter((cell) => !isBlank(cell))
    if (filled.length < 2) continue
    const words = filled.filter((cell) => typeof cell === 'string' && cellToText(cell).length > 0 && !/^\d+([.,]\d+)?$/.test(cellToText(cell)))
    if (words.length >= Math.max(2, Math.ceil(filled.length / 2))) return index
  }
  return 0
}

export function readSheetRows(workbook, sheetName, headerRowIndex) {
  const worksheet = workbook.Sheets[sheetName]
  if (!worksheet) throw new Error(`The workbook has no sheet called "${sheetName}".`)
  const allRows = XLSX.utils.sheet_to_json(worksheet, { header: 1, raw: true, defval: '' })
  if (headerRowIndex >= allRows.length) throw new Error('The chosen header row is past the end of the sheet.')

  const headers = (allRows[headerRowIndex] ?? []).map((cell) => cellToText(cell))
  const rows = []
  for (let index = headerRowIndex + 1; index < allRows.length; index += 1) {
    const row = allRows[index]
    if (!row.some((cell) => !isBlank(cell))) continue // ignore completely blank rows
    rows.push({ rowNumber: index + 1, cells: row })
  }
  if (rows.length > MAX_DATA_ROWS) {
    throw new Error(`This sheet has ${rows.length} data rows. Import at most ${MAX_DATA_ROWS} rows per file.`)
  }
  return { headers, rows }
}
