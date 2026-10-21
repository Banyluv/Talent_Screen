import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { WEIGHT_LABELS, useData } from '../lib';
import { Bar, Loading, PageHead, Pill, ScoreRing } from '../ui';

function VacancyCombobox({ jobs, selectedId, onSelect }: { jobs: any[]; selectedId: string; onSelect: (id: string) => void }) {
  const selected = jobs.find((j) => j.id === selectedId);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(selected?.title ?? '');
  useEffect(() => { setText(selected?.title ?? ''); }, [selectedId]);
  const needle = text.trim().toLowerCase();
  const options = needle ? jobs.filter((j) => j.title.toLowerCase().includes(needle)) : jobs;
  return (
    <div style={{ position: 'relative', width: 'min(340px, 100%)' }}>
      <input
        type="text"
        value={text}
        placeholder="Select or search a vacancy"
        onChange={(e) => { setText(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => { setOpen(false); setText(selected?.title ?? ''); }}
        style={{ width: '100%' }}
      />
      {open && (
        <ul style={{ position: 'absolute', zIndex: 20, top: '100%', left: 0, right: 0, margin: '4px 0 0', padding: 0, listStyle: 'none', background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, maxHeight: 320, overflowY: 'auto', boxShadow: '0 8px 24px rgba(0,0,0,0.18)' }}>
          {options.map((j) => (
            <li
              key={j.id}
              onMouseDown={(e) => { e.preventDefault(); onSelect(j.id); setOpen(false); }}
              style={{ padding: '9px 12px', cursor: 'pointer', fontWeight: j.id === selectedId ? 600 : 400, background: j.id === selectedId ? 'var(--tint)' : 'transparent' }}
            >{j.title}</li>
          ))}
          {!options.length && <li style={{ padding: '9px 12px' }}>No matching vacancy</li>}
        </ul>
      )}
    </div>
  );
}

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
  const thr = { shortlist: 70, consider: 65, hold: 50 };

  return (
    <>
      <PageHead eyebrow="Side by side" title="Compare candidates">
        <VacancyCombobox jobs={open} selectedId={jobId} onSelect={(id) => setParams({ job: id })} />
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
