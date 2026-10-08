import { useState } from 'react';
import { patch, post } from '../api';
import { fmtDateTime, initials, useAction, useData, useSession } from '../lib';
import { Drawer, ErrorBox, Loading, PageHead } from '../ui';

export default function Users() {
  const { session } = useSession();
  const { data, error, reload } = useData<any[]>('/users');
  const roles = useData<any[]>('/roles');
  const depts = useData<any[]>('/departments');
  const [adding, setAdding] = useState(false);
  const [resetFor, setResetFor] = useState<any>(null);
  const { busy, run } = useAction();
  const update = async (id: string, body: any, msg: string) => { await run(() => patch(`/users/${id}`, body), msg); reload(); };
  return (
    <>
      <PageHead eyebrow="Administration" title="Users"><button className="btn primary" onClick={() => setAdding(true)}>Add user</button></PageHead>
      {error && <ErrorBox error={error} />}
      {!data ? <Loading /> : (
        <div className="tbl-wrap"><table>
          <thead><tr><th>Name</th><th>Sign-in</th><th>Department</th><th>Role</th><th>Last sign-in</th><th>Status</th><th></th></tr></thead>
          <tbody>{data.map((u) => {
            const self = u.id === session!.user.id;
            return (
              <tr key={u.id}>
                <td><div className="row" style={{ flexWrap: 'nowrap', gap: 8 }}><div className="avatar">{initials(u.full_name)}</div><div><b>{u.full_name}</b><div className="muted small">{u.email}</div></div></div></td>
                <td>{u.auth_provider === 'oidc' ? 'Entra ID / SSO' : 'Password'}</td>
                <td><select id={'d' + u.id} style={{ width: 'auto' }} value={u.department_id ?? ''} onChange={(e) => update(u.id, { departmentId: e.target.value || null }, 'Department updated')}>
                  <option value="">—</option>{(depts.data ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></td>
                <td><select id={'r' + u.id} style={{ width: 'auto' }} disabled={self} value={u.role_key} onChange={(e) => update(u.id, { roleKey: e.target.value }, 'Role updated')}>
                  {(roles.data ?? []).map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}</select></td>
                <td className="small" style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(u.last_login_at)}</td>
                <td>{u.is_active ? <span className="pill p-open">Active</span> : <span className="pill p-Reject">Suspended</span>}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {!self && <button className="btn sm" disabled={busy} onClick={() => update(u.id, { isActive: !u.is_active }, u.is_active ? 'User suspended; sessions ended' : 'User reactivated')}>{u.is_active ? 'Suspend' : 'Reactivate'}</button>}{' '}
                  <button className="btn sm ghost" onClick={() => setResetFor(u)}>Set password</button>
                </td>
              </tr>
            );
          })}</tbody>
        </table></div>
      )}
      {adding && <AddUser roles={roles.data ?? []} depts={depts.data ?? []} onClose={() => setAdding(false)} onDone={() => { setAdding(false); reload(); }} />}
      {resetFor && <ResetPassword user={resetFor} onClose={() => setResetFor(null)} />}
    </>
  );
}

function AddUser({ roles, depts, onClose, onDone }: { roles: any[]; depts: any[]; onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction();
  const [f, setF] = useState({ fullName: '', email: '', roleKey: 'viewer', departmentId: '', sso: true, password: '' });
  const submit = async () => {
    const r = await run(() => post('/users', { fullName: f.fullName, email: f.email, roleKey: f.roleKey, departmentId: f.departmentId || undefined, password: f.sso ? undefined : f.password }), 'User added');
    if (r) onDone();
  };
  return (
    <Drawer title="Add user" onClose={onClose}>
      <div className="form-grid">
        <label className="f">Full name<input id="nu_name" value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} /></label>
        <label className="f">Work email<input id="nu_email" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} placeholder="name@ecews.org" /></label>
        <label className="f">Role<select id="nu_role" value={f.roleKey} onChange={(e) => setF({ ...f, roleKey: e.target.value })}>{roles.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}</select></label>
        <label className="f">Department<select id="nu_dept" value={f.departmentId} onChange={(e) => setF({ ...f, departmentId: e.target.value })}><option value="">—</option>{depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
        <label className="check wide"><input type="checkbox" checked={f.sso} onChange={(e) => setF({ ...f, sso: e.target.checked })} />Signs in with Microsoft Entra ID (no password stored here)</label>
        {!f.sso && <label className="f wide">Temporary password<input id="nu_pwd" type="text" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
          <small>At least 12 characters with upper- and lower-case letters and a number. They must change it at first sign-in.</small></label>}
      </div>
      <div><button className="btn primary" disabled={busy || !f.fullName || !f.email} onClick={submit}>Add user</button></div>
    </Drawer>
  );
}

function ResetPassword({ user, onClose }: { user: any; onClose: () => void }) {
  const { busy, run } = useAction();
  const [pwd, setPwd] = useState('');
  return (
    <Drawer eyebrow="Set temporary password" title={user.full_name} onClose={onClose}>
      <p className="muted" style={{ margin: 0 }}>Their current sessions end, and they must choose a new password at next sign-in. Use this for password accounts; SSO users reset in Entra ID.</p>
      <label className="f">Temporary password<input id="tmp" type="text" value={pwd} onChange={(e) => setPwd(e.target.value)} /></label>
      <div><button className="btn primary" disabled={busy || pwd.length < 12} onClick={async () => { const r = await run(async () => { await post(`/users/${user.id}/reset-password`, { password: pwd }); return true; }, 'Temporary password set'); if (r) onClose(); }}>Set password</button></div>
    </Drawer>
  );
}
