import { DragEvent, useEffect, useRef, useState } from 'react';
import { Link, NavLink, useParams } from 'react-router-dom';
import { patch, post, upload } from '../api';
import { LEVELS, WEIGHT_LABELS, fmtDate, useAction, useCan, useData } from '../lib';
import { ErrorBox, Loading, PageHead, Pill, ScoreRing } from '../ui';

export default function VacancyDetail() {
  const { id, tab: tabParam } = useParams();
  const can = useCan();
  const { data: job, error, reload } = useData<any>(`/jobs/${id}`);
  const { busy, run } = useAction();
  const canRank = can('evaluations.view', 'shortlist.review');
  const tab = tabParam ?? (canRank ? 'ranking' : can('candidates.upload') ? 'upload' : 'details');
  if (error) return <ErrorBox error={error} />;
  if (!job) return <Loading />;
  const r = job.requirements;

  const decide = async (decision: 'approve' | 'reject') => { await run(() => post(`/jobs/${id}/decision`, { decision }), decision === 'approve' ? 'Vacancy opened' : 'Request declined'); reload(); };
  const setStatus = async (status: string) => { await run(() => patch(`/jobs/${id}/status`, { status }), 'Status updated'); reload(); };
  const rescore = async () => { const x = await run(() => post(`/jobs/${id}/rescore`)); if (x) { reload(); } };

  return (
    <>
      <PageHead eyebrow={<>{job.ref_code} · {job.location || 'No location'} · {job.employment_type}</>} title={<>{job.title} <Pill value={job.status} /></>}>
        {job.status === 'requested' && can('jobs.approve') && <><button className="btn" disabled={busy} onClick={() => decide('reject')}>Decline</button><button className="btn primary" disabled={busy} onClick={() => decide('approve')}>Approve and open</button></>}
        {can('evaluations.run') && job.status !== 'requested' && <button className="btn" disabled={busy} onClick={rescore}>Re-score all</button>}
        {can('jobs.edit') && job.status === 'open' && <button className="btn" disabled={busy} onClick={() => setStatus('closed')}>Close</button>}
        {can('jobs.edit') && ['closed', 'filled'].includes(job.status) && <button className="btn" disabled={busy} onClick={() => setStatus('open')}>Reopen</button>}
        {can('jobs.edit') && <Link className="btn" to={`/vacancies/${id}/edit`}>Edit</Link>}
      </PageHead>
      <div className="tabs" role="tablist">
        {canRank && <NavLink to={`/vacancies/${id}/ranking`} className={tab === 'ranking' ? 'active' : ''}>Ranking</NavLink>}
        {can('candidates.upload') && job.status === 'open' && <NavLink to={`/vacancies/${id}/upload`} className={tab === 'upload' ? 'active' : ''}>Upload CVs</NavLink>}
        <NavLink to={`/vacancies/${id}/details`} className={tab === 'details' ? 'active' : ''}>Requirements</NavLink>
      </div>
      {tab === 'ranking' && canRank && <Ranking job={job} />}
      {tab === 'upload' && can('candidates.upload') && <Upload job={job} />}
      {tab === 'details' && (
        <div className="grid2">
          <section className="panel stack">
            <h2>Role</h2>
            <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{job.description || <span className="muted">No description.</span>}</p>
            {job.minimum_recruitment_standard && (
              <div>
                <div className="section-title" style={{ marginBottom: 4 }}>Minimum recruitment standard</div>
                <p className="small" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{job.minimum_recruitment_standard}</p>
              </div>
            )}
            <div className="list small">
              <div><span className="muted" style={{ width: 170 }}>Minimum qualification</span><b>{LEVELS[String(r.minQualificationLevel)]}</b></div>
              <div><span className="muted" style={{ width: 170 }}>Fields of study</span><span>{r.fieldsOfStudy.join(', ') || 'Any'}</span></div>
              <div><span className="muted" style={{ width: 170 }}>Experience</span><b>{r.minYears} years minimum, {r.preferredYears} preferred</b></div>
              {job.project && <div><span className="muted" style={{ width: 170 }}>Project</span><span>{job.project}</span></div>}
              {job.number_of_positions > 1 && <div><span className="muted" style={{ width: 170 }}>Positions</span><b>{job.number_of_positions}</b></div>}
              {job.reports_to && <div><span className="muted" style={{ width: 170 }}>Reports to</span><span>{job.reports_to}</span></div>}
              {job.level_of_effort && <div><span className="muted" style={{ width: 170 }}>Level of effort</span><span>{job.level_of_effort}</span></div>}
              {r.locationRequirements && <div><span className="muted" style={{ width: 170 }}>Location</span><span>{r.locationRequirements}</span></div>}
              {job.closes_on && <div><span className="muted" style={{ width: 170 }}>Closes</span><span>{fmtDate(job.closes_on)}</span></div>}
            </div>
          </section>
          <section className="panel stack">
            <h2>Scoring criteria</h2>
            {([['Mandatory', r.mandatory], ['Technical skills', r.technicalSkills], ['Certifications', r.requiredCertifications], ['Soft skills', r.softSkills],
              ['Preferred skills', r.preferredSkills], ['Industry', r.industryExperience], ['Nice-to-have', r.niceToHave]] as [string, string[]][]).filter(([, v]) => v?.length).map(([l, v]) => (
              <div key={l}><div className="section-title">{l}</div>{v.map((s) => <span key={s} className="tag">{s}</span>)}</div>
            ))}
            <div><div className="section-title">Weights {job.weights_override ? '(custom for this vacancy)' : '(organisation default)'}</div>
              {Object.entries(job.effectiveWeights).map(([k, v]) => <span key={k} className="tag">{WEIGHT_LABELS[k]} {String(v)}%</span>)}</div>
            <div className="muted small">Shortlist at {job.thresholds.shortlist}+, Consider at {job.thresholds.consider}+, Hold at {job.thresholds.hold}+.
              {job.rules.enforceMandatory && ' Missing mandatory → Reject.'}{job.rules.enforceMinExperience && ` Below ${r.minYears} years ${job.rules.experienceBasis} experience → Reject.`}</div>
          </section>
        </div>
      )}
    </>
  );
}

