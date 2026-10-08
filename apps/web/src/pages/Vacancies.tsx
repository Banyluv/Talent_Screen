import { Link } from 'react-router-dom';
import { fmtDate, useCan, useData } from '../lib';
import { ErrorBox, Loading, PageHead, Pill } from '../ui';

export default function Vacancies() {
  const can = useCan();
  const { data, error } = useData<any[]>('/jobs');
  return (
    <>
      <PageHead eyebrow="Recruitment campaigns" title="Vacancies">
        {can('jobs.create') ? <Link className="btn primary" to="/vacancies/new">New vacancy</Link>
          : can('hiring_requests.create') ? <Link className="btn primary" to="/vacancies/new">Raise hiring request</Link> : null}
      </PageHead>
      {error && <ErrorBox error={error} />}
      {!data ? <Loading /> : (
        <div className="tbl-wrap"><table>
          <thead><tr><th>Vacancy</th><th>Department</th><th>Location</th><th>Status</th><th className="n">Applicants</th><th className="n">Shortlist</th><th>Hiring manager</th><th>Opened</th></tr></thead>
          <tbody>
            {data.map((j) => (
              <tr key={j.id}>
                <td><Link to={`/vacancies/${j.id}`}>{j.title}</Link><div className="muted small mono">{j.ref_code}{j.evaluating > 0 && ` · ${j.evaluating} evaluating`}</div></td>
                <td>{j.department ?? '—'}</td><td>{j.location || '—'}</td>
                <td><Pill value={j.status} />{j.status === 'requested' && <div className="muted small">by {j.requested_by_name}</div>}</td>
                <td className="n">{j.applicants}</td><td className="n">{j.shortlisted}</td>
                <td>{j.hiring_manager ?? '—'}</td><td style={{ whiteSpace: 'nowrap' }}>{fmtDate(j.created_at)}</td>
              </tr>
            ))}
            {!data.length && <tr><td colSpan={8} className="empty">No vacancies available to your role yet.</td></tr>}
          </tbody>
        </table></div>
      )}
    </>
  );
}
