import { Link } from 'react-router-dom';
import { post } from '../api';
import { fmtDateTime, useAction, useData } from '../lib';
import { Loading, PageHead } from '../ui';

export default function Notifications() {
  const { data, reload } = useData<any[]>('/notifications');
  const { busy, run } = useAction();
  const unread = (data ?? []).filter((n) => !n.read_at).length;
  return (
    <>
      <PageHead eyebrow="Notification centre" title="Notifications">
        <button className="btn" disabled={busy || !unread} onClick={async () => { await run(() => post('/notifications/read', {})); reload(); }}>Mark all as read</button>
      </PageHead>
      {!data ? <Loading /> : (
        <section className="panel"><div className="list">
          {data.map((n) => {
            const link = n.link?.replace(/\?.*$/, '');
            return (
              <div key={n.id} style={{ alignItems: 'center' }}>
                <span className={'pill ' + (n.read_at ? 'p-neutral' : 'p-Reject')}>{n.read_at ? 'Read' : 'New'}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  {link ? <Link to={link} onClick={() => post('/notifications/read', { ids: [n.id] })}><b>{n.title}</b></Link> : <b>{n.title}</b>}
                  {n.body && <div className="small">{n.body}</div>}
                  <div className="muted small">{fmtDateTime(n.created_at)}</div>
                </div>
              </div>
            );
          })}
          {!data.length && <div className="empty">No notifications yet.</div>}
        </div></section>
      )}
    </>
  );
}
