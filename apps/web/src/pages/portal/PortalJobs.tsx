import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { pget } from '../../portal';
import { fmtDate } from '../../lib';
import PortalLayout from './PortalLayout';

interface Job {
  id: string; ref_code: string; title: string; location: string; employment_type: string;
  department: string | null; description: string; closes_on: string | null; project: string;
}

export default function PortalJobs() {
  const [q, setQ] = useState('');
  const [department, setDepartment] = useState('');
  const [location, setLocation] = useState('');
  const [type, setType] = useState('');
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const params = new URLSearchParams();
    if (q.trim().length > 1) params.set('q', q.trim());
    if (department) params.set('department', department);
    if (location) params.set('location', location);
    if (type) params.set('employmentType', type);
    const qs = params.toString();
    pget<Job[]>('/jobs' + (qs ? '?' + qs : '')).then(setJobs).catch((e) => setError(e.message));
  }, [q, department, location, type]);

  const departments = [...new Set((jobs ?? []).map((j) => j.department).filter(Boolean))].sort() as string[];
  const locations = [...new Set((jobs ?? []).map((j) => j.location).filter(Boolean))].sort() as string[];

  return (
    <PortalLayout>
      <h1>Open roles</h1>
      <p className="muted" style={{ marginTop: 0 }}>Search and apply for positions across ECEWS.</p>
      <div className="row" style={{ flexWrap: 'wrap', marginBottom: 20 }}>
        <input type="search" placeholder="Search by title or keyword" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 'min(320px, 100%)' }} />
        <select value={department} onChange={(e) => setDepartment(e.target.value)} style={{ width: 'auto' }}><option value="">All departments</option>{departments.map((d) => <option key={d}>{d}</option>)}</select>
        <select value={location} onChange={(e) => setLocation(e.target.value)} style={{ width: 'auto' }}><option value="">All locations</option>{locations.map((l) => <option key={l}>{l}</option>)}</select>
        <select value={type} onChange={(e) => setType(e.target.value)} style={{ width: 'auto' }}><option value="">All types</option>{['Full-time', 'Part-time', 'Contract'].map((t) => <option key={t}>{t}</option>)}</select>
      </div>
      {error && <div className="error">{error}</div>}
      {!jobs ? <div className="empty">Loading jobs…</div> : (
        <div className="stack">
          {jobs.map((j) => (
            <Link key={j.id} to={`/jobs/${j.id}`} className="panel" style={{ textDecoration: 'none', color: 'var(--ink)' }}>
              <div className="spread">
                <div>
                  <b style={{ fontSize: '1.05rem' }}>{j.title}</b>
                  <div className="muted small">{j.department ?? 'General'}{j.location ? ` · ${j.location}` : ''} · {j.employment_type}</div>
                </div>
                <span className="muted small" style={{ whiteSpace: 'nowrap' }}>{j.closes_on ? `Closes ${fmtDate(j.closes_on)}` : 'Open'}</span>
              </div>
              {j.description && <p className="muted small" style={{ margin: '8px 0 0' }}>{j.description.slice(0, 220)}{j.description.length > 220 ? '…' : ''}</p>}
            </Link>
          ))}
          {!jobs.length && <div className="empty">No roles match your search.</div>}
        </div>
      )}
    </PortalLayout>
  );
}
