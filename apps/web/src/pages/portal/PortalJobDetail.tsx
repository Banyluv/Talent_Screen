import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { pget, pupload, usePortalSession } from '../../portal';
import { fmtDate, useToast } from '../../lib';
import PortalLayout from './PortalLayout';

interface Job {
  id: string; ref_code: string; title: string; location: string; employment_type: string;
  department: string | null; description: string; closes_on: string | null; project: string;
  number_of_positions: number; reports_to: string; level_of_effort: string; minimum_recruitment_standard: string;
}

export default function PortalJobDetail() {
  const { id } = useParams();
  const { applicant } = usePortalSession();
  const toast = useToast();
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState('');
  const [coverLetter, setCoverLetter] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { pget<Job>(`/jobs/${id}`).then(setJob).catch((e) => setError(e.message)); }, [id]);

  async function apply(file?: File | null) {
    setBusy(true); setError('');
    try {
      const fd = new FormData();
      fd.append('coverLetter', coverLetter);
      if (file) fd.append('file', file);
      await pupload(`/jobs/${id}/apply`, fd);
      setDone(true);
      toast('Application submitted');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <PortalLayout>
      {error && <div className="error">{error}</div>}
      {!job ? (!error && <div className="empty">Loading…</div>) : (
        <>
          <Link to="/jobs" className="muted small">← Back to jobs</Link>
          <h1 style={{ marginTop: 8 }}>{job.title}</h1>
          <p className="muted" style={{ marginTop: 0 }}>{job.department ?? 'General'}{job.location ? ` · ${job.location}` : ''} · {job.employment_type} · {job.ref_code}</p>
          {job.description && <div className="panel"><div className="section-title">About the role</div><p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{job.description}</p></div>}
          <div className="grid2" style={{ marginTop: 16 }}>
            <section className="panel stack small">
              <div className="section-title">Details</div>
              <div><span className="muted">Location</span><br /><b>{job.location || '—'}</b></div>
              <div><span className="muted">Employment type</span><br /><b>{job.employment_type}</b></div>
              {job.number_of_positions > 1 && <div><span className="muted">Positions</span><br /><b>{job.number_of_positions}</b></div>}
              {job.reports_to && <div><span className="muted">Reports to</span><br /><b>{job.reports_to}</b></div>}
              {job.level_of_effort && <div><span className="muted">Level of effort</span><br /><b>{job.level_of_effort}</b></div>}
              <div><span className="muted">Closing date</span><br /><b>{job.closes_on ? fmtDate(job.closes_on) : 'Open'}</b></div>
            </section>
            <section className="panel stack">
              <div className="section-title">Apply</div>
              {done ? (
                <div className="note brand">Thank you — your application has been submitted. Track its status in <Link to="/portal/applications">My applications</Link>.</div>
              ) : !applicant ? (
                <div className="note">To apply, <Link to="/portal/login">sign in</Link> or <Link to="/portal/register">create an account</Link>. Your profile CV will be used unless you attach a different one.</div>
              ) : (
                <>
                  <label className="f">Cover letter (optional)<textarea rows={4} value={coverLetter} onChange={(e) => setCoverLetter(e.target.value)} placeholder="A short note on why you are a good fit." /></label>
                  <div>
                    <div className="muted small" style={{ marginBottom: 6 }}>Attach a CV (optional — uses your profile CV if omitted)</div>
                    <input ref={input} type="file" accept=".pdf,.docx,.txt" onChange={(e) => apply(e.target.files?.[0])} />
                  </div>
                  <div className="row">
                    <button className="btn primary" disabled={busy} onClick={() => apply()}>{busy ? 'Submitting…' : 'Apply with profile CV'}</button>
                  </div>
                  <p className="muted small" style={{ margin: 0 }}>Only PDF, DOCX and TXT files are accepted (max {10} MB).</p>
                </>
              )}
            </section>
          </div>
        </>
      )}
    </PortalLayout>
  );
}
