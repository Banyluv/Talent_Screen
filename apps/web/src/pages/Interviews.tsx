import { useState } from 'react';
import { Link } from 'react-router-dom';
import { patch, post, put } from '../api';
import { fmtDateTime, useAction, useCan, useData } from '../lib';
import { Drawer, ErrorBox, Loading, PageHead, Pill } from '../ui';

const CRITERIA: [string, string][] = [['technical', 'Technical knowledge'], ['problemSolving', 'Problem solving'], ['communication', 'Communication'], ['teamFit', 'Values and team fit']];

export default function Interviews() {
  const can = useCan();
  const { data, error, reload } = useData<any[]>('/interviews');
  const [scheduling, setScheduling] = useState(false);
  const [scoring, setScoring] = useState<any>(null);
  const [panelFor, setPanelFor] = useState<any>(null);
  const { busy, run } = useAction();
  return (
    <>
      <PageHead eyebrow="Panels and feedback" title="Interviews">
        {can('interviews.schedule') && <button className="btn primary" onClick={() => setScheduling(true)}>Schedule interview</button>}
      </PageHead>
      {error && <ErrorBox error={error} />}
      {!data ? <Loading /> : (
        <div className="tbl-wrap"><table>
          <thead><tr><th>Candidate</th><th>Vacancy</th><th>When (WAT)</th><th>Panel</th><th className="n">Avg / 20</th><th>Status</th><th>Hiring rec.</th><th></th></tr></thead>
          <tbody>
            {data.map((i) => (
              <tr key={i.id}>
                <td><Link to={`/candidates/${i.candidate_id}`}>{i.candidate}</Link></td>
                <td>{i.job_title}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(i.scheduled_at)}<div className="muted small">{i.mode}{i.location && ` · ${i.location}`}</div></td>
                <td className="small">
                  {i.panel.map((p: any) => <div key={p.id}>{p.name} {p.scored && <span className="ok" aria-label="scored">✓</span>}</div>)}
                  {can('interviews.schedule') && i.status !== 'cancelled' &&
                    <button className="btn sm ghost" onClick={() => setPanelFor(i)}>Add or remove</button>}
                </td>
                <td className="n">{i.avg_total ?? '—'}</td>
                <td><Pill value={i.status} /></td>
                <td><Pill value={i.latest_recommendation} /></td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {i.i_am_panelist && can('interviews.score') && i.status !== 'cancelled' && <button className="btn sm primary" onClick={() => setScoring(i)}>{i.i_have_scored ? 'Edit score' : 'Score'}</button>}{' '}
                  {can('interviews.schedule') && i.status === 'scheduled' && <>
                    <button className="btn sm" disabled={busy} onClick={async () => { await run(() => patch(`/interviews/${i.id}`, { status: 'completed' }), 'Marked completed'); reload(); }}>Done</button>{' '}
                    <button className="btn sm ghost" disabled={busy} onClick={async () => { await run(() => patch(`/interviews/${i.id}`, { status: 'cancelled' }), 'Cancelled'); reload(); }}>Cancel</button></>}
                </td>
              </tr>
            ))}
            {!data.length && <tr><td colSpan={8} className="empty">No interviews yet.</td></tr>}
          </tbody>
        </table></div>
      )}
      {scheduling && <Schedule onClose={() => setScheduling(false)} onDone={() => { setScheduling(false); reload(); }} />}
      {scoring && <Score interview={scoring} onClose={() => setScoring(null)} onDone={() => { setScoring(null); reload(); }} />}
      {panelFor && <Panel interview={panelFor} onClose={() => setPanelFor(null)} onDone={() => { setPanelFor(null); reload(); }} />}
    </>
  );
}

/** Add or remove panel members after an interview has been scheduled. */
function Panel({ interview, onClose, onDone }: { interview: any; onClose: () => void; onDone: () => void }) {
  const users = useData<any[]>('/users');
  const { busy, run } = useAction();
  const current: any[] = interview.panel ?? [];
  const [chosen, setChosen] = useState<string[]>(current.map((p) => p.id));
  const scored = new Set(current.filter((p) => p.scored).map((p) => p.id));

  // Only people the API will accept, plus anyone already on the panel (in case their role changed).
  const eligible = (users.data ?? []).filter((u) => u.can_score || current.some((p) => p.id === u.id));
  const added = chosen.filter((id) => !current.some((p) => p.id === id));
  const removed = current.filter((p) => !chosen.includes(p.id)).map((p) => p.id);
  const dirty = added.length > 0 || removed.length > 0;

  async function save() {
    const r = await run(() => put(`/interviews/${interview.id}/panelists`, { panelistIds: chosen }), 'Panel updated');
    if (r) onDone();
  }

  return (
    <Drawer eyebrow="Interview panel" title={interview.candidate} onClose={onClose}>
      <div className="muted">
        {interview.job_title} · {fmtDateTime(interview.scheduled_at)} WAT
      </div>
      {!users.data ? <Loading /> : (
        <div className="stack">
          <div className="note">
            Added members are emailed the position, date and time. Someone who has already
            scored cannot be removed — their score is part of the record.
          </div>
          <fieldset><legend>Panel members</legend>
            <div className="stack" style={{ gap: 6 }}>
              {eligible.map((u) => (
                <label key={u.id} className="check">
                  <input
                    type="checkbox"
                    checked={chosen.includes(u.id)}
                    disabled={scored.has(u.id)}
                    onChange={(e) => setChosen(e.target.checked ? [...chosen, u.id] : chosen.filter((x) => x !== u.id))}
                  />
                  {u.full_name} <span className="muted">· {u.role_name ?? u.role_key}</span>
                  {scored.has(u.id) && <span className="tag hit">scored</span>}
                </label>
              ))}
              {!eligible.length && <p className="muted">Nobody holds permission to score interviews.</p>}
            </div>
          </fieldset>
          <div className="row">
            <button className="btn primary" disabled={busy || !dirty || chosen.length === 0} onClick={save}>
              {busy ? 'Saving…' : 'Save panel'}
            </button>
            <span className="muted small">
              {added.length > 0 && `${added.length} to add`}
              {added.length > 0 && removed.length > 0 && ' · '}
              {removed.length > 0 && `${removed.length} to remove`}
              {!dirty && 'No changes'}
            </span>
          </div>
          {chosen.length === 0 && <div className="error">An interview needs at least one panel member.</div>}
        </div>
      )}
    </Drawer>
  );
}

