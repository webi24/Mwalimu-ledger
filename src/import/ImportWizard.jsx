import { useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, CircleAlert, Download, FileSpreadsheet, RotateCcw, Upload, X } from 'lucide-react'
import { supabase, isSupabaseConfigured } from '../supabaseClient.js'
import { buildStudentOperation, buildPaymentOperation, buildChargeOperation, reloadSnapshotAfterUndo } from '../syncEngine.js'
import { readSchoolQueueStatus } from '../offlineStore.js'
import { IMPORT_TYPES, guessMapping, loadRememberedMapping, rememberMapping } from './mapping.js'
import { detectHeaderRow, readSheetRows, readWorkbookFile } from './workbook.js'
import { buildFeePlan, buildPaymentPlan, buildStudentPlan, detectUnknownClasses, openingDeltaKey } from './validate.js'
import {
  buildErrorReportWorkbook,
  downloadFeeTemplate,
  downloadPaymentTemplate,
  downloadStudentTemplate,
} from './exporters.js'
import './ImportWizard.css'

const makeId = () => globalThis.crypto?.randomUUID?.() ?? `record-${Date.now()}-${Math.random().toString(16).slice(2)}`
const CHUNK_SIZE = 100
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

const TEMPLATE_DOWNLOADS = {
  students: downloadStudentTemplate,
  payments: downloadPaymentTemplate,
  fees: downloadFeeTemplate,
}

function StepDots({ step }) {
  const steps = ['Choose file', 'Match columns', 'Check and confirm', 'Import']
  const index = step === 'file' ? 0 : step === 'map' ? 1 : step === 'preview' ? 2 : 3
  return (
    <ol className="iw-steps">
      {steps.map((label, position) => (
        <li key={label} className={position === index ? 'iw-step active' : position < index ? 'iw-step done' : 'iw-step'}>
          <span>{position < index ? <Check size={13} /> : position + 1}</span>{label}
        </li>
      ))}
    </ol>
  )
}

