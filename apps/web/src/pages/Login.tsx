import { FormEvent, useState } from 'react';
import { api, setToken } from '../api';
import { useData, useSession } from '../lib';

export default function Login() {
  const { setSession } = useSession();
  const providers = useData<{ local: boolean; oidc: { name: string } | null }>('/auth/providers');
  const params = new URLSearchParams(location.search);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(params.get('error') ?? '');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const r = await api('/auth/login', { method: 'POST', json: { email, password } });
      setToken(r.accessToken);
      setSession({ user: r.user, mustChangePassword: r.mustChangePassword });
      history.replaceState(null, '', '/');
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  const p = providers.data;
  return (
    <div className="login">
      <div className="login-card">
        <img className="logo" src="/ecews-logo.png" alt="ECEWS — Excellence Community Education Welfare Scheme" />
        <h1>TalentScreen</h1>
        <p className="tagline">…Improving Education and Health in Nigeria</p>
        {p?.oidc && <a className="btn primary" style={{ justifyContent: 'center' }} href="/api/auth/oidc/login">Sign in with {p.oidc.name}</a>}
        {p?.oidc && p.local && <div className="divider">or use your password</div>}
        {(p?.local ?? true) && (
          <form className="stack" onSubmit={submit}>
            <label className="f">Work email<input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
            <label className="f">Password<input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
            {error && <div className="error" role="alert">{error}</div>}
            <button className="btn primary" style={{ justifyContent: 'center' }} disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
          </form>
        )}
        <p className="muted small" style={{ textAlign: 'center', margin: 0 }}>Access is limited to authorised ECEWS staff. Activity is logged.</p>
      </div>
    </div>
  );
}
