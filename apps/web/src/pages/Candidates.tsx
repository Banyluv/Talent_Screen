import { useState } from 'react';
import { Link } from 'react-router-dom';
import { fmtDate, useCan, useData } from '../lib';
import { ErrorBox, Loading, PageHead, Pill } from '../ui';

export default function Candidates() {
  const can = useCan();
  const jobs = useData<any[]>(can('jobs.view_all', 'jobs.view_assigned') ? '/jobs' : null);
  const [jobId, setJobId] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [rec, setRec] = useState('');
  const qs = new URLSearchParams({ ...(jobId && { jobId }), ...(q.length > 1 && { q }), ...(status && { status }), ...(rec && { recommendation: rec }) }).toString();
  const { data, error } = useData<any[]>('/candidates' + (qs ? '?' + qs : ''));
  const panelOnly = can('candidates.view_assigned') && !can('candidates.view');
  return (
    <>
      <PageHead eyebrow={panelOnly ? 'Assigned to you' : 'All vacancies you can see'} title="Candidates" />
      <div className="row">
        {jobs.data && <select id="job" style={{ width: 'auto', maxWidth: '100%' }} value={jobId} onChange={(e) => setJobId(e.target.value)}>
          <option value="">All vacancies</option>{jobs.data.filter((j) => j.status !== 'requested').map((j) => <option key={j.id} value={j.id}>{j.title}</option>)}</select>}
        <select id="rec" style={{ width: 'auto' }} value={rec} onChange={(e) => setRec(e.target.value)}><option value="">Any recommendation</option>{['Shortlist', 'Consider', 'Hold', 'Reject'].map((r) => <option key={r}>{r}</option>)}</select>
        <select id="status" style={{ width: 'auto' }} value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Any status</option>
          {['new', 'screening', 'shortlisted', 'interview', 'offer', 'hired', 'rejected', 'withdrawn'].map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}</select>
        <input id="q" type="search" placeholder="Search name, skill or job title" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 'min(280px, 100%)' }} />
      </div>
      {error && <ErrorBox error={error} />}
      {!data ? <Loading /> : (
        <div className="tbl-wrap"><table>
          <thead><tr><th>Candidate</th><th>Vacancy</th><th className="n">Score</th><th>Recommendation</th><th>Status</th><th>Added</th></tr></thead>
          <tbody>
            {data.map((c) => (
              <tr key={c.id}>
                <td><Link to={`/candidates/${c.id}`}>{c.full_name}</Link><div className="muted small">{c.file_name}</div></td>
                <td>{c.job_title}</td>
                <td className="n">{c.evaluation_status === 'completed' ? c.overall_score : <Pill value={c.evaluation_status} />}</td>
                <td><Pill value={c.recommendation} />{c.override_reason && <div className="muted small">overridden</div>}</td>
                <td><Pill value={c.status} /></td>
                <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(c.created_at)}</td>
              </tr>
            ))}
            {!data.length && <tr><td colSpan={6} className="empty">{panelOnly ? 'No candidates are assigned to you yet.' : 'No candidates match.'}</td></tr>}
          </tbody>
        </table></div>
      )}
    </>
  );
}
