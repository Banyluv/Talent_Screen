import { FormEvent, useState } from 'react';
import { post } from '../api';
import { useAction, useSession } from '../lib';
import { PageHead } from '../ui';

export default function Account({ forced }: { forced?: boolean }) {
  const { session, signOut } = useSession();
  const { busy, run } = useAction();
  const [cur, setCur] = useState(''); const [next, setNext] = useState(''); const [again, setAgain] = useState('');
  const [err, setErr] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault(); setErr('');
    if (next !== again) { setErr('The new passwords do not match'); return; }
    // a successful change revokes every session server-side, so sign in again with the new password
    const done = await run(async () => { await post('/auth/change-password', { current: cur, next }); return true; }, 'Password changed. Sign in again.');
    if (done) signOut();
  }
  const u = session!.user;
  return (
    <div className="stack" style={{ maxWidth: 520 }}>
      {forced ? <><h1>Set a new password</h1><p className="muted" style={{ margin: 0 }}>Your account uses a temporary password. Choose your own to continue.</p></>
        : <PageHead eyebrow="Account" title={u.name} />}
      {!forced && (
        <div className="panel"><div className="list">
          <div><span className="muted" style={{ width: 110 }}>Email</span><b>{u.email}</b></div>
          <div><span className="muted" style={{ width: 110 }}>Role</span><b>{u.roleName}</b></div>
          <div><span className="muted" style={{ width: 110 }}>Permissions</span><span>{u.permissions.map((p) => <span key={p} className="tag">{p}</span>)}</span></div>
        </div></div>
      )}
      <form className="panel stack" onSubmit={submit}>
        {!forced && <h2>Change password</h2>}
        <label className="f">Current password<input id="cur" type="password" required value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" /></label>
        <label className="f">New password<input id="next" type="password" required value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
          <small>At least 12 characters, with upper- and lower-case letters and a number.</small></label>
        <label className="f">Repeat new password<input id="again" type="password" required value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" /></label>
        {err && <div className="error">{err}</div>}
        <div className="row"><button className="btn primary" disabled={busy}>Change password</button>{forced && <button type="button" className="btn ghost" onClick={signOut}>Sign out</button>}</div>
        <p className="muted small" style={{ margin: 0 }}>Accounts that sign in with Microsoft Entra ID manage their password there.</p>
      </form>
    </div>
  );
}
