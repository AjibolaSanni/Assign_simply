import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowLeft, ArrowRight, Eye, EyeOff, LockKeyhole, Mail, UserRound } from 'lucide-react'
import Brand from '../components/Brand'
import { useAuth } from '../contexts/AuthContext'
import { register, requestPasswordReset, signIn, updatePassword } from '../services/authService'

const copy = {
  login: { eyebrow: 'YOUR CAMPUS, IN SYNC', title: 'Make room for\nyour best work.', detail: 'Coursework, deadlines, and feedback — all in one calm, clear space.' },
  register: { eyebrow: 'START YOUR JOURNEY', title: 'A better rhythm\nfor your studies.', detail: 'Keep every course, assignment, and important deadline close at hand.' },
  forgot: { eyebrow: 'ACCOUNT RECOVERY', title: 'Let’s get you\nback on track.', detail: 'We’ll send a secure link to your inbox so you can choose a new password.' },
  reset: { eyebrow: 'ACCOUNT RECOVERY', title: 'A fresh start,\njust one step away.', detail: 'Choose a new password to secure your AssignSimply account.' },
}

function friendlyError(error) {
  if (!error) return 'Something went wrong. Please try again.'
  const message = error.message?.toLowerCase() || ''
  if (message.includes('email rate limit') || error.code === 'over_email_send_rate_limit') {
    return 'Supabase has temporarily limited confirmation emails. Wait before trying again. For regular signups, configure a custom SMTP provider in Supabase Authentication settings; the built-in email provider is limited to two emails per hour.'
  }
  if (message.includes('fetch')) return 'We could not reach the service. Check your connection and try again.'
  return error.message || 'Something went wrong. Please try again.'
}

function Field({ label, icon: Icon, type = 'text', value, onChange, placeholder, autoComplete, trailing, minLength }) {
  return <label className="field"><span className="field-label">{label}</span><span className="input-wrap"><Icon className="input-icon" size={18} aria-hidden="true" /><input type={type} value={value} onChange={onChange} placeholder={placeholder} autoComplete={autoComplete} minLength={minLength} required />{trailing}</span></label>
}

