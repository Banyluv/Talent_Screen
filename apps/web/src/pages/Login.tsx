import { FormEvent, useEffect, useState } from 'react';
import { api, apiBase, setToken } from '../api';
import { useData, useSession } from '../lib';
import { Icon } from '../ui';

export default function Login() {
  const { setSession } = useSession();
  const providers = useData<{ local: boolean; oidc: { name: string } | null }>('/auth/providers');
  const params = new URLSearchParams(location.search);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState(params.get('error') ?? '');
  const [busy, setBusy] = useState(false);

  // The sign-in screen is always light, so point the browser chrome at the light palette.
  useEffect(() => {
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#1E4634');
  }, []);

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
        {p?.oidc && <a className="btn primary" style={{ justifyContent: 'center' }} href={apiBase + '/api/auth/oidc/login'}>Sign in with {p.oidc.name}</a>}
        {p?.oidc && p.local && <div className="divider">or use your password</div>}
        {(p?.local ?? true) && (
          <form className="stack" onSubmit={submit}>
            <label className="f">Work email<input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
            <label className="f">Password
              <span className="pw">
                <input id="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
                <button
                  type="button"
                  className="pw-toggle"
                  onClick={(e) => { e.preventDefault(); setShowPassword((v) => !v); }}
                  aria-pressed={showPassword}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  title={showPassword ? 'Hide password' : 'Show password'}
                >{showPassword ? Icon.eyeOff : Icon.eye}</button>
              </span>
            </label>
            {error && <div className="error" role="alert">{error}</div>}
            <button className="btn primary" style={{ justifyContent: 'center' }} disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
          </form>
        )}
        <p className="muted small" style={{ textAlign: 'center', margin: 0 }}>Access is limited to authorised ECEWS staff. Activity is logged.</p>
      </div>
    </div>
  );
}