function Ranking({ job }: { job: any }) {
  const { data, reload } = useData<any[]>(`/jobs/${job.id}/ranking`);
  const [filter, setFilter] = useState('All');
  const pending = (data ?? []).some((r) => ['pending', 'running'].includes(r.evaluation_status));
  useEffect(() => { if (!pending) return; const t = setInterval(reload, 3000); return () => clearInterval(t); }, [pending, reload]);
  if (!data) return <Loading />;
  const counts = (r: string) => data.filter((x) => x.recommendation === r).length;
  const rows = data.filter((x) => filter === 'All' || x.recommendation === filter);
  return (
    <section className="panel">
      <div className="panel-head"><h2>Candidate ranking</h2>{pending && <span className="pill p-running">Evaluating…</span>}<Link className="btn sm" to={`/compare?job=${job.id}`}>Compare</Link></div>
      <div className="chips" style={{ marginBottom: 14 }}>
        {['All', 'Shortlist', 'Consider', 'Hold', 'Reject'].map((r) => (
          <button key={r} className="chip" aria-pressed={filter === r} onClick={() => setFilter(r)}>{r} <span className="num">{r === 'All' ? data.length : counts(r)}</span></button>
        ))}
      </div>
      <div className="tbl-wrap"><table>
        <thead><tr><th className="n">Rank</th><th>Candidate</th><th className="n">Score</th><th className="n">Years</th><th className="n">Qual. %</th><th className="n">Skills %</th><th>Recommendation</th><th>Key strengths</th><th>Key gaps</th></tr></thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id}>
              <td className="n">{c.rank ?? '—'}</td>
              <td><Link to={`/candidates/${c.id}`}>{c.full_name}</Link><div className="small"><Pill value={c.status} /></div></td>
              <td className="n">{c.evaluation_status === 'completed' ? <ScoreRing value={c.overall_score} thresholds={job.thresholds} /> : <Pill value={c.evaluation_status} />}</td>
              <td className="n">{c.total_years ?? '—'}<div className="muted small">{c.relevant_years ?? '—'} rel.</div></td>
              <td className="n">{c.qualification_match ?? '—'}</td><td className="n">{c.skills_match ?? '—'}</td>
              <td><Pill value={c.recommendation} />{c.override_reason && <div className="muted small">AI said {c.ai_recommendation}</div>}</td>
              <td className="small" style={{ minWidth: 200 }}>{c.key_strengths.map((s: string, i: number) => <div key={i}>{s}</div>)}</td>
              <td className="small" style={{ minWidth: 200 }}>{c.key_gaps.length ? c.key_gaps.map((s: string, i: number) => <div key={i}>{s}</div>) : <span className="muted">None material</span>}</td>
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={9} className="empty">No candidates {filter === 'All' ? 'yet' : 'in this band'}.</td></tr>}
        </tbody>
      </table></div>
      <p className="note brand" style={{ margin: '14px 0 0' }}>Rankings are decision support. HR or the hiring manager confirms every shortlist decision; overrides are recorded with a reason in the audit log.</p>
    </section>
  );
}

