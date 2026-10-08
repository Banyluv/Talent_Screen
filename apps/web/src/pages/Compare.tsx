import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { WEIGHT_LABELS, useData } from '../lib';
import { Bar, Loading, PageHead, Pill, ScoreRing } from '../ui';

export default function Compare() {
  const [params, setParams] = useSearchParams();
  const jobs = useData<any[]>('/jobs');
  const open = (jobs.data ?? []).filter((j) => j.status !== 'requested');
  const jobId = params.get('job') ?? open[0]?.id ?? '';
  const ranking = useData<any[]>(jobId ? `/jobs/${jobId}/ranking` : null);
  const done = (ranking.data ?? []).filter((r) => r.evaluation_status === 'completed');
  const [sel, setSel] = useState<string[]>([]);
  useEffect(() => { setSel(done.slice(0, 3).map((r) => r.id)); }, [ranking.data]);  // default: top three
  const cmp = useData<any[]>(jobId && sel.length >= 2 ? `/jobs/${jobId}/compare?ids=${sel.join(',')}` : null);
  const toggle = (id: string) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id].slice(-4)));
  const thr = { shortlist: 85, consider: 65, hold: 50 };

  return (
    <>
      <PageHead eyebrow="Side by side" title="Compare candidates">
        <select id="job" style={{ width: 'auto', maxWidth: '100%' }} value={jobId} onChange={(e) => setParams({ job: e.target.value })}>
          {open.map((j) => <option key={j.id} value={j.id}>{j.title}</option>)}</select>
      </PageHead>
      {!ranking.data ? <Loading /> : (
        <>
          <div className="chips">{done.map((r) => <button key={r.id} className="chip" aria-pressed={sel.includes(r.id)} onClick={() => toggle(r.id)}>{r.full_name} <span className="num">{r.overall_score}</span></button>)}</div>
          <p className="muted small" style={{ margin: 0 }}>Choose two to four candidates.</p>
          {sel.length < 2 ? <div className="empty">Select at least two candidates.</div> : !cmp.data ? <Loading /> : (
            <div className="cmp">
              {cmp.data.map((c) => (
                <section key={c.id} className="panel stack">
                  <div className="row" style={{ flexWrap: 'nowrap' }}><ScoreRing value={c.overall_score} thresholds={thr} /><div style={{ minWidth: 0 }}><Link to={`/candidates/${c.id}`}><b>{c.full_name}</b></Link><br /><Pill value={c.recommendation} /></div></div>
                  <div className="small muted">{c.total_years} yrs total · {c.relevant_years} relevant</div>
                  {Object.keys(WEIGHT_LABELS).map((k) => (
                    <div key={k}><div className="spread small"><span>{WEIGHT_LABELS[k]} <span className="muted">· {c.weights[k]}%</span></span><span className="num">{c.component_scores[k]}</span></div><Bar value={c.component_scores[k]} /></div>
                  ))}
                  {(['technical', 'certification', 'mandatory'] as const).map((cat) => {
                    const items = (c.requirement_checks ?? []).filter((x: any) => x.category === cat);
                    return items.length ? <div key={cat} className="small"><div className="eyebrow">{cat === 'technical' ? 'Required skills' : cat === 'certification' ? 'Certifications' : 'Mandatory'}</div>
                      {items.map((x: any) => <span key={x.requirement} className={'tag ' + (x.met ? (x.source === 'llm' ? 'ai' : 'hit') : 'miss')}>{x.requirement}</span>)}</div> : null;
                  })}
                  {c.hard_rule_failures?.length > 0 && <div className="note warn small">{c.hard_rule_failures.join('. ')}</div>}
                </section>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
