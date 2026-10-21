import { FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { papi, setApplicantToken, usePortalSession } from '../../portal';
import { useToast } from '../../lib';
import PortalLayout from './PortalLayout';

export default function PortalLogin() {
  const isRegister = location.pathname === '/portal/register';
  const { setApplicant } = usePortalSession();
  const toast = useToast();
  const nav = useNavigate();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const path = isRegister ? '/register' : '/login';
      const body: any = { email, password };
      if (isRegister) body.fullName = fullName;
      const r = await papi(path, { method: 'POST', json: body });
      setApplicantToken(r.accessToken);
      setApplicant(r.applicant);
      toast(isRegister ? 'Account created' : 'Signed in');
      nav('/portal/profile');
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  return (
    <PortalLayout>
      <div className="login-card" style={{ maxWidth: 440, margin: '40px auto' }}>
        <h1>{isRegister ? 'Create your account' : 'Sign in'}</h1>
        <p className="muted small" style={{ marginTop: 0 }}>{isRegister ? 'Apply for roles at ECEWS in minutes.' : 'Track your applications and manage your CV.'}</p>
        <form className="stack" onSubmit={submit}>
          {isRegister && <label className="f">Full name<input id="name" value={fullName} onChange={(e) => setFullName(e.target.value)} required minLength={2} /></label>}
          <label className="f">Email<input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
          <label className="f">Password<input id="password" type="password" autoComplete={isRegister ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} required minLength={12} />
            {isRegister && <small>At least 12 characters with upper, lower and a number.</small>}</label>
          {error && <div className="error" role="alert">{error}</div>}
          <button className="btn primary" style={{ justifyContent: 'center' }} disabled={busy}>{busy ? 'Please wait…' : isRegister ? 'Create account' : 'Sign in'}</button>
        </form>
        <p className="muted small" style={{ textAlign: 'center', marginBottom: 0 }}>
          {isRegister ? <>Already registered? <Link to="/portal/login">Sign in</Link></> : <>New here? <Link to="/portal/register">Create an account</Link></>}
        </p>
      </div>
    </PortalLayout>
  );
}