function Schedule({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const cands = useData<any[]>('/candidates');
  const users = useData<any[]>('/users');
  const { busy, run } = useAction();
  const eligible = (cands.data ?? []).filter((c) => c.evaluation_status === 'completed' && ['Shortlist', 'Consider', 'Hold'].includes(c.recommendation) && !['hired', 'rejected', 'withdrawn'].includes(c.status));
  const panel = (users.data ?? []).filter((u) => u.can_score);
  const [f, setF] = useState({ candidateId: '', date: '', time: '10:00', durationMin: 45, mode: 'Microsoft Teams', location: '', panelistIds: [] as string[] });
  const submit = async () => {
    const at = new Date(`${f.date}T${f.time}:00+01:00`).toISOString(); // WAT
    const r = await run(() => post('/interviews', { candidateId: f.candidateId, scheduledAt: at, durationMin: +f.durationMin, mode: f.mode, location: f.location, panelistIds: f.panelistIds }), 'Interview scheduled; panel notified');
    if (r) onDone();
  };
  return (
    <Drawer title="Schedule an interview" onClose={onClose}>
      {!cands.data ? <Loading /> : (
        <div className="form-grid">
          <label className="f wide">Candidate<select id="cand" value={f.candidateId} onChange={(e) => setF({ ...f, candidateId: e.target.value })}>
            <option value="">Choose a candidate</option>{eligible.map((c) => <option key={c.id} value={c.id}>{c.full_name} — {c.job_title} ({c.recommendation}, {c.overall_score})</option>)}</select></label>
          <label className="f">Date<input id="date" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></label>
          <label className="f">Time (WAT)<input id="time" type="time" value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} /></label>
          <label className="f">Duration (minutes)<input id="dur" type="number" min={15} max={480} value={f.durationMin} onChange={(e) => setF({ ...f, durationMin: +e.target.value })} /></label>
          <label className="f">Mode<select id="mode" value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })}>{['Microsoft Teams', 'In person', 'Phone'].map((m) => <option key={m}>{m}</option>)}</select></label>
          <label className="f wide">Location or meeting link<input id="where" value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} /></label>
          <fieldset className="wide"><legend>Panel</legend><div className="stack" style={{ gap: 6 }}>
            {panel.map((u) => <label key={u.id} className="check"><input type="checkbox" checked={f.panelistIds.includes(u.id)}
              onChange={(e) => setF({ ...f, panelistIds: e.target.checked ? [...f.panelistIds, u.id] : f.panelistIds.filter((x) => x !== u.id) })} />{u.full_name} <span className="muted">· {u.role_name}</span></label>)}
          </div></fieldset>
          <div className="wide"><button className="btn primary" disabled={busy || !f.candidateId || !f.date || !f.panelistIds.length} onClick={submit}>Schedule and notify panel</button></div>
          {!eligible.length && <p className="muted wide">Only evaluated candidates recommended Shortlist, Consider or Hold can be scheduled.</p>}
        </div>
      )}
    </Drawer>
  );
}

function Score({ interview, onClose, onDone }: { interview: any; onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction();
  const [s, setS] = useState<Record<string, number>>({ technical: 3, problemSolving: 3, communication: 3, teamFit: 3 });
  const [comments, setComments] = useState('');
  const total = Object.values(s).reduce((a, b) => a + b, 0);
  return (
    <Drawer eyebrow="Interview score" title={interview.candidate} onClose={onClose}>
      <div className="muted">{interview.job_title} · {fmtDateTime(interview.scheduled_at)}</div>
      <div className="form-grid">
        {CRITERIA.map(([k, l]) => (
          <label key={k} className="f">{l}<select id={'sc_' + k} value={s[k]} onChange={(e) => setS({ ...s, [k]: +e.target.value })}>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} — {['Poor', 'Weak', 'Adequate', 'Strong', 'Excellent'][n - 1]}</option>)}</select></label>
        ))}
        <label className="f wide">Feedback (what you saw and heard; avoid personal characteristics)<textarea id="comments" rows={5} value={comments} onChange={(e) => setComments(e.target.value)} /></label>
      </div>
      <div className="row"><b className="num">{total} / 20</b><button className="btn primary" disabled={busy || comments.trim().length < 10}
        onClick={async () => { const r = await run(() => post(`/interviews/${interview.id}/scores`, { ...s, comments }), 'Score submitted'); if (r) onDone(); }}>Submit score</button></div>
    </Drawer>
  );
}
