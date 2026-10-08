import { useState } from 'react';
import { download } from '../api';
import { fmtDateTime, useAction, useData } from '../lib';
import { ErrorBox, Loading, PageHead } from '../ui';

export default function Audit() {
  const [q, setQ] = useState('');
  const { data, error } = useData<any[]>('/audit?limit=500' + (q.length > 1 ? `&q=${encodeURIComponent(q)}` : ''));
  const verify = useData<any>('/audit/verify');
  const { busy, run } = useAction();
  return (
    <>
      <PageHead eyebrow="Administration" title="Audit log">
        <input id="aq" type="search" placeholder="Filter by action, user or detail" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 'min(300px, 100%)' }} />
        <button className="btn" disabled={busy} onClick={() => run(() => download('/audit/export', 'audit.csv'))}>Export CSV</button>
      </PageHead>
      {verify.data && (verify.data.ok
        ? <div className="note">Integrity check passed: {verify.data.checked} entries, hash chain intact. Entries cannot be edited or deleted.</div>
        : <div className="note warn"><b>Integrity check failed at entry {verify.data.brokenAt}.</b> The log may have been altered outside the application. Investigate immediately.</div>)}
      {error && <ErrorBox error={error} />}
      {!data ? <Loading /> : (
        <div className="tbl-wrap"><table>
          <thead><tr><th>Time</th><th>User</th><th>Action</th><th>Record</th><th>Details</th><th>IP</th></tr></thead>
          <tbody>{data.map((a) => (
            <tr key={a.id}>
              <td className="mono small" style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(a.at)}</td>
              <td>{a.actor_email}<div className="muted small">{a.actor_role}</div></td>
              <td><b style={{ fontWeight: 600 }}>{a.action}</b></td>
              <td className="small mono">{a.entity_type ?? '—'}{a.entity_id && <div className="muted">{String(a.entity_id).slice(0, 8)}</div>}</td>
              <td className="small" style={{ maxWidth: 420, wordBreak: 'break-word' }}>{Object.keys(a.details ?? {}).length ? JSON.stringify(a.details) : '—'}</td>
              <td className="small mono">{a.ip ?? '—'}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </>
  );
}