function ImportWizard({ school, snapshot, termId, onCommit, onClose, initialType = 'students' }) {
  const [importType, setImportType] = useState(initialType)
  const [step, setStep] = useState('file')
  const [fatalError, setFatalError] = useState('')
  const [busy, setBusy] = useState(false)

  const [fileName, setFileName] = useState('')
  const [workbook, setWorkbook] = useState(null)
  const [sheetName, setSheetName] = useState('')
  const [headerRow, setHeaderRow] = useState(1)
  const [headers, setHeaders] = useState([])
  const [rows, setRows] = useState([])

  const [mapping, setMapping] = useState({})
  const [classPlan, setClassPlan] = useState({})
  const [missingAction, setMissingAction] = useState('nothing')
  const [balanceChoices, setBalanceChoices] = useState({})
  const [feeConfirmed, setFeeConfirmed] = useState(false)

  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [result, setResult] = useState(null)
  const [undoError, setUndoError] = useState('')
  const [undoBusy, setUndoBusy] = useState(false)
  const fileInput = useRef(null)
  const beforeSnapshot = useRef(null)

  const fields = IMPORT_TYPES[importType].fields
  const classes = snapshot.classes ?? []
  const batchIdRef = useRef(null)

  const unknownClasses = useMemo(() => {
    if (!rows.length || !fields.length) return []
    const classField = importType === 'fees' ? 'className' : 'class'
    const index = mapping[classField]
    if (index === undefined) return []
    return detectUnknownClasses(rows, index, classes)
  }, [rows, mapping, importType, classes, fields.length])

  const plan = useMemo(() => {
    if (step !== 'preview' || !rows.length) return null
    const options = { termId, classPlan, missingAction, batchId: batchIdRef.current ?? 'preview-batch' }
    if (importType === 'students') {
      return buildStudentPlan({ rows, mapping, snapshot, options, generateId: () => makeId() })
    }
    if (importType === 'payments') {
      return buildPaymentPlan({ rows, mapping, snapshot, options: { fallbackTermId: termId } })
    }
    return buildFeePlan({ rows, mapping, snapshot, options: { classPlan } })
  }, [step, rows, mapping, importType, snapshot, termId, classPlan, missingAction])

  const loadSheet = (book, name, headerIndex) => {
    const index = Math.max(0, (headerIndex ?? 1) - 1)
    const sheet = readSheetRows(book, name, index)
    setHeaders(sheet.headers)
    setRows(sheet.rows)
  }

  const handleFile = async (file) => {
    if (!file) return
    setFatalError('')
    setBusy(true)
    try {
      const parsed = await readWorkbookFile(file)
      setFileName(parsed.fileName)
      setWorkbook(parsed.workbook)
      const firstSheet = parsed.sheetNames.find((name) => readSheetRows(parsed.workbook, name, 0).rows.length) ?? parsed.sheetNames[0]
      setSheetName(firstSheet)
      const detected = detectHeaderRow(parsed.workbook.Sheets[firstSheet]) + 1
      setHeaderRow(detected)
      loadSheet(parsed.workbook, firstSheet, detected)
      const remembered = school ? loadRememberedMapping(school.school_id, importType, []) : null
      const firstHeaders = readSheetRows(parsed.workbook, firstSheet, detected - 1).headers
      setMapping(remembered && Object.keys(remembered).length ? remembered : guessMapping(firstHeaders, importType))
    } catch (error) {
      setFatalError(error.message)
      setWorkbook(null)
      setRows([])
    }
    setBusy(false)
  }

  const changeSheet = (name) => {
    setSheetName(name)
    const detected = detectHeaderRow(workbook.Sheets[name]) + 1
    setHeaderRow(detected)
    loadSheet(workbook, name, detected)
    setMapping(guessMapping(readSheetRows(workbook, name, detected - 1).headers, importType))
  }

  const changeHeaderRow = (value) => {
    const next = Math.max(1, Number(value) || 1)
    setHeaderRow(next)
    loadSheet(workbook, sheetName, next)
  }

  const missingRequired = fields.filter((field) => field.required && mapping[field.key] === undefined)

  const goToPreview = () => {
    if (missingRequired.length) return
    if (school) rememberMapping(school.school_id, importType, mapping)
    setClassPlan((current) => {
      const next = { ...current }
      for (const name of unknownClasses) {
        if (!next[name.toLowerCase()]) next[name.toLowerCase()] = { action: 'create', target: name }
      }
      return next
    })
    setStep('preview')
  }

  const summary = useMemo(() => {
    if (!plan) return null
    if (importType === 'students') {
      return {
        created: plan.toCreate.length,
        updated: plan.toUpdate.length,
        unchanged: plan.unchanged.length,
        errors: plan.errors.length,
        skipped: plan.errors.length,
        duplicates: 0,
      }
    }
    if (importType === 'payments') {
      return { created: plan.toCreate.length, updated: 0, unchanged: plan.duplicates.length, errors: plan.errors.length, skipped: plan.errors.length, duplicates: plan.duplicates.length }
    }
    return { created: plan.feeUpdates.length, updated: 0, unchanged: 0, errors: plan.errors.length, skipped: plan.errors.length, duplicates: 0 }
  }, [plan, importType])

  const runImport = async () => {
    if (!plan || !summary) return
    setBusy(true)
    setFatalError('')
    beforeSnapshot.current = snapshot

    let batchId = makeId()
    let registered = false
    if (supabase && school) {
      const { data, error } = await supabase.rpc('register_import_batch', {
        target_school_id: school.school_id,
        file_name: fileName || 'import.xlsx',
        import_type: importType,
      })
      if (!error && data) {
        batchId = data
        registered = true
      }
    }
    batchIdRef.current = batchId

    const operations = []
    const classesAfter = [...classes]
    for (const name of plan.classesToCreate ?? []) {
      const id = makeId()
      classesAfter.push({ id, name, version: 1 })
      operations.push({ operationId: makeId(), kind: 'class.upsert', data: { id, name } })
    }
    const classIdByName = new Map(classesAfter.map((schoolClass) => [schoolClass.name, schoolClass.id]))

    const newStudents = []
    const updatedStudents = []
    const newCharges = []
    const newPayments = []
    let termsAfter = snapshot.terms

    try {
      const totalSteps = operations.length
      setProgress({ done: 0, total: Math.max(totalSteps, 1) })

      if (importType === 'students') {
        for (const { draft } of plan.toCreate) {
          const student = { ...draft, classId: draft.classId ?? classIdByName.get(draft.grade) ?? null }
          newStudents.push(student)
          operations.push({ operationId: makeId(), ...buildStudentOperation(student, classesAfter, batchId) })
        }
        for (const update of plan.toUpdate) {
          const after = { ...update.student }
          for (const [key, change] of Object.entries(update.changes)) after[key] = change.after
          if (update.changes.grade) after.classId = classIdByName.get(after.grade) ?? after.classId
          updatedStudents.push(after)
          operations.push({ operationId: makeId(), ...buildStudentOperation(after, classesAfter, batchId) })
        }
        for (const opening of plan.openingCharges) {
          const studentId = opening.draftIndex !== null ? plan.toCreate[opening.draftIndex].draft.id : opening.studentId
          const charge = { id: makeId(), studentId, termId: opening.termId, amount: opening.amount, sourceKey: opening.sourceKey }
          newCharges.push({ ...charge, type: 'adjustment' })
          operations.push({ operationId: makeId(), ...buildChargeOperation(charge, batchId) })
        }
        for (const difference of plan.balanceDifferences) {
          if (balanceChoices[difference.student.id] !== 'replace') continue
          const delta = Math.round((difference.incoming - difference.applied) * 100) / 100
          if (!delta) continue
          const charge = {
            id: makeId(),
            studentId: difference.student.id,
            termId: difference.student.startTermId ?? termId,
            amount: delta,
            sourceKey: openingDeltaKey(batchId, difference.admissionNumber),
          }
          newCharges.push({ ...charge, type: 'adjustment' })
          operations.push({ operationId: makeId(), ...buildChargeOperation(charge, batchId) })
        }
      } else if (importType === 'payments') {
        for (const { payment } of plan.toCreate) {
          const complete = { ...payment, id: makeId() }
          newPayments.push(complete)
          operations.push({ operationId: makeId(), ...buildPaymentOperation(complete, batchId) })
        }
      } else {
        termsAfter = snapshot.terms.map((term) => {
          const updates = plan.feeUpdates.filter((update) => update.termId === term.id)
          if (!updates.length) return term
          const fees = { ...term.fees }
          for (const update of updates) fees[update.className] = update.after
          return { ...term, fees }
        })
        for (const update of plan.feeUpdates) {
          operations.push({
            operationId: makeId(),
            kind: 'fee_structure.upsert',
            data: { term_id: update.termId, class_id: classIdByName.get(update.className), amount: update.after, import_batch_id: batchId },
          })
        }
      }

      setProgress({ done: 0, total: Math.max(operations.length, 1) })
      for (let index = 0; index < operations.length; index += CHUNK_SIZE) {
        setProgress({ done: Math.min(index + CHUNK_SIZE, operations.length), total: operations.length })
        await tick()
      }

      const next = {
        ...snapshot,
        classes: classesAfter.length ? classesAfter : snapshot.classes,
        students: [
          ...snapshot.students.filter((student) => !updatedStudents.some((after) => after.id === student.id)),
          ...newStudents,
          ...updatedStudents,
        ],
        payments: [...snapshot.payments, ...newPayments],
        charges: [...(snapshot.charges ?? []), ...newCharges],
        terms: termsAfter,
      }
      onCommit(next, operations)

      const counts = { created: summary.created, updated: summary.updated, skipped: summary.skipped }
      if (registered && supabase && school) {
        supabase.rpc('complete_import_batch', {
          target_school_id: school.school_id,
          target_batch_id: batchId,
          created_count: counts.created,
          updated_count: counts.updated,
          skipped_count: counts.skipped,
        }).catch(() => {})
      }

      setResult({
        batchId,
        registered,
        counts,
        errors: plan.errors,
        openingTotal: newCharges.reduce((total, charge) => total + Number(charge.amount), 0),
        paymentTotal: newPayments.reduce((total, payment) => total + Number(payment.amount), 0),
        studentsOnRoll: newStudents.length,
        undoState: 'idle',
      })
      setStep('done')
    } catch (error) {
      setFatalError(`The import stopped: ${error.message}`)
    }
    setBusy(false)
  }

  const undoImport = async () => {
    if (!result || undoBusy) return
    setUndoError('')
    if (!isSupabaseConfigured || !school) {
      // Local-only school: nothing has left this device, so restore the snapshot.
      onCommit(beforeSnapshot.current, [])
      setResult({ ...result, undoState: 'undone' })
      return
    }
    if (!navigator.onLine) {
      setUndoError('Undo needs a connection so the cloud copy can be cleaned up. Reconnect and try again.')
      return
    }
    setUndoBusy(true)
    try {
      const status = await readSchoolQueueStatus(school.school_id)
      if (status.pending > 0) {
        setUndoError('Your changes are still syncing. Wait for the sync indicator to settle, then undo.')
        setUndoBusy(false)
        return
      }
      const { error } = await supabase.rpc('undo_import_batch', {
        target_school_id: school.school_id,
        target_batch_id: result.batchId,
      })
      if (error) {
        setUndoError(error.message)
        setUndoBusy(false)
        return
      }
      const fresh = await reloadSnapshotAfterUndo(school)
      onCommit(fresh, [])
      setResult({ ...result, undoState: 'undone' })
    } catch (error) {
      setUndoError(error.message)
    }
    setUndoBusy(false)
  }

  const errorReport = () => buildErrorReportWorkbook(plan?.errors ?? result?.errors ?? [], `${importType}-import-errors.xlsx`)

  return (
    <div className="iw-backdrop">
      <section className="iw-card" role="dialog" aria-modal="true" aria-label="Import from Excel">
        <header className="iw-head">
          <div>
            <p className="iw-eyebrow">IMPORT FROM EXCEL</p>
            <h2>{IMPORT_TYPES[importType].label}</h2>
          </div>
          <button className="icon-button" type="button" aria-label="Close import" onClick={onClose}><X size={19} /></button>
        </header>

        <StepDots step={step} />

        {fatalError && <p className="iw-error" role="alert"><CircleAlert size={16} />{fatalError}</p>}

        {step === 'file' && (
          <div className="iw-body">
            <div className="iw-type-choice">
              {Object.entries(IMPORT_TYPES).map(([key, type]) => (
                <label key={key} className={importType === key ? 'iw-type selected' : 'iw-type'}>
                  <input
                    type="radio" name="import-type" checked={importType === key}
                    onChange={() => { setImportType(key); setWorkbook(null); setRows([]); setFileName('') }}
                  />
                  <strong>{type.label}</strong>
                  <small>{key === 'students' ? 'One row per student, with optional opening balances' : key === 'payments' ? 'Old payment records, duplicate-safe' : 'Class fee amounts per term'}</small>
                </label>
              ))}
            </div>

            <div
              className="iw-dropzone"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => { event.preventDefault(); handleFile(event.dataTransfer.files?.[0]) }}
            >
              <FileSpreadsheet size={30} />
              <strong>Drop the school&apos;s Excel file here</strong>
              <small>.xlsx, .xls or .csv · up to 5 MB or about 5,000 rows · works offline</small>
              <button className="button button-primary" type="button" onClick={() => fileInput.current?.click()} disabled={busy}>
                <Upload size={16} />{busy ? 'Reading…' : 'Choose file'}
              </button>
              <input
                ref={fileInput} type="file" hidden accept=".xlsx,.xls,.csv"
                onChange={(event) => { handleFile(event.target.files?.[0]); event.target.value = '' }}
              />
            </div>

            <div className="iw-template-row">
              <span>Need a starting point? Download the template with example rows.</span>
              <button className="text-button" type="button" onClick={() => TEMPLATE_DOWNLOADS[importType]()}><Download size={15} /> Download template</button>
            </div>

            {workbook && (
              <div className="iw-sheet-panel">
                <div className="iw-sheet-row">
                  <label>Sheet
                    <select value={sheetName} onChange={(event) => changeSheet(event.target.value)}>
                      {workbook.SheetNames.map((name) => <option key={name} value={name}>{name}</option>)}
                    </select>
                  </label>
                  <label>Header row
                    <input type="number" min="1" value={headerRow} onChange={(event) => changeHeaderRow(event.target.value)} />
                  </label>
                  <span className="iw-file-note">{fileName} · {rows.length} data rows · header: {headers.filter(Boolean).join(', ').slice(0, 60) || 'none found'}</span>
                </div>
                <div className="iw-actions">
                  <button className="button button-primary" type="button" onClick={() => setStep('map')} disabled={!rows.length}>
                    Next: match columns <ArrowRight size={15} />
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {step === 'map' && (
          <div className="iw-body">
            <p className="iw-note">The app found these headers in your file. Check that each field points at the right column — it is remembered for next time.</p>
            <div className="iw-map-grid">
              {fields.map((field) => (
                <label key={field.key} className={mapping[field.key] === undefined && field.required ? 'iw-map-row missing' : 'iw-map-row'}>
                  <span>{field.label}{field.required && <b>*</b>}</span>
                  <select
                    value={mapping[field.key] ?? ''}
                    onChange={(event) => setMapping({ ...mapping, [field.key]: event.target.value === '' ? undefined : Number(event.target.value) })}
                  >
                    <option value="">— not in file —</option>
                    {headers.map((header, index) => <option key={index} value={index}>{header || `Column ${index + 1}`}</option>)}
                  </select>
                </label>
              ))}
            </div>
            {missingRequired.length > 0 && <p className="iw-error"><CircleAlert size={15} />Still needed: {missingRequired.map((field) => field.label).join(', ')}</p>}
            <div className="iw-actions">
              <button className="button button-muted" type="button" onClick={() => setStep('file')}><ArrowLeft size={15} /> Back</button>
              <button className="button button-primary" type="button" onClick={goToPreview} disabled={missingRequired.length > 0}>
                Next: check and confirm <ArrowRight size={15} />
              </button>
            </div>
          </div>
        )}

        {step === 'preview' && plan && summary && (
          <div className="iw-body">
            <div className="iw-summary">
              <span className="iw-stat created"><strong>{summary.created}</strong> will be created</span>
              <span className="iw-stat updated"><strong>{summary.updated}</strong> will be updated</span>
              <span className="iw-stat unchanged"><strong>{summary.unchanged}</strong> unchanged{importType === 'payments' ? ' (duplicates)' : ''}</span>
              <span className={summary.errors ? 'iw-stat error' : 'iw-stat unchanged'}><strong>{summary.errors}</strong> rows need fixing</span>
            </div>

            {unknownClasses.length > 0 && (
              <section className="iw-block">
                <h3>Classes not in the app yet</h3>
                {unknownClasses.map((name) => {
                  const resolution = classPlan[name.toLowerCase()] ?? { action: 'create', target: name }
                  return (
                    <div className="iw-class-row" key={name}>
                      <strong>{name}</strong>
                      <label><input type="radio" checked={resolution.action === 'create'} onChange={() => setClassPlan({ ...classPlan, [name.toLowerCase()]: { action: 'create', target: name } })} /> Create it</label>
                      <label>
                        <input type="radio" checked={resolution.action === 'existing'} onChange={() => setClassPlan({ ...classPlan, [name.toLowerCase()]: { action: 'existing', target: classes[0]?.name ?? name } })} /> Map to
                      </label>
                      {resolution.action === 'existing' && (
                        <select value={resolution.target} onChange={(event) => setClassPlan({ ...classPlan, [name.toLowerCase()]: { action: 'existing', target: event.target.value } })}>
                          {classes.map((schoolClass) => <option key={schoolClass.id ?? schoolClass.name} value={schoolClass.name}>{schoolClass.name}</option>)}
                        </select>
                      )}
                    </div>
                  )
                })}
              </section>
            )}

            {importType === 'students' && plan.missingStudents.length > 0 && (
              <section className="iw-block">
                <h3>Not in this file ({plan.missingStudents.length} students already in the app)</h3>
                <p className="iw-note">Nothing happens to them unless you choose it. They are never deleted automatically.</p>
                <label><input type="radio" checked={missingAction === 'nothing'} onChange={() => setMissingAction('nothing')} /> Leave them as they are</label>
                <label><input type="radio" checked={missingAction === 'markLeft'} onChange={() => setMissingAction('markLeft')} /> Mark them as left</label>
              </section>
            )}

            {importType === 'students' && plan.balanceDifferences.length > 0 && (
              <section className="iw-block">
                <h3>Opening balance differences</h3>
                <p className="iw-note">These students already have an opening balance from an earlier import. Nothing changes unless you choose to replace it.</p>
                {plan.balanceDifferences.map((difference) => (
                  <div className="iw-class-row" key={difference.student.id}>
                    <strong>{difference.admissionNumber} · {difference.student.name}</strong>
                    <span>applied {difference.applied.toLocaleString()} · file says {difference.incoming.toLocaleString()}</span>
                    <label><input type="radio" checked={(balanceChoices[difference.student.id] ?? 'keep') === 'keep'} onChange={() => setBalanceChoices({ ...balanceChoices, [difference.student.id]: 'keep' })} /> Keep existing</label>
                    <label><input type="radio" checked={balanceChoices[difference.student.id] === 'replace'} onChange={() => setBalanceChoices({ ...balanceChoices, [difference.student.id]: 'replace' })} /> Use file value</label>
                  </div>
                ))}
              </section>
            )}

            {importType === 'fees' && plan.paidTermWarnings.length > 0 && (
              <section className="iw-block iw-warning">
                <h3><CircleAlert size={16} /> Payments already recorded</h3>
                <p>These terms already have payments recorded against them: {plan.paidTermWarnings.map((warning) => warning.label).join(', ')}. Changing the fees will change what every student owes.</p>
                <label><input type="checkbox" checked={feeConfirmed} onChange={(event) => setFeeConfirmed(event.target.checked)} /> I understand and want to continue</label>
              </section>
            )}

            {plan.errors.length > 0 && (
              <section className="iw-block">
                <h3>{plan.errors.length} rows will be skipped</h3>
                <div className="iw-table-scroll">
                  <table className="iw-table">
                    <thead><tr><th>Row</th><th>Admission no.</th><th>Problem</th></tr></thead>
                    <tbody>
                      {plan.errors.slice(0, 50).map((error, index) => (
                        <tr key={index}><td>{error.rowNumber}</td><td>{error.admissionNumber || '—'}</td><td>{error.reason}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {plan.errors.length > 50 && <p className="iw-note">…and {plan.errors.length - 50} more. Download the full report after importing.</p>}
                <button className="text-button" type="button" onClick={errorReport}><Download size={15} /> Download error report</button>
              </section>
            )}

            {(importType === 'students' ? plan.toCreate.length > 0 : plan.toCreate.length > 0) && (
              <section className="iw-block">
                <h3>Preview of changes</h3>
                <div className="iw-table-scroll">
                  <table className="iw-table">
                    <thead>
                      <tr><th>Row</th><th>Admission no.</th><th>Name</th><th>Change</th></tr>
                    </thead>
                    <tbody>
                      {importType === 'students' && plan.toCreate.slice(0, 40).map(({ draft, rowNumber }) => (
                        <tr key={draft.id}><td>{rowNumber}</td><td>{draft.admissionNumber}</td><td>{draft.name}</td><td>New student · {draft.grade}{plan.openingCharges.some((charge) => charge.draftIndex !== null && plan.toCreate[charge.draftIndex]?.draft.id === draft.id) ? ' · opening balance' : ''}</td></tr>
                      ))}
                      {importType === 'students' && plan.toUpdate.slice(0, 40).map((update) => (
                        <tr key={update.student.id}><td>{update.rowNumber ?? '—'}</td><td>{update.student.admissionNumber}</td><td>{update.student.name}</td><td>{Object.entries(update.changes).map(([key, change]) => `${key}: ${change.before || '—'} → ${change.after || '—'}`).join('; ')}</td></tr>
                      ))}
                      {importType === 'payments' && plan.toCreate.slice(0, 40).map(({ payment, rowNumber }, index) => (
                        <tr key={index}><td>{rowNumber}</td><td>—</td><td>{snapshot.students.find((student) => student.id === payment.studentId)?.name ?? ''}</td><td>{payment.date} · {payment.amount.toLocaleString()} · {payment.method}</td></tr>
                      ))}
                      {importType === 'fees' && plan.feeUpdates.slice(0, 40).map((update, index) => (
                        <tr key={index}><td>—</td><td>{update.className}</td><td>{update.termLabel}</td><td>{update.before.toLocaleString()} → {update.after.toLocaleString()}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            <div className="iw-actions">
              <button className="button button-muted" type="button" onClick={() => setStep('map')}><ArrowLeft size={15} /> Back</button>
              <button
                className="button button-primary" type="button" onClick={runImport} disabled={busy || (importType === 'fees' && plan.paidTermWarnings.length > 0 && !feeConfirmed)}
              >
                <Check size={16} /> Confirm import
              </button>
            </div>
            <p className="iw-note">Nothing is saved until you confirm. Rows with problems are skipped, never silently changed.</p>
          </div>
        )}

        {step === 'importing' && (
          <div className="iw-body iw-importing">
            <p>Saving your import…</p>
            <div className="iw-progress-track"><span style={{ width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%` }} /></div>
            <small>{progress.done} of {progress.total} changes</small>
          </div>
        )}

        {step === 'done' && result && (
          <div className="iw-body">
            {result.undoState === 'undone' ? (
              <div className="iw-done-banner">
                <strong>Import undone</strong>
                <p>Everything this import created was removed and edited records were restored.</p>
              </div>
            ) : (
              <>
                <div className="iw-done-banner">
                  <strong>Import finished</strong>
                  <p>{result.counts.created} created · {result.counts.updated} updated · {result.counts.skipped} skipped</p>
                </div>
                <section className="iw-block">
                  <h3>Reconciliation — check these against your spreadsheet</h3>
                  <ul className="iw-recon">
                    <li><span>Students added by this import</span><strong>{result.studentsOnRoll}</strong></li>
                    <li><span>Opening balances imported</span><strong>KES {result.openingTotal.toLocaleString()}</strong></li>
                    <li><span>Payments imported</span><strong>KES {result.paymentTotal.toLocaleString()}</strong></li>
                    <li><span>Rows skipped (in the error report)</span><strong>{result.counts.skipped}</strong></li>
                  </ul>
                </section>
                <div className="iw-actions">
                  {result.errors.length > 0 && <button className="button button-outline" type="button" onClick={() => buildErrorReportWorkbook(result.errors, `${importType}-import-errors.xlsx`)}><Download size={15} /> Error report</button>}
                  <button className="button button-outline" type="button" onClick={undoImport} disabled={undoBusy}><RotateCcw size={15} />{undoBusy ? 'Undoing…' : 'Undo this import'}</button>
                  <button className="button button-primary" type="button" onClick={onClose}>Done</button>
                </div>
                {undoError && <p className="iw-error" role="alert"><CircleAlert size={15} />{undoError}</p>}
                <p className="iw-note">Undo is available for the most recent import, within 72 hours, as long as no payments have been recorded against the students it added.</p>
              </>
            )}
          </div>
        )}
      </section>
    </div>
  )
}

export default ImportWizard