function Upload({ job }: { job: any }) {
  const [over, setOver] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [paste, setPaste] = useState('');
  const { busy, run } = useAction();
  const input = useRef<HTMLInputElement>(null);
  async function send(files: File[]) {
    const ok = files.filter((f) => /\.(pdf|docx|txt)$/i.test(f.name));
    if (!ok.length) return;
    const fd = new FormData(); ok.forEach((f) => fd.append('files', f));
    const r = await run(() => upload(`/jobs/${job.id}/candidates`, fd));
    if (r) setResult(r);
    if (input.current) input.current.value = '';
  }
  async function sendText() {
    const r = await run(() => post(`/jobs/${job.id}/candidates/text`, { text: paste }));
    if (r) { setResult(r); if (r.created.length) setPaste(''); }
  }
  const drop = (e: DragEvent) => { e.preventDefault(); setOver(false); send([...e.dataTransfer.files]); };
  return (
    <div className="grid2">
      <section className="panel stack">
        <h2>Upload CVs</h2>
        <div className={'drop' + (over ? ' over' : '')} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={drop}>
          <b>Drop CV files here</b>
          <div className="muted" style={{ margin: '4px 0 12px' }}>PDF, DOCX or TXT · one or many at once</div>
          <label className="btn primary" htmlFor="cvFiles">{busy ? 'Uploading…' : 'Choose files'}</label>
          <input id="cvFiles" ref={input} type="file" accept=".pdf,.docx,.txt" multiple hidden onChange={(e) => send([...(e.target.files ?? [])])} />
        </div>
        <details><summary style={{ cursor: 'pointer', fontWeight: 600 }}>Paste CV text instead</summary>
          <div className="stack" style={{ marginTop: 8 }}>
            <textarea id="paste" rows={8} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="Paste the full CV, starting with the candidate's name" />
            <div><button className="btn" disabled={busy || paste.trim().length < 80} onClick={sendText}>Add and evaluate</button></div>
          </div>
        </details>
        <p className="note" style={{ margin: 0 }}>Files are encrypted before storage. Scoring ignores name, gender, age, photo, marital status, religion and state of origin; contact details are never sent to the AI provider.</p>
      </section>
      <section className="panel stack">
        <h2>Result</h2>
        {!result ? <p className="muted" style={{ margin: 0 }}>Uploaded CVs are read, queued for evaluation and appear in the ranking within a few seconds.</p> : (
          <>
            <div className="list">
              {result.created.map((c: any) => <div key={c.id}><span className="pill p-completed">Queued</span><div><Link to={`/candidates/${c.id}`}>{c.name}</Link><div className="muted small">{c.file}</div></div></div>)}
              {result.skipped.map((s: any, i: number) => <div key={i}><span className="pill p-Reject">Skipped</span><div><b>{s.file}</b><div className="muted small">{s.reason}</div></div></div>)}
            </div>
            {result.created.length > 0 && <Link className="btn" to={`/vacancies/${job.id}/ranking`}>See ranking</Link>}
          </>
        )}
      </section>
    </div>
  );
}
