import { useEffect, useState } from 'react';
import { post, put } from '../api';
import { useAction, useData } from '../lib';
import { Drawer, ErrorBox, Loading, PageHead } from '../ui';

export default function Roles() {
  const roles = useData<any[]>('/roles');
  const perms = useData<any[]>('/permissions');
  const [edit, setEdit] = useState<Record<string, string[]>>({});
  const [creating, setCreating] = useState(false);
  const { busy, run } = useAction();
  useEffect(() => { if (roles.data) setEdit(Object.fromEntries(roles.data.map((r) => [r.key, [...r.permissions]]))); }, [roles.data]);
  if (roles.error) return <ErrorBox error={roles.error} />;
  if (!roles.data || !perms.data) return <Loading />;
  const dirty = roles.data.filter((r) => JSON.stringify([...edit[r.key] ?? []].sort()) !== JSON.stringify([...r.permissions].sort()));
  const toggle = (role: string, p: string) => setEdit((e) => ({ ...e, [role]: e[role].includes(p) ? e[role].filter((x) => x !== p) : [...e[role], p] }));
  const save = async () => {
    for (const r of dirty) await run(() => put(`/roles/${r.key}`, { permissions: edit[r.key] }));
    roles.reload();
  };
  const cats = [...new Set(perms.data.map((p) => p.category))];
  return (
    <>
      <PageHead eyebrow="Administration" title="Roles and permissions">
        <button className="btn" onClick={() => setCreating(true)}>New role</button>
        <button className="btn primary" disabled={busy || !dirty.length} onClick={save}>{dirty.length ? `Save ${dirty.length} change${dirty.length > 1 ? 's' : ''}` : 'No changes'}</button>
      </PageHead>
      <p className="muted" style={{ margin: 0 }}>Changes apply on each user's next request; no sign-out needed. Super Administrator always keeps user and role management.</p>
      <div className="tbl-wrap"><table className="matrix">
        <thead><tr><th>Permission</th>{roles.data.map((r) => <th key={r.key} title={r.description}>{r.name}<div className="muted" style={{ textTransform: 'none', letterSpacing: 0 }}>{r.user_count} user{r.user_count === 1 ? '' : 's'}</div></th>)}</tr></thead>
        <tbody>{cats.map((c) => [
          <tr key={c}><td colSpan={roles.data!.length + 1} style={{ background: 'var(--bg)', fontWeight: 600 }}>{c}</td></tr>,
          ...perms.data!.filter((p) => p.category === c).map((p) => (
            <tr key={p.key}><td>{p.description}<div className="muted small mono">{p.key}</div></td>
              {roles.data!.map((r) => <td key={r.key}><input type="checkbox" aria-label={`${r.name}: ${p.description}`} checked={edit[r.key]?.includes(p.key) ?? false} onChange={() => toggle(r.key, p.key)} /></td>)}</tr>
          )),
        ])}</tbody>
      </table></div>
      {creating && <NewRole onClose={() => setCreating(false)} onDone={() => { setCreating(false); roles.reload(); }} busy={busy} run={run} />}
    </>
  );
}

function NewRole({ onClose, onDone, busy, run }: any) {
  const [f, setF] = useState({ key: '', name: '', description: '' });
  return (
    <Drawer title="New role" onClose={onClose}>
      <div className="form-grid">
        <label className="f">Name<input id="rn" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value, key: f.key || e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') })} /></label>
        <label className="f">Key<input id="rk" value={f.key} onChange={(e) => setF({ ...f, key: e.target.value })} /><small>Lower-case; must match the Entra app role value if you use SSO role mapping.</small></label>
        <label className="f wide">Description<input id="rd" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
      </div>
      <p className="muted small" style={{ margin: 0 }}>The role starts with no permissions; tick them in the matrix after creating it.</p>
      <div><button className="btn primary" disabled={busy || !f.key || !f.name} onClick={async () => { const r = await run(() => post('/roles', { ...f, permissions: [] }), 'Role created'); if (r) onDone(); }}>Create role</button></div>
    </Drawer>
  );
}
