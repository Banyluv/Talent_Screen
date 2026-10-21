import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { pget, ppost } from '../../portal';
import { fmtDate } from '../../lib';
import PortalLayout, { RequireApplicant } from './PortalLayout';

interface App {
  id: string; status: string; job_id: string; title: string; ref_code: string;
  department: string | null; location: string; employment_type: string;
  cv_file_name: string | null; created_at: string; updated_at: string;
}

const STATUS_LABEL: Record<string, string> = {
  submitted: 'Submitted', under_review: 'Under review', shortlisted: 'Shortlisted',
  interview: 'Interview', offer: 'Offer', hired: 'Hired', rejected: 'Not selected', withdrawn: 'Withdrawn',
};

export default function PortalApplications() {
  return <PortalLayout><RequireApplicant><Applications /></RequireApplicant></PortalLayout>;
}

function Applications() {
  const [apps, setApps] = useState<App[] | null>(null);
  const load = () => pget<App[]>('/applications').then(setApps).catch(() => setApps([]));
  useEffect(() => { load(); }, []);

  async function withdraw(id: string) {
    await ppost(`/applications/${id}/withdraw`).then(load).catch(() => undefined);
  }

  return (
    <>
      <h1>My applications</h1>
      <p className="muted" style={{ marginTop: 0 }}>Track the status of your applications.</p>
      {!apps ? <div className="empty">Loading…</div> : (
        <div className="tbl-wrap"><table>
          <thead><tr><th>Role</th><th>Department</th><th>CV</th><th>Status</th><th>Applied</th><th>Updated</th><th></th></tr></thead>
          <tbody>
            {apps.map((a) => (
              <tr key={a.id}>
                <td><Link to={`/jobs/${a.job_id}`}>{a.title}</Link><div className="muted small mono">{a.ref_code}</div></td>
                <td>{a.department ?? '—'}</td>
                <td className="small">{a.cv_file_name ?? '—'}</td>
                <td><span className={'pill p-' + a.status}>{STATUS_LABEL[a.status] ?? a.status}</span></td>
                <td className="small">{fmtDate(a.created_at)}</td>
                <td className="small">{fmtDate(a.updated_at)}</td>
                <td>{['submitted', 'under_review'].includes(a.status) && <button className="btn sm ghost" onClick={() => withdraw(a.id)}>Withdraw</button>}</td>
              </tr>
            ))}
            {!apps.length && <tr><td colSpan={7} className="empty">You have not applied to any roles yet. <Link to="/jobs">Browse jobs</Link>.</td></tr>}
          </tbody>
        </table></div>
      )}
    </>
  );
}
