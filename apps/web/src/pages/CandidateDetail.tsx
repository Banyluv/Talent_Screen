import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { del, download, patch, post } from '../api';
import { LEVELS, STATUS_LABEL, WEIGHT_LABELS, fmtDateTime, useAction, useCan, useData } from '../lib';
import { Bar, ErrorBox, Loading, PageHead, Pill, ScoreRing } from '../ui';

const CATS: [string, string][] = [['mandatory', 'Mandatory'], ['technical', 'Technical skills'], ['certification', 'Certifications'], ['soft', 'Soft skills'],
  ['preferred', 'Preferred skills'], ['industry', 'Industry'], ['niceToHave', 'Nice-to-have'], ['qualification', 'Preferred qualifications']];

export default function CandidateDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const can = useCan();
  const { data: c, error, reload } = useData<any>(`/candidates/${id}`);
  const { busy, run } = useAction();
  const [ovRec, setOvRec] = useState('Consider'); const [ovReason, setOvReason] = useState('');
  const [hrDec, setHrDec] = useState('hire'); const [hrWhy, setHrWhy] = useState('');
  const [eraseWhy, setEraseWhy] = useState(''); const [eraseArmed, setEraseArmed] = useState(false);
  const e = c?.evaluation;
  const running = e && ['pending', 'running'].includes(e.status);
  useEffect(() => { if (!running) return; const t = setInterval(reload, 2500); return () => clearInterval(t); }, [running, reload]);
  useEffect(() => { if (c?.override) setOvRec(c.override.to_rec); else if (e?.recommendation) setOvRec(e.recommendation); }, [c?.override, e?.recommendation]);
  if (error) return <ErrorBox error={error} />;
  if (!c) return <Loading />;

  const final = c.override?.to_rec ?? e?.recommendation;
  const statuses = can('workflow.manage') ? ['new', 'screening', 'shortlisted', 'interview', 'offer', 'hired', 'rejected', 'withdrawn'] : ['new', 'screening', 'interview', 'withdrawn'];
  const checks: any[] = e?.requirement_checks ?? [];

  return (
    <>
      <PageHead eyebrow={<><Link to={`/vacancies/${c.job.id}`}>{c.job.title}</Link> · {c.job.ref_code}</>} title={c.fullName}>
        {c.email !== undefined && <span className="muted small">{c.email}{c.phone && ` · ${c.phone}`}</span>}
        {c.fileName && can('candidates.view') && <button className="btn" onClick={() => run(() => download(`/candidates/${id}/file`, c.fileName))}>Original CV</button>}
        {can('evaluations.run') && <button className="btn" disabled={busy || running} onClick={async () => { await run(() => post(`/candidates/${id}/evaluate`), 'Re-evaluation queued'); reload(); }}>Re-run evaluation</button>}
      </PageHead>

      {!e ? <div className="note">No evaluation yet.</div> : running ? <div className="note brand">Evaluation in progress… this page updates automatically.</div> : e.status === 'failed' ? <ErrorBox error={`Evaluation failed: ${e.error}`} /> : (
        <>
          <section className="panel">
            <div className="section-title">Candidate summary</div>
            <div className="row" style={{ gap: 24, alignItems: 'center' }}>
              <ScoreRing value={e.overall_score} thresholds={e.thresholds} lg />
              <div><div className="eyebrow">Recommendation</div><Pill value={final} />{c.override && <span className="muted small"> (AI: {e.recommendation})</span>}</div>
              <div><div className="eyebrow">Total experience</div><b className="num">{e.total_years} yrs</b></div>
              <div><div className="eyebrow">Relevant experience</div><b className="num">{e.relevant_years} yrs</b></div>
              <div><div className="eyebrow">Highest qualification</div><b>{LEVELS[String(c.profile?.highestLevel)] ?? 'Not found'}</b></div>
              <div><div className="eyebrow">Status</div>{can('candidates.status', 'workflow.manage')
                ? <select id="status" style={{ width: 'auto' }} value={c.status} onChange={async (ev) => { await run(() => patch(`/candidates/${id}/status`, { status: ev.target.value }), 'Status updated'); reload(); }}>
                    {[...new Set([c.status, ...statuses])].map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</select>
                : <Pill value={c.status} />}</div>
            </div>
            {c.profile?.summary && <p className="muted" style={{ margin: '14px 0 0', maxWidth: '75ch' }}>{c.profile.summary}</p>}
          </section>

          <section className="panel stack">
            <div className="section-title" style={{ margin: 0 }}>Qualification assessment</div>
            <div className="assess">
              {Object.keys(WEIGHT_LABELS).map((k) => (
                <div key={k}><span className="muted small">{WEIGHT_LABELS[k]} · weight {e.weights[k]}%</span><b>{e.component_scores[k]}%</b><Bar value={e.component_scores[k]} /></div>
              ))}
            </div>
            {CATS.map(([cat, label]) => {
              const items = checks.filter((x) => x.category === cat);
              if (!items.length) return null;
              return <div key={cat} className="small"><span className="eyebrow">{label} </span>
                {items.map((x) => <span key={x.requirement} title={x.evidence ?? 'No evidence found'} className={'tag ' + (x.met ? (x.source === 'llm' ? 'ai' : 'hit') : 'miss')}>{x.requirement}{x.met && x.source === 'llm' ? ' · AI' : ''}</span>)}</div>;
            })}
            <div className="muted small">Green: found in the CV text. Amber: matched by the AI model from a quoted CV line; confirm it. Red: no evidence.</div>
          </section>

          <div className="grid2">
            <section className="panel"><div className="section-title">Strengths</div>
              <ul className="ev">{e.strengths.map((s: any, i: number) => <li key={i}>{s.text}{s.evidence && <small>“{s.evidence}”</small>}</li>)}{!e.strengths.length && <li className="muted">None identified</li>}</ul></section>
            <section className="panel"><div className="section-title">Gaps</div>
              <ul className="ev">{e.gaps.map((s: any, i: number) => <li key={i} className={s.severity === 'critical' ? 'gap-critical' : s.severity === 'moderate' ? 'gap-moderate' : ''}>{s.text}{s.why && <small>{s.why}</small>}</li>)}{!e.gaps.length && <li className="muted">No material gaps</li>}</ul></section>
          </div>

          <section className="panel stack">
            <div className="section-title" style={{ margin: 0 }}>Final recommendation</div>
            <div className="note brand"><Pill value={e.recommendation} /> {e.justification}</div>
            {e.narrative && <div className="note"><b>{e.engine && e.engine !== 'rules' ? 'AI review.' : 'Review.'}</b> {e.narrative}</div>}
            {e.match_summary?.industryBenchmark != null && <div className="muted small">Industry benchmark: {e.match_summary.industryBenchmark}</div>}
            {e.match_summary?.recommendations?.length > 0 && (
              <div className="note"><b>Recommendations</b><ul className="ev" style={{ marginTop: 8 }}>{e.match_summary.recommendations.map((r: string, i: number) => <li key={i}>{r}</li>)}</ul></div>
            )}
            {e.error && <div className="note warn">{e.error}</div>}
            {c.override && <div className="note"><b>Human override → {c.override.to_rec}</b> by {c.override.by_name} on {fmtDateTime(c.override.created_at)}<br />{c.override.reason}</div>}
            {can('evaluations.override') && (
              <div className="form-grid">
                <label className="f">Override recommendation<select id="ovRec" value={ovRec} onChange={(x) => setOvRec(x.target.value)}>{['Shortlist', 'Consider', 'Hold', 'Reject'].map((r) => <option key={r}>{r}</option>)}</select></label>
                <label className="f wide">Reason (required; recorded in the audit log)<textarea id="ovReason" rows={2} value={ovReason} onChange={(x) => setOvReason(x.target.value)} placeholder="e.g. Holds an equivalent certification the parser did not recognise" /></label>
                <div className="row wide">
                  <button className="btn primary" disabled={busy || ovReason.trim().length < 10} onClick={async () => { const ok = await run(() => post(`/candidates/${id}/override`, { recommendation: ovRec, reason: ovReason }), 'Override saved'); if (ok) { setOvReason(''); reload(); } }}>Save override</button>
                  {c.override && <button className="btn" disabled={busy} onClick={async () => { await run(() => del(`/candidates/${id}/override`), 'AI recommendation restored'); reload(); }}>Restore AI recommendation</button>}
                </div>
              </div>
            )}
            <div className="muted small">Evaluation v{e.version} · {e.engine}{e.model ? ` (${e.model})` : ''} · {fmtDateTime(e.completed_at)}. Name, gender, age, photo, religion, marital status and state of origin are not used in scoring.</div>
          </section>
        </>
      )}

      <div className="grid2">
        {c.profile?.roles?.length > 0 && (
          <section className="panel"><div className="section-title">Employment history (parsed)</div>
            <div className="list">{[...c.profile.roles].reverse().map((r: any, i: number) => (
              <div key={i}><div style={{ flex: 1, minWidth: 0 }}><b>{r.title}</b>{r.organisation && <div className="muted small">{r.organisation}</div>}</div>
                <span className="mono muted small" style={{ whiteSpace: 'nowrap' }}>{Math.floor(r.start)}–{r.current ? 'now' : Math.floor(r.end - 0.01)} · {(r.end - r.start).toFixed(1)}y</span></div>))}</div>
            {c.profile.education?.length > 0 && <><div className="section-title" style={{ marginTop: 14 }}>Education</div><div className="list small">{c.profile.education.map((ed: any, i: number) => <div key={i}>{ed.line}</div>)}</div></>}
          </section>
        )}
        {(c.interviews.length > 0 || can('recommendations.create')) && (
          <section className="panel stack"><div className="section-title" style={{ margin: 0 }}>Interviews and recommendations</div>
            {c.interviews.map((i: any) => (
              <div key={i.id} className="note"><b>{fmtDateTime(i.scheduled_at)}</b> · {i.mode} <Pill value={i.status} />
                {i.feedback.map((f: any, k: number) => <div key={k} style={{ marginTop: 6 }}><b>{f.panelist}</b>: {f.total}/20 — {f.comments}</div>)}
                {!i.feedback.length && <div className="muted">No scores yet.</div>}</div>
            ))}
            {c.recommendations.map((r: any, i: number) => <div key={i} className="note"><Pill value={r.decision} /> <b>{r.by_name}</b> · {fmtDateTime(r.created_at)}<div>{r.justification}</div></div>)}
            {can('recommendations.create') && (
              <div className="form-grid">
                <label className="f">Your hiring recommendation<select id="hrDec" value={hrDec} onChange={(x) => setHrDec(x.target.value)}><option value="hire">Hire</option><option value="hold">Hold</option><option value="no_hire">Do not hire</option></select></label>
                <label className="f wide">Justification<textarea id="hrWhy" rows={2} value={hrWhy} onChange={(x) => setHrWhy(x.target.value)} /></label>
                <div className="wide"><button className="btn primary" disabled={busy || hrWhy.trim().length < 10} onClick={async () => { const ok = await run(() => post(`/candidates/${id}/recommendations`, { decision: hrDec, justification: hrWhy }), 'Recommendation recorded'); if (ok) { setHrWhy(''); reload(); } }}>Submit recommendation</button></div>
              </div>
            )}
          </section>
        )}
      </div>

      {c.history?.length > 1 && (
        <section className="panel"><div className="section-title">Evaluation history</div>
          <div className="tbl-wrap"><table><thead><tr><th>Version</th><th>When</th><th>Requested by</th><th>Engine</th><th className="n">Score</th><th>Recommendation</th></tr></thead>
            <tbody>{c.history.map((h: any) => <tr key={h.id}><td className="mono">v{h.version}</td><td>{fmtDateTime(h.created_at)}</td><td>{h.requested_by ?? 'System'}</td><td>{h.engine}</td><td className="n">{h.overall_score ?? '—'}</td><td><Pill value={h.recommendation ?? h.status} /></td></tr>)}</tbody></table></div>
        </section>
      )}

      {c.cvText && <details className="panel"><summary style={{ cursor: 'pointer', fontWeight: 600 }}>Source CV text</summary><pre style={{ whiteSpace: 'pre-wrap', fontSize: '.84rem', margin: '12px 0 0' }}>{c.cvText}</pre></details>}

      {can('data.erase') && (
        <section className="panel stack"><div className="section-title" style={{ margin: 0 }}>Data protection</div>
          <p className="muted small" style={{ margin: 0 }}>Erasing removes the CV file, CV text, contact details and quoted evidence. Anonymised scores stay for reporting. This cannot be undone.</p>
          <label className="f">Reason for erasure<input id="eraseWhy" value={eraseWhy} onChange={(x) => setEraseWhy(x.target.value)} placeholder="e.g. Candidate's erasure request of 7 Oct 2026" /></label>
          <div><button className="btn danger" disabled={busy || eraseWhy.trim().length < 5} onClick={async () => {
            if (!eraseArmed) { setEraseArmed(true); return; }
            const ok = await run(() => post(`/candidates/${id}/erase`, { reason: eraseWhy }), 'Personal data erased');
            if (ok) nav('/candidates');
          }}>{eraseArmed ? 'Click again to erase permanently' : 'Erase personal data'}</button></div>
        </section>
      )}
    </>
  );
}
