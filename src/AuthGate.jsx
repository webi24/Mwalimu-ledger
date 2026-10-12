import { useEffect, useState } from 'react'
import { supabase } from './supabaseClient.js'
import App from './App.jsx'
import './AuthGate.css'

function AuthGate() {
  const [session, setSession] = useState(null)
  const [schools, setSchools] = useState([])
  const [activeSchoolId, setActiveSchoolId] = useState('')
  const [screen, setScreen] = useState('sign-in')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [schoolName, setSchoolName] = useState('')
  const [creatingSchool, setCreatingSchool] = useState(false)

  useEffect(() => {
    if (!supabase) return undefined
    let mounted = true
    supabase.auth.getSession().then(({ data, error: sessionError }) => {
      if (!mounted) return
      if (sessionError) setError('Unable to restore your session. Please sign in again.')
      setSession(data?.session ?? null)
    })
    const { data: authListener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (mounted) setSession(nextSession)
    })
    return () => {
      mounted = false
      authListener.subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (!supabase || !session) return undefined

    let mounted = true
    supabase.rpc('get_my_schools').then(({ data, error: schoolsError }) => {
      if (!mounted) return
      if (schoolsError) {
        setError('We could not load this account’s school list.')
        return
      }
      const memberships = data ?? []
      setSchools(memberships)
      if (!memberships.length) {
        setScreen('register-school')
        return
      }
      const storageKey = `mwalimu-active-school:${session.user.id}`
      const savedSchoolId = window.localStorage.getItem(storageKey)
      const selectedSchoolId = memberships.some((school) => school.school_id === savedSchoolId)
        ? savedSchoolId
        : memberships[0].school_id
      setActiveSchoolId(selectedSchoolId)
      window.localStorage.setItem(storageKey, selectedSchoolId)
      setError('')
    })
    return () => { mounted = false }
  }, [session])

  useEffect(() => {
    if (!supabase || !session) return undefined
    const inviteToken = new URLSearchParams(window.location.search).get('invite')
    if (!inviteToken) return undefined

    let mounted = true
    supabase.rpc('accept_school_invitation', { invitation_token: inviteToken }).then(({ data, error: inviteError }) => {
      if (!mounted) return
      window.history.replaceState({}, '', window.location.pathname)
      if (inviteError) {
        setError('This invitation could not be accepted. Check that you signed in with the invited email address.')
        return
      }
      setNotice(`You joined ${data.school_name}.`)
      setActiveSchoolId(data.school_id)
      setSchools((current) => [...current.filter((school) => school.school_id !== data.school_id), {
        school_id: data.school_id,
        name: data.school_name,
        role: data.role,
        status: 'active',
      }])
    })
    return () => { mounted = false }
  }, [session])

  const handleAuth = async (event) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    setNotice('')

    const result = screen === 'sign-up'
      ? await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: {
            data: { name: name.trim() },
            emailRedirectTo: window.location.origin,
          },
        })
      : await supabase.auth.signInWithPassword({ email: email.trim(), password })

    setBusy(false)
    if (result.error) {
      setError(screen === 'sign-up'
        ? 'Account could not be created. Check the details and try again.'
        : 'Email or password was not recognized.')
      return
    }

    if (screen === 'sign-up' && !result.data.session) {
      setNotice('Check your email to verify the account, then sign in to register your school.')
      setScreen('sign-in')
      setPassword('')
      return
    }

    setSession(result.data.session)
  }

  const registerSchool = async (event) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    const { data, error: registrationError } = await supabase.rpc('register_school', {
      school_name: schoolName.trim(),
    })
    setBusy(false)
    if (registrationError) {
      setError(registrationError.message.includes('Verify your email')
        ? 'Verify your email before registering your school.'
        : registrationError.message.includes('already exists')
          ? 'You already have a school with this name. Check the school switcher, or pick a different name.'
          : 'School registration failed. Check the name and try again.')
      return
    }
    const membership = {
      school_id: data.school_id,
      name: data.name,
      status: data.status,
      trial_ends_at: data.trial_ends_at,
      role: data.role,
    }
    // Refresh the full school list from the server so a just-created school always appears.
    const { data: refreshed } = await supabase.rpc('get_my_schools')
    if (refreshed) setSchools(refreshed)
    else setSchools((current) => [...current, membership])
    setActiveSchoolId(membership.school_id)
    window.localStorage.setItem(`mwalimu-active-school:${session.user.id}`, membership.school_id)
    setScreen('sign-in')
    setCreatingSchool(false)
    setNotice(`Welcome to ${membership.name}. Your school is ready.`)
  }

  const signOut = async () => {
    await supabase.auth.signOut()
    setSchools([])
    setActiveSchoolId('')
    setSession(null)
    setCreatingSchool(false)
  }

  const startCreateSchool = () => {
    setError('')
    setSchoolName('')
    setCreatingSchool(true)
  }

  if (!supabase) return <App />

  if (!session) {
    return (
      <main className="auth-page">
        <section className="auth-panel">
          <div className="auth-brand"><span className="auth-brand-mark">M</span><span>Mwalimu<span>Ledger</span></span></div>
          <p className="auth-eyebrow">SCHOOL FEES, IN GOOD ORDER</p>
          <h1>{screen === 'sign-up' ? 'Create your account' : 'Welcome back'}</h1>
          <p className="auth-intro">{screen === 'sign-up' ? 'Set up a secure account for your school office.' : 'Sign in to open your school’s fee records.'}</p>
          {notice && <p className="auth-notice" role="status">{notice}</p>}
          {error && <p className="auth-error" role="alert">{error}</p>}
          <form className="auth-form" onSubmit={handleAuth}>
            {screen === 'sign-up' && <label>Your name<input required autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} /></label>}
            <label>Email address<input required type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
            <label>Password<input required type="password" minLength="8" autoComplete={screen === 'sign-up' ? 'new-password' : 'current-password'} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
            <button className="button button-primary auth-submit" type="submit" disabled={busy}>{busy ? 'Please wait…' : screen === 'sign-up' ? 'Create account' : 'Sign in'}</button>
          </form>
          <p className="auth-switch">{screen === 'sign-up' ? 'Already have an account?' : 'New to Mwalimu Ledger?'} <button type="button" onClick={() => { setScreen(screen === 'sign-up' ? 'sign-in' : 'sign-up'); setError(''); setNotice('') }}>{screen === 'sign-up' ? 'Sign in' : 'Create account'}</button></p>
          {screen === 'sign-in' && <button className="landing-register-link" type="button" onClick={() => setScreen('sign-up')}>Register a new school →</button>}
          <p className="auth-privacy">School records are separated by verified school membership.</p>
        </section>
      </main>
    )
  }

  if (screen === 'register-school' || schools.length === 0 || creatingSchool) {
    return (
      <main className="auth-page">
        <section className="auth-panel">
          <div className="auth-brand"><span className="auth-brand-mark">M</span><span>Mwalimu<span>Ledger</span></span></div>
          <p className="auth-eyebrow">ONE SCHOOL, ONE PRIVATE SPACE</p>
          <h1>{creatingSchool ? 'Add another school' : 'Register your school'}</h1>
          <p className="auth-intro">{creatingSchool
            ? `This creates a second school under ${session.user.email}. You'll switch between them from the sidebar.`
            : `This creates a new, isolated school account linked to ${session.user.email}.`}</p>
          {error && <p className="auth-error" role="alert">{error}</p>}
          <form className="auth-form" onSubmit={registerSchool}>
            <label>School name<input required minLength="2" maxLength="120" value={schoolName} onChange={(event) => setSchoolName(event.target.value)} placeholder="e.g. Greenfield Academy" /></label>
            <button className="button button-primary auth-submit" type="submit" disabled={busy}>{busy ? 'Registering…' : creatingSchool ? 'Create school' : 'Register school'}</button>
          </form>
          <p className="auth-switch">{creatingSchool
            ? <button type="button" onClick={() => { setCreatingSchool(false); setError('') }}>Back to my schools</button>
            : <button type="button" onClick={signOut}>Sign out</button>}</p>
        </section>
      </main>
    )
  }

  const activeSchool = schools.find((school) => school.school_id === activeSchoolId)
  if (!activeSchool) return <main className="auth-page"><p className="auth-intro">Loading school…</p></main>

  return (
    <>
      {notice && <div className="auth-toast" role="status">{notice}<button type="button" onClick={() => setNotice('')}>Dismiss</button></div>}
      <App
        key={activeSchool.school_id}
        school={activeSchool}
        schools={schools}
        user={session.user}
        onSwitchSchool={(schoolId) => {
          setActiveSchoolId(schoolId)
          window.localStorage.setItem(`mwalimu-active-school:${session.user.id}`, schoolId)
        }}
        onAddSchool={startCreateSchool}
        onSignOut={signOut}
      />
    </>
  )
}

export default AuthGate
