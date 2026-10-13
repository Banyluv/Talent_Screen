import { useState } from 'react';
import { download } from '../api';
import { STATUS_LABEL, useAction, useCan, useData } from '../lib';
import { ErrorBox, Loading, PageHead } from '../ui';

const REC_COLOR: Record<string, string> = { Shortlist: 'var(--green)', Consider: 'var(--amber)', Hold: 'var(--slate)', Reject: 'var(--crimson)' };
const PIPE = ['new', 'screening', 'shortlisted', 'interview', 'offer', 'hired', 'rejected', 'withdrawn'];

export default function Reports() {
  const can = useCan();
  // Reports are historical: include vacancies that have since expired.
  const jobs = useData<any[]>('/jobs?includeExpired=true');
  const [jobId, setJobId] = useState('');
  const { data: s, error } = useData<any>('/reports/summary' + (jobId ? `?jobId=${jobId}` : ''));
  const { busy, run } = useAction();
  const exp = (format: string) => run(() => download(`/reports/export?format=${format}${jobId ? `&jobId=${jobId}` : ''}`, `ranking.${format}`));

  const recs = ['Shortlist', 'Consider', 'Hold', 'Reject'];
  const count = (r: string) => s?.byRec.find((x: any) => x.recommendation === r)?.n ?? 0;
  const total = recs.reduce((a, r) => a + count(r), 0) || 1;
  let acc = 0;
  const grad = recs.map((r) => { const a = acc; acc += (count(r) / total) * 100; return `${REC_COLOR[r]} ${a}% ${acc}%`; }).join(',');
  const bins = Array.from({ length: 10 }, (_, i) => s?.histogram.find((h: any) => h.bucket === i + 1)?.n ?? 0);
  const mx = Math.max(1, ...bins);
  const pipe = PIPE.map((p) => [p, s?.pipeline.find((x: any) => x.status === p)?.n ?? 0] as [string, number]).filter(([, n]) => n > 0);
  const pmx = Math.max(1, ...pipe.map((p) => p[1]));
  const gmx = Math.max(1, ...(s?.gaps ?? []).map((g: any) => g.n));

  return (
    <>
      <PageHead eyebrow="Recruitment analytics" title="Reports">
        <select id="job" style={{ width: 'auto', maxWidth: '100%' }} value={jobId} onChange={(e) => setJobId(e.target.value)}>
          <option value="">All vacancies</option>{(jobs.data ?? []).filter((j) => j.status !== 'requested').map((j) => <option key={j.id} value={j.id}>{j.title}</option>)}</select>
        {can('reports.export') && <>
          <button className="btn" disabled={busy} onClick={() => exp('pdf')}>Export PDF</button>
          <button className="btn" disabled={busy} onClick={() => exp('xlsx')}>Export Excel</button>
          <button className="btn" disabled={busy} onClick={() => exp('csv')}>Export CSV</button></>}
      </PageHead>
      {error && <ErrorBox error={error} />}
      {!s ? <Loading /> : (
        <>
          <div className="kpis">
            <div className="kpi"><b>{s.totals.evaluated}</b><span>Candidates evaluated</span></div>
            <div className="kpi"><b>{s.totals.avg_score ?? '—'}</b><span>Average score</span></div>
            <div className="kpi"><b>{count('Shortlist')}</b><span>Recommended for shortlist</span></div>
            <div className="kpi accent"><b>{s.totals.overrides}</b><span>Human overrides</span></div>
            <div className="kpi"><b>{s.totals.ai_assisted}</b><span>AI-assisted evaluations</span></div>
          </div>
          <div className="grid2">
            <section className="panel"><div className="panel-head"><h2>Recommendation mix</h2></div>
              <div className="row" style={{ gap: 24 }}>
                <div className="donut" role="img" aria-label="Recommendation mix" style={{ background: s.totals.evaluated ? `conic-gradient(${grad})` : 'var(--line)' }} />
                <div className="legend">{recs.map((r) => <div key={r}><i style={{ background: REC_COLOR[r] }} />{r} <b className="num">{count(r)}</b> <span className="muted">({Math.round((count(r) / total) * 100)}%)</span></div>)}</div>
              </div></section>
            <section className="panel"><div className="panel-head"><h2>Score distribution</h2></div>
              <div className="histo">{bins.map((b, i) => <div key={i} style={{ height: `${(b / mx) * 100}%`, opacity: b ? 1 : 0.25 }}><span>{b || ''}</span></div>)}</div>
              <div className="histo-x">{bins.map((_, i) => <span key={i}>{i * 10}</span>)}</div></section>
            <section className="panel"><div className="panel-head"><h2>Pipeline</h2></div>
              <div className="stack" style={{ gap: 10 }}>{pipe.map(([p, n]) => <div key={p} className="hbar"><span>{STATUS_LABEL[p]}</span><div className="bar"><i style={{ width: `${(n / pmx) * 100}%` }} /></div><span className="num">{n}</span></div>)}
                {!pipe.length && <span className="muted">No candidates yet.</span>}</div></section>
            <section className="panel"><div className="panel-head"><h2>Most common gaps</h2></div>
              <div className="stack" style={{ gap: 10 }}>{s.gaps.map((g: any) => <div key={g.gap}><div className="spread small"><span>{g.gap}</span><span className="num">{g.n}</span></div><div className="bar low"><i style={{ width: `${(g.n / gmx) * 100}%` }} /></div></div>)}
                {!s.gaps.length && <span className="muted">No data.</span>}</div></section>
          </div>
          <section className="panel"><div className="panel-head"><h2>By vacancy</h2></div>
            <div className="tbl-wrap"><table><thead><tr><th>Vacancy</th><th>Status</th><th className="n">Applicants</th><th className="n">Avg score</th><th className="n">Shortlisted</th><th className="n">Hired</th></tr></thead>
              <tbody>{s.byJob.map((j: any) => <tr key={j.id}><td>{j.title}</td><td>{STATUS_LABEL[j.status]}</td><td className="n">{j.applicants}</td><td className="n">{j.avg_score ?? '—'}</td><td className="n">{j.shortlisted}</td><td className="n">{j.hired}</td></tr>)}</tbody></table></div>
          </section>
        </>
      )}
    </>
  );
}
