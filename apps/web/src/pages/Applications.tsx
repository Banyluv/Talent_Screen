import { useState } from 'react';
import { patch, post } from '../api';
import { fmtDate, useAction, useCan, useData } from '../lib';
import { ErrorBox, Loading, PageHead, Pill, ScoreRing } from '../ui';

const APP_STATUS: Record<string, string> = {
  submitted: 'Submitted', under_review: 'Under review', shortlisted: 'Shortlisted',
  interview: 'Interview', offer: 'Offer', hired: 'Hired', rejected: 'Not selected', withdrawn: 'Withdrawn',
};

export default function Applications() {
  const can = useCan();
  const jobs = useData<any[]>(can('jobs.view_all', 'jobs.view_assigned') ? '/jobs' : null);
  const [jobId, setJobId] = useState('');
  const [status, setStatus] = useState('');
  const qs = new URLSearchParams({ ...(jobId && { jobId }), ...(status && { status }) }).toString();
  const { data, error, reload } = useData<any[]>('/applications' + (qs ? '?' + qs : ''));
  const { busy, run } = useAction();
  const canEdit = can('candidates.status', 'workflow.manage');
  const canShortlist = can('evaluations.override', 'shortlist.review', 'workflow.manage');

  const shortlist = async (id: string) => {
    const ok = await run(() => post(`/applications/${id}/shortlist`, {}), 'Shortlisted for interview');
    if (ok) reload();
  };

  return (
    <>
      <PageHead eyebrow="Applicant portal" title="Applications" />
      <div className="row" style={{ flexWrap: 'wrap' }}>
        {jobs.data && <select id="appJob" style={{ width: 'auto', maxWidth: '100%' }} value={jobId} onChange={(e) => setJobId(e.target.value)}>
          <option value="">All vacancies</option>{jobs.data.filter((j) => j.status !== 'requested').map((j) => <option key={j.id} value={j.id}>{j.title}</option>)}</select>}
        <select id="appStatus" style={{ width: 'auto' }} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Any status</option>{Object.entries(APP_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      </div>
      {error && <ErrorBox error={error} />}
      {!data ? <Loading /> : (
        <div className="tbl-wrap"><table>
          <thead><tr><th>Applicant</th><th>Role</th><th>CV</th><th className="n">Score</th><th>Recommendation</th><th>Status</th><th>Applied</th><th></th></tr></thead>
          <tbody>
            {data.map((a: any) => (
              <tr key={a.id}>
                <td><b>{a.full_name}</b><div className="muted small">{a.email}{a.phone && ` · ${a.phone}`}</div>{a.headline && <div className="muted small">{a.headline}</div>}</td>
                <td>{a.title}<div className="muted small mono">{a.ref_code}</div></td>
                <td className="small">{a.cv_file_name ?? '—'}</td>
                <td className="n">{a.evaluation_status === 'completed' ? <ScoreRing value={a.overall_score} /> : a.evaluation_status ? <Pill value={a.evaluation_status} /> : '—'}</td>
                <td><Pill value={a.recommendation} /></td>
                <td><Pill value={a.status} /></td>
                <td className="small" style={{ whiteSpace: 'nowrap' }}>{fmtDate(a.created_at)}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {canShortlist && a.candidate_id && a.evaluation_status === 'completed' && a.recommendation !== 'Shortlist' && a.status !== 'withdrawn' && (
                    <button className="btn sm" disabled={busy} onClick={() => shortlist(a.id)}>Shortlist</button>
                  )}{' '}
                  {canEdit && a.status !== 'withdrawn' && (
                    <select value={a.status} disabled={busy} style={{ width: 'auto' }} onChange={async (e) => { await run(() => patch(`/applications/${a.id}/status`, { status: e.target.value }), 'Status updated'); reload(); }}>
                      {Object.entries(APP_STATUS).filter(([k]) => k !== 'withdrawn').map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  )}
                </td>
              </tr>
            ))}
            {!data.length && <tr><td colSpan={8} className="empty">No applications yet.</td></tr>}
          </tbody>
        </table></div>
      )}
    </>
  );
}
