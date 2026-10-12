import { useEffect, useState } from 'react'
import {
  ArrowRight,
  BookOpenCheck,
  CalendarDays,
  Check,
  ChevronDown,
  CircleAlert,
  ClipboardList,
  Download,
  FileClock,
  FileSpreadsheet,
  GraduationCap,
  Inbox,
  LayoutDashboard,
  LogOut,
  Plus,
  Printer,
  Search,
  Settings,
  Share2,
  Signal,
  SignalZero,
  UsersRound,
  WalletCards,
  X,
} from 'lucide-react'
import { getStudentBalance, getTermPaid, getTermTotals } from './ledger.js'
import { supabase, isSupabaseConfigured } from './supabaseClient.js'
import { syncSchool, buildStudentOperation, buildPaymentOperation, buildTermOperations } from './syncEngine.js'
import {
  readSchoolSnapshot,
  writeSchoolSnapshot,
  persistSchoolMutation,
  readSchoolQueueStatus,
} from './offlineStore.js'
import ImportWizard from './import/ImportWizard.jsx'
import {
  downloadFeeTemplate,
  downloadPaymentTemplate,
  downloadStudentTemplate,
  exportDefaultersWorkbook,
  exportPaymentsWorkbook,
  exportStudentsWorkbook,
} from './import/exporters.js'
import './App.css'

const STORAGE_KEY = 'school-fees-tracker-v2'
const GRADES = ['Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5', 'Grade 6']

const money = (amount) => `KES ${Number(amount || 0).toLocaleString('en-KE')}`
const makeId = () => globalThis.crypto?.randomUUID?.() ?? `record-${Date.now()}`

function emptySchoolData(school) {
  const now = new Date()
  const termNumber = Math.floor(now.getMonth() / 4) + 1
  const year = now.getFullYear()
  const dueDate = termNumber === 1 ? `${year}-04-30` : termNumber === 2 ? `${year}-08-31` : `${year}-11-15`

  return {
    schoolId: school.school_id,
    schoolName: school.name,
    students: [],
    terms: [{ id: makeId(), label: `Term ${termNumber}, ${year}`, dueDate, fees: Object.fromEntries(GRADES.map((grade) => [grade, 0])) }],
    payments: [],
  }
}

function getStorageKey(school) {
  return school ? `${STORAGE_KEY}:${school.school_id}` : STORAGE_KEY
}

function loadData(school) {
  const fallback = emptySchoolData(school ?? { school_id: 'local-school', name: 'My School' })
  try {
    const stored = window.localStorage.getItem(getStorageKey(school))
    return stored ? JSON.parse(stored) : fallback
  } catch {
    return fallback
  }
}

function initials(name) {
  return name.split(' ').slice(0, 2).map((part) => part[0]).join('').toUpperCase()
}

function humanDate(date) {
  if (!date) return '—'
  return new Date(`${date}T00:00:00`).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' })
}

function nextTermFrom(lastTerm) {
  const [, yearPart, termPart] = lastTerm.id.match(/(\d{4})-t(\d+)/) ?? []
  const year = Number(yearPart || new Date().getFullYear())
  const currentTerm = Number(termPart || 1)
  const nextNumber = currentTerm === 3 ? 1 : currentTerm + 1
  const nextYear = currentTerm === 3 ? year + 1 : year
  const dueDate = nextNumber === 1 ? `${nextYear}-04-30` : nextNumber === 2 ? `${nextYear}-08-31` : `${nextYear}-11-15`

  return {
    id: `${nextYear}-t${nextNumber}`,
    label: `Term ${nextNumber}, ${nextYear}`,
    dueDate,
    fees: { ...lastTerm.fees },
  }
}

function balanceStatus(balance, currentFee) {
  if (balance <= 0) return { text: 'Clear', tone: 'clear' }
  const ratio = currentFee > 0 ? balance / currentFee : 1
  return ratio >= 1 ? { text: 'Follow up', tone: 'attention' } : { text: 'Part paid', tone: 'partial' }
}

const SYNC_POLL_MS = 30000

const SYNC_STATES = {
  offline: { text: 'Offline · saved on this device', tone: 'offline' },
  syncing: { text: 'Syncing…', tone: 'syncing' },
  synced: { text: 'Synced with cloud', tone: 'synced' },
  needs_attention: { text: 'Sync needs attention', tone: 'attention' },
  local_only: { text: 'Cloud sync not connected', tone: 'local' },
}