export default function AuthPage({ mode }) {
  const [values, setValues] = useState({ fullName: '', email: '', password: '', confirm: '' })
  const [showPassword, setShowPassword] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const { configured } = useAuth()
  const navigate = useNavigate()
  const text = copy[mode]
  const update = (key) => (event) => setValues((old) => ({ ...old, [key]: event.target.value }))
  const passwordToggle = <button className="icon-button password-toggle" type="button" onClick={() => setShowPassword((visible) => !visible)} aria-label={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? <EyeOff size={18} /> : <Eye size={18} />}</button>

  async function submit(event) {
    event.preventDefault(); setError(''); setSuccess('')
    if (mode === 'register' && values.password !== values.confirm) { setError('Your passwords do not match.'); return }
    setPending(true)
    try {
      if (mode === 'login') { await signIn(values.email, values.password); navigate('/app') }
      if (mode === 'register') {
        const data = await register(values)
        if (data.session) navigate('/app')
        else setSuccess('Your account is ready. Check your email to confirm your address, then sign in.')
      }
      if (mode === 'forgot') { await requestPasswordReset(values.email); setSuccess('If an account exists for this email, a password reset link is on its way.') }
      if (mode === 'reset') { await updatePassword(values.password); setSuccess('Password updated. You can now sign in with your new password.'); setTimeout(() => navigate('/login'), 1200) }
    } catch (caught) { setError(friendlyError(caught)) } finally { setPending(false) }
  }

  return <main className="auth-page">
    <section className="story-panel" aria-label="About AssignSimply">
      <div className="story-top"><Brand /><span className="campus-pill"><span /> A calmer campus</span></div>
      <div className="story-content"><p className="eyebrow">{text.eyebrow}</p><h1>{text.title.split('\n').map((line, i) => <span key={line}>{i > 0 && <br />}{line}</span>)}</h1><p className="story-detail">{text.detail}</p>
        <div className="orbit-art" aria-hidden="true"><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="orbit-core"><div className="orbit-sheet"><span/><span/><span/></div></div><span className="spark spark-one">✦</span><span className="spark spark-two">✳</span><span className="float-dot dot-one"/><span className="float-dot dot-two"/></div>
      </div>
      <div className="story-footer"><span className="footer-line"/><span>Simplifying assignments. Empowering learning.</span><span className="footer-index">01 <i/> 03</span></div>
    </section>
    <section className="form-panel">
      <div className="mobile-brand"><Brand /></div>
      <div className="form-shell">
        <div className="form-heading"><div className="form-mark"><LockKeyhole size={20}/></div><p className="eyebrow">{mode === 'login' ? 'WELCOME BACK' : mode === 'register' ? 'CREATE YOUR ACCOUNT' : 'SECURE YOUR ACCOUNT'}</p><h2>{mode === 'login' ? 'Sign in to AssignSimply' : mode === 'register' ? 'Create your account' : mode === 'forgot' ? 'Forgot your password?' : 'Set a new password'}</h2><p className="form-subtitle">{mode === 'login' ? 'Enter your details to continue to your workspace.' : mode === 'register' ? 'Join your academic community in just a moment.' : mode === 'forgot' ? 'Enter your email and we’ll send you a reset link.' : 'Use at least 8 characters for your new password.'}</p></div>
        {!configured && <div className="notice" role="status"><strong>Supabase setup needed</strong><span>Add your project URL and publishable key to <code>.env</code> to enable account access.</span></div>}
        <form className="auth-form" onSubmit={submit}>
          {mode === 'register' && <Field label="Full name" icon={UserRound} value={values.fullName} onChange={update('fullName')} placeholder="e.g. Alex Morgan" autoComplete="name" />}
          {(mode !== 'reset') && <Field label="Email address" icon={Mail} type="email" value={values.email} onChange={update('email')} placeholder="you@university.edu" autoComplete="email" />}
          {(mode === 'login' || mode === 'register' || mode === 'reset') && <Field label="Password" icon={LockKeyhole} type={showPassword ? 'text' : 'password'} value={values.password} onChange={update('password')} placeholder={mode === 'login' ? 'Enter your password' : 'At least 8 characters'} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={8} trailing={passwordToggle} />}
          {mode === 'register' && <Field label="Confirm password" icon={LockKeyhole} type={showPassword ? 'text' : 'password'} value={values.confirm} onChange={update('confirm')} placeholder="Enter your password again" autoComplete="new-password" minLength={8} />}
          {mode === 'forgot' && <p className="privacy-note">For your security, we’ll show the same confirmation whether or not this email has an account.</p>}
          {mode === 'login' && <div className="form-options"><label className="check-label"><input type="checkbox"/><span className="checkmark"/> Remember me</label><Link to="/forgot-password">Forgot password?</Link></div>}
          {error && <div className="alert alert-error" role="alert">{error}</div>}{success && <div className="alert alert-success" role="status">{success}</div>}
          <button className="submit-button" type="submit" disabled={pending || !configured}><span>{pending ? 'Please wait…' : mode === 'login' ? 'Sign in' : mode === 'register' ? 'Create account' : mode === 'forgot' ? 'Send reset link' : 'Update password'}</span>{!pending && <ArrowRight size={18}/>}</button>
        </form>
        <div className="form-bottom">{mode === 'login' ? <>New to AssignSimply? <Link to="/register">Create an account <ArrowRight size={14}/></Link></> : mode === 'register' ? <>Already have an account? <Link to="/login">Sign in <ArrowRight size={14}/></Link></> : <Link className="back-link" to="/login"><ArrowLeft size={15}/> Back to sign in</Link>}</div>
      </div>
      <div className="legal-line"><span>© 2026 AssignSimply</span><span><i/> Your learning space, thoughtfully organised</span></div>
    </section>
  </main>
}
