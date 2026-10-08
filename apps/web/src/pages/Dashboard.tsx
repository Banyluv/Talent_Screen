import { Link } from 'react-router-dom';
import { fmtDateTime, useCan, useData, useSession } from '../lib';
import { ErrorBox, Loading, Pill, ScoreRing } from '../ui';

export default function Dashboard() {
  const { session } = useSession();
  const can = useCan();
  const { data: d, error } = useData<any>('/dashboard');
  if (error) return <ErrorBox error={error} />;
  if (!d) return <Loading />;
  const h = new Date().getHours();
  const first = session!.user.name.replace(/^Dr\.?\s*/, '').split(' ')[0];
  const isPanel = can('interviews.score') && !can('interviews.view');
  const byJob: Record<string, any[]> = {};
  d.top.forEach((t: any) => (byJob[t.title] ??= []).push(t));

  return (
    <>
      <div>
        <div className="eyebrow">{new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</div>
        <h1>Good {h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening'}, {first}</h1>
      </div>
      <div className="kpis">
        {isPanel ? (
          <>
            <div className="kpi accent"><b>{d.myInterviews.to_score}</b><span>Interviews to score</span></div>
            <div className="kpi"><b>{d.myInterviews.total}</b><span>Panels you sit on</span></div>
          </>
        ) : (
          <>
            <div className="kpi"><b>{d.open_jobs}</b><span>Open vacancies</span></div>
            <div className="kpi"><b>{d.candidates}</b><span>Applicants ({d.new_this_week} this week)</span></div>
            <div className="kpi"><b>{d.shortlisted}</b><span>Recommended for shortlist</span></div>
            <div className="kpi accent"><b>{d.awaiting_review}</b><span>Awaiting human review</span></div>
            <div className="kpi"><b>{d.interviewsUpcoming}</b><span>Upcoming interviews</span></div>
            {can('jobs.approve') && <div className="kpi"><b>{d.pending_requests}</b><span>Hiring requests to approve</span></div>}
          </>
        )}
      </div>
      {d.evaluating > 0 && <div className="note brand">{d.evaluating} CV{d.evaluating === 1 ? ' is' : 's are'} being evaluated. Results appear automatically.</div>}
      <div className="grid2">
        {d.top.length > 0 && (
          <section className="panel">
            <div className="panel-head"><h2>Top candidates by vacancy</h2></div>
            {Object.entries(byJob).map(([title, list]) => (
              <div key={title} style={{ marginBottom: 14 }}>
                <div className="row" style={{ marginBottom: 4 }}><div className="eyebrow" style={{ marginRight: 'auto' }}>{title}</div><Link className="small" to={`/vacancies/${list[0].job_id}/ranking`}>Full ranking</Link></div>
                <div className="list">
                  {list.map((c) => (
                    <div key={c.id} style={{ alignItems: 'center' }}>
                      <ScoreRing value={c.overall_score} />
                      <div style={{ flex: 1, minWidth: 0 }}><Link to={`/candidates/${c.id}`}><b>{c.full_name}</b></Link><div className="muted small">{c.relevant_years} years relevant experience</div></div>
                      <Pill value={c.recommendation} />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </section>
        )}
        {d.activity.length > 0 && (
          <section className="panel">
            <div className="panel-head"><h2>Recent activity</h2><Link className="btn sm" to="/admin/audit">Audit log</Link></div>
            <div className="list">
              {d.activity.map((a: any, i: number) => (
                <div key={i}><div style={{ minWidth: 0 }}><b style={{ fontWeight: 600 }}>{a.action}</b><div className="muted small">{a.actor_email} · {fmtDateTime(a.at)}</div></div></div>
              ))}
            </div>
          </section>
        )}
        {isPanel && <section className="panel"><h2>Your interviews</h2><p className="muted">Open <Link to="/interviews">Interviews</Link> to see your panels and submit scores.</p></section>}
        {!d.top.length && !isPanel && !d.activity.length && (
          <section className="panel"><h2>Nothing to review yet</h2><p className="muted">{can('jobs.create') ? <>Create a vacancy, then upload CVs. <Link to="/vacancies/new">New vacancy</Link></> : can('reports.view') ? <>See <Link to="/reports">Reports</Link>.</> : 'Assigned work will appear here.'}</p></section>
        )}
      </div>
    </>
  );
}