function App({ school = null, schools = [], user = null, onSwitchSchool, onSignOut, onAddSchool }) {
  const [data, setData] = useState(() => loadData(school))
  const [dataLoaded, setDataLoaded] = useState(() => !school || !isSupabaseConfigured)
  const [syncState, setSyncState] = useState(() => (school && isSupabaseConfigured ? 'syncing' : 'local_only'))
  const [queueStatus, setQueueStatus] = useState({ pending: 0, needsAttention: 0 })
  const [unmatched, setUnmatched] = useState([])
  const [selectedTermId, setSelectedTermId] = useState('')
  const [view, setView] = useState('overview')
  const [query, setQuery] = useState('')
  const [gradeFilter, setGradeFilter] = useState('All classes')
  const [modal, setModal] = useState(null)
  const [receipt, setReceipt] = useState(null)
  const [isOnline, setIsOnline] = useState(navigator.onLine)
  const [toast, setToast] = useState('')
  const [studentDraft, setStudentDraft] = useState({ admissionNumber: '', name: '', grade: 'Grade 1', guardianName: '', phone: '' })
  const [paymentDraft, setPaymentDraft] = useState({ studentId: '', amount: '', date: new Date().toISOString().slice(0, 10), method: 'M-Pesa', code: '' })
  const [feeDraft, setFeeDraft] = useState({})
  const [importType, setImportType] = useState(null)

  const selectedTerm = data.terms.find((term) => term.id === selectedTermId) ?? data.terms.at(-1)
  const charges = data.charges ?? []
  const isReadOnly = school?.status === 'suspended'
  const isAdmin = !school || school.role === 'admin'
  const userName = user?.user_metadata?.name || user?.email?.split('@')[0] || 'School administrator'
  const { collected, outstanding } = getTermTotals(selectedTerm?.id, data.students, data.terms, data.payments, charges)
  const termPayments = data.payments.filter((payment) => payment.termId === selectedTerm?.id)
  const normalizedQuery = query.trim().toLowerCase()
  const filteredStudents = data.students
    .filter((student) => gradeFilter === 'All classes' || student.grade === gradeFilter)
    .filter((student) => !normalizedQuery || `${student.name} ${student.grade} ${student.guardianName}`.toLowerCase().includes(normalizedQuery))
    .sort((left, right) => getStudentBalance(right, selectedTerm?.id, data.terms, data.payments, charges) - getStudentBalance(left, selectedTerm?.id, data.terms, data.payments, charges))

  useEffect(() => {
    const updateOnlineStatus = () => setIsOnline(navigator.onLine)
    window.addEventListener('online', updateOnlineStatus)
    window.addEventListener('offline', updateOnlineStatus)
    return () => {
      window.removeEventListener('online', updateOnlineStatus)
      window.removeEventListener('offline', updateOnlineStatus)
    }
  }, [])

  useEffect(() => {
    if (!school || !isSupabaseConfigured || !dataLoaded) return undefined
    const cancelled = { current: false }

    const runSync = async () => {
      if (!navigator.onLine) {
        setSyncState('offline')
        return
      }
      setSyncState('syncing')
      try {
        const result = await syncSchool(school.school_id, data)
        if (cancelled.current) return
        if (result.snapshot) {
          setData(result.snapshot)
          window.localStorage.setItem(getStorageKey(school), JSON.stringify(result.snapshot))
        }
        setSyncState(result.state)
        const status = await readSchoolQueueStatus(school.school_id)
        if (!cancelled.current) setQueueStatus(status)
      } catch {
        if (!cancelled.current) setSyncState('needs_attention')
      }
    }

    runSync()
    const intervalId = window.setInterval(runSync, SYNC_POLL_MS)
    const handleOnline = () => runSync()
    window.addEventListener('online', handleOnline)
    return () => {
      cancelled.current = true
      window.clearInterval(intervalId)
      window.removeEventListener('online', handleOnline)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [school?.school_id, dataLoaded])

  useEffect(() => {
    if (!school || !isSupabaseConfigured) return undefined
    let mounted = true
    // Hydrate from the per-school IndexedDB snapshot first, then refresh from the cloud.
    readSchoolSnapshot(school.school_id).then((snapshot) => {
      if (!mounted) return
      if (snapshot) setData(snapshot)
      // Mark as loaded even when no snapshot exists yet (brand-new school) so sync can start.
      setDataLoaded(true)
    }).catch(() => setDataLoaded(true))
    return () => { mounted = false }
  }, [school?.school_id])

  useEffect(() => {
    if (!school || !isSupabaseConfigured || !isAdmin) return undefined
    let mounted = true
    const loadUnmatched = () => {
      supabase.from('unmatched_payments').select('*').eq('status', 'pending').then(({ data: rows }) => {
        if (mounted) setUnmatched(rows ?? [])
      })
    }
    loadUnmatched()
    const intervalId = window.setInterval(loadUnmatched, SYNC_POLL_MS)
    return () => {
      mounted = false
      window.clearInterval(intervalId)
    }
  }, [school?.school_id, isAdmin])

  useEffect(() => {
    if (!toast) return undefined
    const timeoutId = window.setTimeout(() => setToast(''), 3200)
    return () => window.clearTimeout(timeoutId)
  }, [toast])

  const commit = (change, operations = []) => {
    const next = change(data)
    setData(next)
    if (school && isSupabaseConfigured) {
      writeSchoolSnapshot(school.school_id, next).catch(() => {})
      if (operations.length) {
        persistSchoolMutation(school.school_id, next, operations).catch(() => {
          setToast('This device could not queue your changes for sync.')
        })
        setSyncState((current) => (current === 'synced' ? 'syncing' : current))
      }
    }
    try {
      window.localStorage.setItem(getStorageKey(school), JSON.stringify(next))
    } catch {
      setToast('This device could not save your changes.')
    }
  }
  const showPayment = (studentId = '') => {
    setPaymentDraft({ studentId: studentId || data.students[0]?.id || '', amount: '', date: new Date().toISOString().slice(0, 10), method: 'M-Pesa', code: '' })
    setModal('payment')
  }

  const saveStudent = (event) => {
    event.preventDefault()
    const student = { id: makeId(), startTermId: selectedTerm.id, ...studentDraft }
    const classId = data.classes?.find((item) => item.name === student.grade)?.id
    commit(
      (current) => ({ ...current, students: [...current.students, student] }),
      [{ operationId: makeId(), ...buildStudentOperation({ ...student, classId }, data.classes ?? []) }],
    )
    setStudentDraft({ admissionNumber: '', name: '', grade: 'Grade 1', guardianName: '', phone: '' })
    setModal(null)
    setToast(`${student.name} added`)
  }

  const savePayment = (event) => {
    event.preventDefault()
    const amount = Number(paymentDraft.amount)
    if (!Number.isFinite(amount) || amount <= 0 || !paymentDraft.studentId) return

    const payment = { id: makeId(), ...paymentDraft, amount, termId: selectedTerm.id }
    const updatedPayments = [...data.payments, payment]
    const student = data.students.find((item) => item.id === payment.studentId)
    const balance = getStudentBalance(student, selectedTerm.id, data.terms, updatedPayments, charges)
    const paidSoFar = getTermPaid(student.id, selectedTerm.id, updatedPayments)
    commit(
      (current) => ({ ...current, payments: updatedPayments }),
      [{ operationId: makeId(), ...buildPaymentOperation(payment) }],
    )
    setReceipt({ student, payment, balance, paidSoFar })
    setModal('receipt')
  }

  const saveFees = (event) => {
    event.preventDefault()
    commit((current) => ({
      ...current,
      terms: current.terms.map((term) => term.id === selectedTerm.id
        ? { ...term, fees: Object.fromEntries(GRADES.map((grade) => [grade, Number(feeDraft[grade] || 0)])) }
        : term),
    }))
    setModal(null)
    setToast('Fee structure saved')
  }

  const startNextTerm = () => {
    const lastTerm = data.terms.at(-1)
    const term = nextTermFrom(lastTerm)
    if (data.terms.some((item) => item.id === term.id)) {
      setToast(`${term.label} already exists`)
      return
    }
    commit(
      (current) => ({ ...current, terms: [...current.terms, term] }),
      buildTermOperations(term, data.classes ?? []).map((operation) => ({ operationId: makeId(), ...operation })),
    )
    setSelectedTermId(term.id)
    setFeeDraft({ ...term.fees })
    setToast(`${term.label} started. Unpaid balances carried forward.`)
  }

  const openFees = () => {
    setFeeDraft({ ...selectedTerm.fees })
    setModal('fees')
  }

  const shareReceipt = async () => {
    const text = `${data.schoolName}\nFee receipt for ${receipt.student.name}\nAmount: ${money(receipt.payment.amount)}\nDate: ${humanDate(receipt.payment.date)}\nPaid this term: ${money(receipt.paidSoFar)}\nAmount owed: ${money(receipt.balance)}`
    if (navigator.share) {
      try {
        await navigator.share({ title: 'School fee receipt', text })
      } catch {
        return
      }
    } else {
      await navigator.clipboard?.writeText(text)
      setToast('Receipt details copied')
    }
  }

  const autoMpesaPayments = termPayments.filter((payment) => payment.source === 'daraja_c2b')

  const assignUnmatched = async (unmatchedId, studentId) => {
    if (!supabase || !studentId) return
    const record = unmatched.find((item) => item.id === unmatchedId)
    if (!record) return
    const term = data.terms.find((item) => item.id === selectedTerm.id) ?? data.terms.at(-1)
    const payment = {
      id: makeId(),
      studentId,
      termId: term.id,
      amount: Number(record.amount),
      date: record.paid_at.slice(0, 10),
      method: 'M-Pesa',
      code: record.mpesa_receipt,
      reference: `Unmatched #${record.id.slice(0, 8)}`,
      source: 'daraja_c2b',
    }
    commit(
      (current) => ({ ...current, payments: [...current.payments, payment] }),
      [{ operationId: makeId(), ...buildPaymentOperation(payment) }],
    )
    const { error } = await supabase.rpc('assign_unmatched_payment', {
      target_school_id: school.school_id,
      target_unmatched_id: unmatchedId,
      target_student_id: studentId,
      target_term_id: term.id,
    })
    if (error) {
      setToast('Could not assign that payment. Try again.')
      return
    }
    setUnmatched((current) => current.filter((item) => item.id !== unmatchedId))
    setToast(`M-Pesa payment ${record.mpesa_receipt} assigned`)
  }

  const navItems = [
    { id: 'overview', label: 'Overview', icon: LayoutDashboard },
    { id: 'students', label: 'Students', icon: UsersRound },
    { id: 'fees', label: 'Fee structure', icon: BookOpenCheck },
    { id: 'payments', label: 'Payments', icon: WalletCards },
    ...(isAdmin && isSupabaseConfigured ? [{ id: 'inbox', label: 'Payments inbox', icon: Inbox, badge: unmatched.length }] : []),
    { id: 'history', label: 'Term history', icon: FileClock },
    ...(isAdmin ? [{ id: 'admin', label: 'Admin & audit', icon: ClipboardList }] : []),
    { id: 'settings', label: 'Settings', icon: Settings },
  ]

  const exportCsv = (filename, rows) => {
    if (!rows.length) { setToast('Nothing to export yet.'); return }
    const csv = [Object.keys(rows[0]).join(','), ...rows.map((row) => Object.values(row).map((value) => `"${String(value ?? '').replace(/"/g, '""')}"`).join(','))].join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    link.click()
    URL.revokeObjectURL(url)
    setToast(`${filename} exported`)
  }

  const exportStudents = () => {
    exportStudentsWorkbook(data, { termId: selectedTerm.id, charges })
    setToast('Students exported')
  }

  const exportPayments = () => {
    exportPaymentsWorkbook(data, { termId: selectedTerm.id })
    setToast('Payments exported')
  }

  const exportDefaulters = () => {
    exportDefaultersWorkbook(data, { termId: selectedTerm.id, charges })
    setToast('Defaulters list exported')
  }

  const [auditRows, setAuditRows] = useState([])
  useEffect(() => {
    if (view !== 'admin' || !isAdmin || !isSupabaseConfigured) return
    let mounted = true
    supabase.from('audit_log').select('action, entity, entity_id, before, after, created_at').order('created_at', { ascending: false }).limit(100)
      .then(({ data: rows }) => { if (mounted) setAuditRows(rows ?? []) })
    return () => { mounted = false }
  }, [view, isAdmin])

  const studentTable = (students, compact = false) => (
    <div className="table-scroll">
      <table className="student-table">
        <thead>
          <tr>
            <th>Student</th>
            <th>Class</th>
            <th>Paid this term</th>
            <th>Amount owed</th>
            <th>Status</th>
            <th><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {students.length ? students.slice(0, compact ? 6 : undefined).map((student, index) => {
            const balance = getStudentBalance(student, selectedTerm.id, data.terms, data.payments)
            const paid = getTermPaid(student.id, selectedTerm.id, data.payments)
            const status = balanceStatus(balance, selectedTerm.fees[student.grade])
            return (
              <tr key={student.id}>
                <td>
                  <div className="student-cell">
                    <span className={`avatar avatar-${index % 5}`}>{initials(student.name)}</span>
                    <span><strong>{student.name}</strong><small>{student.guardianName}</small></span>
                  </div>
                </td>
                <td>{student.grade}</td>
                <td>{money(paid)}</td>
                <td className={balance > 0 ? 'owed-amount' : 'paid-amount'}>{money(balance)}</td>
                <td><span className={`status-pill ${status.tone}`}><i />{status.text}</span></td>
                <td><button className="icon-button row-action" type="button" title={`Record payment for ${student.name}`} aria-label={`Record payment for ${student.name}`} onClick={() => showPayment(student.id)}><Plus size={16} /></button></td>
              </tr>
            )
          }) : (
            <tr><td colSpan="6" className="empty-row">No students match this search.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <span className="brand-mark"><GraduationCap size={22} strokeWidth={2.2} /></span>
          <span className="brand-name">Mwalimu<span>Ledger</span></span>
        </div>
        <div className="school-switcher">
          <span className="school-avatar">{initials(data.schoolName)}</span>
          {school && schools.length > 1 ? (
            <label className="school-name"><span className="sr-only">Switch school</span><select className="school-picker" value={school.school_id} onChange={(event) => onSwitchSchool?.(event.target.value)}>{schools.map((membership) => <option key={membership.school_id} value={membership.school_id}>{membership.name}</option>)}</select><small>{school.role === 'admin' ? 'Administrator' : 'Bursar'}</small></label>
          ) : <span className="school-name"><strong>{data.schoolName}</strong><small>{school ? (school.role === 'admin' ? 'Administrator' : 'Bursar') : 'School account'}</small></span>}
          {school && schools.length > 1 && <ChevronDown size={15} />}
        </div>
        {onAddSchool && <button className="add-school-button" type="button" onClick={onAddSchool}><Plus size={13} /> Add another school</button>}
        <p className="nav-caption">SCHOOL OFFICE</p>
        <nav className="primary-nav" aria-label="Main navigation">
          {navItems.map(({ id, label, icon: Icon }) => (
            <button key={id} className={`nav-link ${view === id ? 'active' : ''}`} type="button" onClick={() => setView(id)}>
              <Icon size={18} strokeWidth={1.9} /><span>{label}</span>
              {id === 'students' && <span className="nav-count">{data.students.length}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className={`storage-note sync-${SYNC_STATES[syncState]?.tone ?? 'local'}`}><span className="storage-dot" /><span>{SYNC_STATES[syncState]?.text ?? 'Saved on this device'}{queueStatus.needsAttention > 0 && <small>{queueStatus.needsAttention} change{queueStatus.needsAttention === 1 ? '' : 's'} need attention</small>}{queueStatus.pending > 0 && syncState !== 'needs_attention' && <small>{queueStatus.pending} change{queueStatus.pending === 1 ? '' : 's'} waiting to sync</small>}{queueStatus.needsAttention === 0 && queueStatus.pending === 0 && <small>{school ? 'Offline ready' : 'Offline ready · Cloud sync not connected'}</small>}</span></div>
          <div className="account-chip"><span className="account-avatar">{initials(userName)}</span><span><strong>{userName}</strong><small>{school ? school.role === 'admin' ? 'School administrator' : 'School bursar' : 'School administrator'}</small></span>{onSignOut && <button className="icon-button account-signout" type="button" title="Sign out" aria-label="Sign out" onClick={onSignOut}><LogOut size={16} /></button>}</div>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb"><span>School office</span><ArrowRight size={14} /><strong>{navItems.find((item) => item.id === view)?.label}</strong></div>
          <div className="topbar-actions">
            <div className={`connection-state ${isOnline ? 'online' : 'offline'}`}><span className="connection-icon">{isOnline ? <Signal size={15} /> : <SignalZero size={15} />}</span>{isOnline ? 'Online · saved locally' : 'Offline · saved locally'}</div>
            <label className="term-select-wrap" aria-label="Select school term">
              <CalendarDays size={16} />
              <select value={selectedTerm?.id ?? ''} onChange={(event) => setSelectedTermId(event.target.value)}>
                {[...data.terms].reverse().map((term) => <option key={term.id} value={term.id}>{term.label}</option>)}
              </select>
              <ChevronDown size={14} />
            </label>
          </div>
        </header>

        {isReadOnly && <div className="suspended-banner"><CircleAlert size={16} /><span>This school account is suspended. Records can be viewed, but changes are disabled.</span></div>}

        <main className="main-content">
          {view === 'overview' && (
            <>
              <section className="page-heading overview-heading">
                <div><p className="eyebrow">{selectedTerm.label} <span className="eyebrow-divider">/</span> FEE COLLECTION</p><h1>Good morning, {userName.split(' ')[0]}</h1><p className="heading-note">Here’s where things stand with school fees.</p></div>
                <button className="button button-primary" type="button" onClick={() => showPayment()} disabled={isReadOnly}><Plus size={17} /> Record a payment</button>
              </section>

              <section className="summary-grid" aria-label="Fee summary">
                <article className="summary-card collected-card"><div className="summary-label"><span>Collected this term</span><span className="summary-icon green-icon"><WalletCards size={19} /></span></div><strong className="summary-value">{money(collected)}</strong><div className="summary-foot"><span className="summary-marker collected-marker" />{termPayments.length} payments recorded</div></article>
                <article className="summary-card outstanding-card"><div className="summary-label"><span>Total amount owed</span><span className="summary-icon amber-icon"><CircleAlert size={19} /></span></div><strong className="summary-value">{money(outstanding)}</strong><div className="summary-foot"><span className="summary-marker attention-marker" />Across {data.students.length} students, including carried balances</div></article>
                <article className="summary-card students-card"><div className="summary-label"><span>Students on roll</span><span className="summary-icon navy-icon"><UsersRound size={19} /></span></div><strong className="summary-value">{String(data.students.length).padStart(2, '0')}</strong><div className="summary-foot"><span className="summary-marker students-marker" />Across {GRADES.length} classes</div></article>
              </section>

              <section className="collection-strip"><div className="strip-copy"><span className="strip-icon"><ClipboardList size={18} /></span><span><strong>Follow-up list</strong><small>Sorted by amount owed, highest first</small></span></div><span className="strip-total">{filteredStudents.filter((student) => getStudentBalance(student, selectedTerm.id, data.terms, data.payments) > 0).length} students need attention</span><button type="button" className="text-button" onClick={() => setView('students')}>View all <ArrowRight size={15} /></button></section>

              <section className="table-panel">
                <div className="panel-heading"><div><h2>Student balances</h2><p>Balances include unpaid fees carried over from previous terms.</p></div><div className="table-tools"><label className="search-field"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a student" aria-label="Search students" /></label><label className="select-field"><select value={gradeFilter} onChange={(event) => setGradeFilter(event.target.value)} aria-label="Filter by class"><option>All classes</option>{GRADES.map((grade) => <option key={grade}>{grade}</option>)}</select><ChevronDown size={14} /></label></div></div>
                {studentTable(filteredStudents, true)}
                <div className="table-footer"><span>Showing {Math.min(filteredStudents.length, 6)} of {filteredStudents.length} students</span><button className="text-button" type="button" onClick={() => setView('students')}>Open student list <ArrowRight size={15} /></button></div>
              </section>
              <p className="page-footnote"><span className="footnote-dot" /> All changes are saved on this device automatically.</p>
            </>
          )}

          {view === 'students' && (
            <>
              <section className="page-heading"><div><p className="eyebrow">SCHOOL RECORDS</p><h1>Students</h1><p className="heading-note">{data.students.length} students · Search or filter by class.</p></div><button className="button button-primary" type="button" onClick={() => setModal('student')} disabled={isReadOnly}><Plus size={17} /> Add student</button></section>
              <section className="table-panel full-panel"><div className="panel-heading"><div><h2>Student directory</h2><p>Parent and guardian details are kept with each student record.</p></div><div className="table-tools"><label className="search-field"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a student" aria-label="Search students" /></label><label className="select-field"><select value={gradeFilter} onChange={(event) => setGradeFilter(event.target.value)} aria-label="Filter by class"><option>All classes</option>{GRADES.map((grade) => <option key={grade}>{grade}</option>)}</select><ChevronDown size={14} /></label></div></div>{studentTable(filteredStudents)}</section>
            </>
          )}

          {view === 'fees' && (
            <>
              <section className="page-heading"><div><p className="eyebrow">SCHOOL SETUP</p><h1>Fee structure</h1><p className="heading-note">One total fee for each class and term.</p></div>{isAdmin && <div className="heading-actions"><button className="button button-outline" type="button" onClick={startNextTerm} disabled={isReadOnly}><CalendarDays size={16} /> Start next term</button><button className="button button-primary" type="button" onClick={openFees} disabled={isReadOnly}><Plus size={17} /> Edit fees</button></div>}</section>
              <section className="table-panel full-panel"><div className="panel-heading"><div><h2>{selectedTerm.label}</h2><p>Fee expected per student · Due {humanDate(selectedTerm.dueDate)}</p></div><span className="plain-tag"><BookOpenCheck size={15} /> {GRADES.length} classes</span></div><div className="fee-grid">{GRADES.map((grade, index) => <article className="fee-row" key={grade}><span className={`class-badge class-${index % 4}`}>{grade.replace('Grade ', 'G')}</span><span className="fee-class-name"><strong>{grade}</strong><small>{data.students.filter((student) => student.grade === grade).length} students</small></span><strong className="fee-amount">{money(selectedTerm.fees[grade])}</strong></article>)}</div><div className="fee-note"><CircleAlert size={16} /><span>Starting a new term copies these class fees. Unpaid student balances carry forward automatically.</span></div></section>
            </>
          )}

          {view === 'payments' && (
            <>
              <section className="page-heading"><div><p className="eyebrow">CASHBOOK</p><h1>Payments</h1><p className="heading-note">{selectedTerm.label} · {termPayments.length} payments recorded.</p></div><button className="button button-primary" type="button" onClick={() => showPayment()} disabled={isReadOnly}><Plus size={17} /> Record a payment</button></section>
              <section className="table-panel full-panel"><div className="panel-heading"><div><h2>Recent payments</h2><p>Each entry is kept against its term for accurate history.</p></div><span className="plain-tag">Collected {money(collected)}</span></div><div className="table-scroll"><table className="payment-table"><thead><tr><th>Student</th><th>Date</th><th>Method</th><th>M-Pesa code</th><th className="amount-heading">Amount paid</th><th /></tr></thead><tbody>{[...termPayments].sort((a, b) => b.date.localeCompare(a.date)).map((payment) => { const student = data.students.find((item) => item.id === payment.studentId); return <tr key={payment.id}><td><strong>{student?.name ?? 'Unknown student'}</strong><small>{student?.grade}</small></td><td>{humanDate(payment.date)}</td><td><span className={`method-dot ${payment.method === 'Cash' ? 'cash-dot' : ''}`} />{payment.method}</td><td className="code-cell">{payment.code || '—'}</td><td className="amount-heading"><strong>{money(payment.amount)}</strong></td><td><button className="icon-button" type="button" title="View receipt" aria-label={`View receipt for ${student?.name ?? 'student'}`} onClick={() => { const balance = getStudentBalance(student, selectedTerm.id, data.terms, data.payments); setReceipt({ student, payment, balance, paidSoFar: getTermPaid(student.id, selectedTerm.id, data.payments) }); setModal('receipt') }}><ArrowRight size={16} /></button></td></tr> })}{!termPayments.length && <tr><td className="empty-row" colSpan="6">No payments recorded in this term yet.</td></tr>}</tbody></table></div></section>
            </>
          )}

          {view === 'inbox' && (
            <>
              <section className="page-heading"><div><p className="eyebrow">M-PESA AUTOMATION</p><h1>Payments inbox</h1><p className="heading-note">Payments parents make to the school PayBill appear here automatically.</p></div><span className="plain-tag"><Inbox size={15} /> {unmatched.length} unmatched</span></section>
              <section className="table-panel full-panel"><div className="panel-heading"><div><h2>Auto-recorded M-Pesa payments</h2><p>Confirmed by Safaricom and matched to a student by admission number.</p></div></div><div className="table-scroll"><table className="payment-table"><thead><tr><th>Student</th><th>Date</th><th>M-Pesa code</th><th className="amount-heading">Amount</th></tr></thead><tbody>{autoMpesaPayments.length ? autoMpesaPayments.sort((a, b) => b.date.localeCompare(a.date)).map((payment) => { const student = data.students.find((item) => item.id === payment.studentId); return <tr key={payment.id}><td><strong>{student?.name ?? 'Unknown student'}</strong><small>{student?.grade}</small></td><td>{humanDate(payment.date)}</td><td className="code-cell">{payment.code || '—'}</td><td className="amount-heading"><strong>{money(payment.amount)}</strong></td></tr> }) : <tr><td className="empty-row" colSpan="4">No automatic M-Pesa payments this term yet.</td></tr>}</tbody></table></div></section>
              <section className="table-panel full-panel"><div className="panel-heading"><div><h2>Unmatched payments</h2><p>Payments the system could not match to an admission number. Assign them to a student.</p></div></div><div className="table-scroll"><table className="payment-table"><thead><tr><th>M-Pesa code</th><th>Account number given</th><th>Date</th><th className="amount-heading">Amount</th><th>Assign to</th></tr></thead><tbody>{unmatched.length ? unmatched.map((record) => <tr key={record.id}><td className="code-cell">{record.mpesa_receipt}</td><td>{record.bill_ref || '—'}</td><td>{humanDate(record.paid_at.slice(0, 10))}</td><td className="amount-heading"><strong>{money(record.amount)}</strong></td><td><select aria-label="Assign payment to student" value="" onChange={(event) => assignUnmatched(record.id, event.target.value)}><option value="">Choose student…</option>{data.students.map((student) => <option key={student.id} value={student.id}>{student.admissionNumber} · {student.name}</option>)}</select></td></tr>) : <tr><td className="empty-row" colSpan="5">Nothing waiting. All M-Pesa payments are matched.</td></tr>}</tbody></table></div></section>
            </>
          )}

          {view === 'admin' && (
            <>
              <section className="page-heading"><div><p className="eyebrow">SCHOOL ADMINISTRATION</p><h1>Admin &amp; audit</h1><p className="heading-note">Exports, activity log and account settings for {data.schoolName}.</p></div><div className="heading-actions"><button className="button button-outline" type="button" onClick={exportStudentsCsv}><Share2 size={16} /> Export students &amp; balances</button><button className="button button-outline" type="button" onClick={exportPaymentsCsv}><Share2 size={16} /> Export payments</button></div></section>
              <section className="table-panel full-panel"><div className="panel-heading"><div><h2>Audit log</h2><p>Last 100 recorded actions on this school's account.</p></div></div><div className="table-scroll"><table className="payment-table"><thead><tr><th>When</th><th>Action</th><th>Entity</th><th>Details</th></tr></thead><tbody>{auditRows.length ? auditRows.map((row) => <tr key={row.created_at + row.action}><td>{new Date(row.created_at).toLocaleString('en-KE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td><td><strong>{row.action}</strong></td><td>{row.entity}</td><td className="code-cell">{JSON.stringify(row.after ?? row.before ?? {})}</td></tr>) : <tr><td className="empty-row" colSpan="4">No audit entries yet{isSupabaseConfigured ? '' : ' (connect cloud sync to enable the audit log)'}.</td></tr>}</tbody></table></div></section>
            </>
          )}

          {view === 'history' && (
            <>
              <section className="page-heading"><div><p className="eyebrow">COLLECTION RECORDS</p><h1>Term history</h1><p className="heading-note">Past collections stay separate. Unpaid balances continue into the next term.</p></div></section>
              <section className="history-list">{[...data.terms].reverse().map((term) => { const totals = getTermTotals(term.id, data.students, data.terms, data.payments); const expected = data.students.reduce((sum, student) => sum + (term.fees[student.grade] ?? 0), 0); const pct = expected ? Math.min(100, Math.round((totals.collected / expected) * 100)) : 0; return <article className={`history-row ${term.id === selectedTerm.id ? 'current-history' : ''}`} key={term.id}><div className="history-date"><CalendarDays size={17} /><span>{term.label}</span>{term.id === selectedTerm.id && <span className="current-tag">VIEWING</span>}</div><div className="history-progress"><span><strong>{pct}%</strong> of this term’s fees collected</span><div className="progress-track"><span style={{ width: `${pct}%` }} /></div></div><div className="history-amounts"><span><small>Collected</small><strong>{money(totals.collected)}</strong></span><span><small>Balance at term end</small><strong className={totals.outstanding ? 'history-owed' : ''}>{money(totals.outstanding)}</strong></span></div><button className="icon-button history-open" title={`View ${term.label}`} aria-label={`View ${term.label}`} type="button" onClick={() => { setSelectedTermId(term.id); setView('overview') }}><ArrowRight size={17} /></button></article> })}</section>
            </>
          )}
        </main>
      </div>

      {modal === 'student' && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setModal(null) }}>
          <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="student-modal-title">
            <div className="modal-heading"><div><p className="eyebrow">SCHOOL RECORD</p><h2 id="student-modal-title">Add a student</h2></div><button className="icon-button" type="button" aria-label="Close" onClick={() => setModal(null)}><X size={19} /></button></div>
            <form onSubmit={saveStudent} className="form-stack">
              <label>Admission number<input autoFocus required value={studentDraft.admissionNumber} onChange={(event) => setStudentDraft({ ...studentDraft, admissionNumber: event.target.value.trim() })} placeholder="e.g. GA-024" /></label>
              <label>Student name<input required value={studentDraft.name} onChange={(event) => setStudentDraft({ ...studentDraft, name: event.target.value })} placeholder="e.g. Amina Wanjiku" /></label>
              <label>Class<select value={studentDraft.grade} onChange={(event) => setStudentDraft({ ...studentDraft, grade: event.target.value })}>{GRADES.map((grade) => <option key={grade}>{grade}</option>)}</select></label>
              <label>Parent or guardian<input required value={studentDraft.guardianName} onChange={(event) => setStudentDraft({ ...studentDraft, guardianName: event.target.value })} placeholder="Full name" /></label>
              <label>Parent phone number<input required type="tel" inputMode="tel" value={studentDraft.phone} onChange={(event) => setStudentDraft({ ...studentDraft, phone: event.target.value })} placeholder="07XX XXX XXX" /></label>
              <div className="modal-actions"><button type="button" className="button button-muted" onClick={() => setModal(null)}>Cancel</button><button type="submit" className="button button-primary"><Plus size={16} /> Add student</button></div>
            </form>
          </section>
        </div>
      )}

      {modal === 'payment' && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setModal(null) }}><section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="payment-modal-title"><div className="modal-heading"><div><p className="eyebrow">{selectedTerm.label}</p><h2 id="payment-modal-title">Record a payment</h2></div><button className="icon-button" type="button" aria-label="Close" onClick={() => setModal(null)}><X size={19} /></button></div><form onSubmit={savePayment} className="form-stack"><label>Student<select required value={paymentDraft.studentId} onChange={(event) => setPaymentDraft({ ...paymentDraft, studentId: event.target.value })}>{data.students.map((student) => <option key={student.id} value={student.id}>{student.name} · {student.grade}</option>)}</select></label><div className="form-pair"><label>Amount paid<input required min="1" step="1" type="number" inputMode="numeric" value={paymentDraft.amount} onChange={(event) => setPaymentDraft({ ...paymentDraft, amount: event.target.value })} placeholder="e.g. 5000" /></label><label>Date paid<input required type="date" value={paymentDraft.date} onChange={(event) => setPaymentDraft({ ...paymentDraft, date: event.target.value })} /></label></div><fieldset className="method-choice"><legend>Payment method</legend><label className={paymentDraft.method === 'M-Pesa' ? 'method-selected' : ''}><input type="radio" name="method" value="M-Pesa" checked={paymentDraft.method === 'M-Pesa'} onChange={(event) => setPaymentDraft({ ...paymentDraft, method: event.target.value })} /> M-Pesa</label><label className={paymentDraft.method === 'Cash' ? 'method-selected' : ''}><input type="radio" name="method" value="Cash" checked={paymentDraft.method === 'Cash'} onChange={(event) => setPaymentDraft({ ...paymentDraft, method: event.target.value })} /> Cash</label></fieldset>{paymentDraft.method === 'M-Pesa' && <label>M-Pesa code <span className="optional-label">optional</span><input value={paymentDraft.code} onChange={(event) => setPaymentDraft({ ...paymentDraft, code: event.target.value.toUpperCase() })} placeholder="e.g. QX12AB34C" /></label>}<div className="modal-actions"><button type="button" className="button button-muted" onClick={() => setModal(null)}>Cancel</button><button type="submit" className="button button-primary"><Check size={16} /> Save payment</button></div></form></section></div>}

      {modal === 'fees' && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setModal(null) }}><section className="modal-card fee-modal" role="dialog" aria-modal="true" aria-labelledby="fees-modal-title"><div className="modal-heading"><div><p className="eyebrow">{selectedTerm.label}</p><h2 id="fees-modal-title">Edit class fees</h2></div><button className="icon-button" type="button" aria-label="Close" onClick={() => setModal(null)}><X size={19} /></button></div><form onSubmit={saveFees} className="form-stack"><p className="modal-intro">Set the total amount due for each class this term.</p>{GRADES.map((grade) => <label className="fee-input-row" key={grade}><span>{grade}</span><span className="kes-input"><span>KES</span><input required min="0" step="100" type="number" value={feeDraft[grade] ?? ''} onChange={(event) => setFeeDraft({ ...feeDraft, [grade]: event.target.value })} /></span></label>)}<div className="modal-actions"><button type="button" className="button button-muted" onClick={() => setModal(null)}>Cancel</button><button type="submit" className="button button-primary"><Check size={16} /> Save fees</button></div></form></section></div>}

      {modal === 'receipt' && receipt && <div className="modal-backdrop receipt-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setModal(null) }}><section className="receipt-modal" role="dialog" aria-modal="true" aria-labelledby="receipt-title"><div className="receipt-top-actions"><button className="icon-button" type="button" title="Close" aria-label="Close" onClick={() => setModal(null)}><X size={19} /></button></div><div className="receipt-paper"><div className="receipt-brand"><span className="receipt-mark"><GraduationCap size={21} /></span><span><strong>{data.schoolName}</strong><small>School fees receipt</small></span></div><div className="receipt-success"><span><Check size={18} /></span><div><strong>Payment recorded</strong><small>{receipt.payment.method}{receipt.payment.code ? ` · ${receipt.payment.code}` : ''}</small></div></div><h2 id="receipt-title">Payment receipt</h2><div className="receipt-details"><div><span>Student</span><strong>{receipt.student.name}</strong></div><div><span>Class</span><strong>{receipt.student.grade}</strong></div><div><span>Date paid</span><strong>{humanDate(receipt.payment.date)}</strong></div><div><span>Term</span><strong>{selectedTerm.label}</strong></div></div><div className="receipt-paid"><span>Amount paid</span><strong>{money(receipt.payment.amount)}</strong></div><div className="receipt-balance"><span>Paid this term</span><strong>{money(receipt.paidSoFar)}</strong><span className="receipt-balance-line" /><span>Amount owed after payment</span><strong className={receipt.balance ? 'owed-amount' : 'paid-amount'}>{money(receipt.balance)}</strong></div><p className="receipt-reference">Receipt reference <span>{receipt.payment.id.slice(-8).toUpperCase()}</span></p></div><div className="receipt-actions"><button className="button button-outline" type="button" onClick={shareReceipt}><Share2 size={16} /> Share</button><button className="button button-primary" type="button" onClick={() => window.print()}><Printer size={16} /> Print receipt</button></div></section></div>}

      {toast && <div className="toast-message" role="status"><Check size={17} />{toast}<button type="button" aria-label="Dismiss message" onClick={() => setToast('')}><X size={15} /></button></div>}
    </div>
  )
}

export default App
