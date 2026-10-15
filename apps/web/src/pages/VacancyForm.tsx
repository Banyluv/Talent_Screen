import { FormEvent, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { post, put } from '../api';
import { LEVELS, WEIGHT_LABELS, useAction, useCan, useData } from '../lib';
import { Loading, PageHead } from '../ui';

const LIST_FIELDS: [string, string, string, boolean?][] = [
  ['technicalSkills', 'Required technical skills', 'Comma-separated. Write alternatives as “A / B”, e.g. “Stata / SPSS”.', true],
  ['requiredCertifications', 'Required certifications', 'Put exam codes in brackets to improve matching, e.g. “Azure Administrator (AZ-104)”.', true],
  ['softSkills', 'Required soft skills', 'e.g. Communication, Leadership, Attention to detail'],
  ['preferredSkills', 'Preferred skills', ''],
  ['requiredQualifications', 'Required qualifications (description)', 'Shown to reviewers; the level and fields above drive scoring.'],
  ['preferredQualifications', 'Preferred qualifications', 'Each one found in a CV adds to the qualifications score, e.g. “MSc Information Technology”.'],
  ['industryExperience', 'Industry experience', 'e.g. NGO, Public health'],
  ['mandatory', 'Mandatory requirements', 'Any one missing → Reject (when the rule is switched on).', true],
  ['niceToHave', 'Nice-to-have', ''],
];
const DEFAULT_W = { qualifications: 20, technical: 30, experience: 30, certifications: 10, preferred: 5, progression: 5 };

export default function VacancyForm() {
  const { id } = useParams();
  const nav = useNavigate();
  const can = useCan();
  const { busy, run } = useAction();
  const existing = useData<any>(id ? `/jobs/${id}` : null);
  const depts = useData<any[]>('/departments');
  const directory = useData<any[]>(can('jobs.create') ? '/users' : null);
  const isRequest = !can('jobs.create');
  const [f, setF] = useState<any>({
    title: '', departmentId: '', location: '', employmentType: 'Full-time', description: '', closesOn: '',
    project: '', numberOfPositions: 1, reportsTo: '', levelOfEffort: '', minimumRecruitmentStandard: '',
    minQualificationLevel: '3', fieldsOfStudy: '', minYears: 3, preferredYears: 5, locationRequirements: '',
    technicalSkills: '', requiredCertifications: '', softSkills: '', preferredSkills: '', requiredQualifications: '', preferredQualifications: '',
    industryExperience: '', mandatory: '', niceToHave: '', hiringManagerId: '', recruiterIds: [] as string[], customWeights: false, weights: { ...DEFAULT_W },
  });
  const [err, setErr] = useState('');

  useEffect(() => {
    const j = existing.data; if (!j) return;
    const r = j.requirements; const join = (a: string[]) => (a ?? []).join(', ');
    setF({
      title: j.title, departmentId: j.department_id ?? '', location: j.location, employmentType: j.employment_type, description: j.description,
      closesOn: j.closes_on?.slice(0, 10) ?? '', project: j.project ?? '', numberOfPositions: j.number_of_positions ?? 1, reportsTo: j.reports_to ?? '',
      levelOfEffort: j.level_of_effort ?? '', minimumRecruitmentStandard: j.minimum_recruitment_standard ?? '',
      minQualificationLevel: String(r.minQualificationLevel), fieldsOfStudy: join(r.fieldsOfStudy),
      minYears: r.minYears, preferredYears: r.preferredYears, locationRequirements: r.locationRequirements ?? '',
      ...Object.fromEntries(LIST_FIELDS.map(([k]) => [k, join(r[k])])),
      hiringManagerId: j.hiring_manager_id ?? '', recruiterIds: j.recruiters.map((x: any) => x.id),
      customWeights: !!j.weights_override, weights: j.weights_override ?? j.effectiveWeights,
    });
  }, [existing.data]);

  const set = (k: string) => (e: any) => setF((x: any) => ({ ...x, [k]: e.target.value }));
  const wsum = Object.values(f.weights as Record<string, number>).reduce((a, b) => a + (+b || 0), 0);

  async function submit(e: FormEvent) {
    e.preventDefault(); setErr('');
    if (f.customWeights && wsum !== 100) { setErr(`Weights total ${wsum}%. They must total 100%.`); return; }
    const body = {
      title: f.title.trim(), departmentId: f.departmentId || undefined, location: f.location, employmentType: f.employmentType, description: f.description,
      closesOn: f.closesOn || undefined, project: f.project || undefined, numberOfPositions: +f.numberOfPositions || 1, reportsTo: f.reportsTo || undefined,
      levelOfEffort: f.levelOfEffort || undefined, minimumRecruitmentStandard: f.minimumRecruitmentStandard || undefined,
      hiringManagerId: f.hiringManagerId || undefined, recruiterIds: isRequest ? undefined : f.recruiterIds,
      weightsOverride: f.customWeights ? Object.fromEntries(Object.entries(f.weights).map(([k, v]) => [k, +(v as number)])) : null,
      requirements: {
        minQualificationLevel: +f.minQualificationLevel, fieldsOfStudy: f.fieldsOfStudy, minYears: +f.minYears, preferredYears: +f.preferredYears,
        locationRequirements: f.locationRequirements, ...Object.fromEntries(LIST_FIELDS.map(([k]) => [k, f[k]])),
      },
    };
    const r = await run(() => (id ? put(`/jobs/${id}`, body) : post('/jobs', body)),
      id ? 'Vacancy saved' : isRequest ? 'Hiring request submitted for approval' : 'Vacancy created');
    if (r) nav(`/vacancies/${id ?? r.id}`);
  }

  if (id && !existing.data) return <Loading />;
  const people = directory.data ?? [];
  return (
    <form className="stack" onSubmit={submit}>
      <PageHead eyebrow={id ? existing.data.ref_code : isRequest ? 'Hiring request' : 'New vacancy'} title={id ? `Edit ${existing.data.title}` : isRequest ? 'Raise a hiring request' : 'Create a vacancy'}>
        <button type="button" className="btn primary" onClick={() => nav(-1)}>Cancel</button>
        <button className="btn primary" disabled={busy}>{id ? 'Save changes' : isRequest ? 'Submit request' : 'Create vacancy'}</button>
      </PageHead>
      {id && <div className="note brand">Changing requirements or weights re-scores every candidate on this vacancy. Previous evaluations stay in each candidate's history.</div>}
      {isRequest && <div className="note">HR will review and open the vacancy. You can be specific: the requirements here become the scoring criteria.</div>}

      <section className="panel"><div className="panel-head"><h2>Role</h2></div>
        <div className="form-grid">
          <label className="f wide">Job title<input id="title" required minLength={3} value={f.title} onChange={set('title')} /></label>
          <label className="f">Department<select id="dept" value={f.departmentId} onChange={set('departmentId')}><option value="">—</option>{(depts.data ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
          <label className="f">Location<input id="loc" value={f.location} onChange={set('location')} placeholder="e.g. Uyo, Akwa Ibom" /></label>
          <label className="f">Project<input id="project" value={f.project} onChange={set('project')} placeholder="e.g. BRIDGE" /></label>
          <label className="f">Number of positions<input id="npos" type="number" min={1} max={1000} value={f.numberOfPositions} onChange={set('numberOfPositions')} /></label>
          <label className="f">Reports to<input id="reportsTo" value={f.reportsTo} onChange={set('reportsTo')} placeholder="e.g. State Director" /></label>
          <label className="f">Level of effort<input id="levelOfEffort" value={f.levelOfEffort} onChange={set('levelOfEffort')} placeholder="e.g. 100%" /></label>
          <label className="f">Employment type<select id="type" value={f.employmentType} onChange={set('employmentType')}>{['Full-time', 'Part-time', 'Contract', 'Consultancy', 'Internship', 'Temporary'].map((t) => <option key={t}>{t}</option>)}</select></label>
          <label className="f">Closing date<input id="closes" type="date" value={f.closesOn} onChange={set('closesOn')} /></label>
          <label className="f wide">Job description<textarea id="desc" rows={4} value={f.description} onChange={set('description')} /></label>
          <label className="f wide">Minimum recruitment standard<textarea id="minstd" rows={4} value={f.minimumRecruitmentStandard} onChange={set('minimumRecruitmentStandard')} placeholder="The minimum criteria as published in the advert, kept verbatim" /></label>
          <label className="f wide">Location requirements<input id="locreq" value={f.locationRequirements} onChange={set('locationRequirements')} placeholder="e.g. Must be able to travel to state offices" /></label>
        </div>
      </section>

      <section className="panel"><div className="panel-head"><h2>Qualifications and experience</h2></div>
        <div className="form-grid">
          <label className="f">Minimum qualification<select id="lvl" value={f.minQualificationLevel} onChange={set('minQualificationLevel')}>{Object.entries(LEVELS).map(([v, n]) => <option key={v} value={v}>{n}</option>)}</select></label>
          <label className="f">Relevant fields of study<input id="fields" value={f.fieldsOfStudy} onChange={set('fieldsOfStudy')} placeholder="computer science, information technology" /></label>
          <label className="f">Minimum years of experience<input id="min" type="number" min={0} max={40} value={f.minYears} onChange={set('minYears')} /></label>
          <label className="f">Preferred years of experience<input id="pref" type="number" min={0} max={40} value={f.preferredYears} onChange={set('preferredYears')} /></label>
        </div>
      </section>

      <section className="panel"><div className="panel-head"><h2>Requirements</h2></div>
        <div className="form-grid">
          {LIST_FIELDS.map(([k, label, hint, wide]) => (
            <label key={k} className={'f' + (wide ? ' wide' : '')}>{label}<input id={k} value={f[k]} onChange={set(k)} required={k === 'technicalSkills'} />{hint && <small>{hint}</small>}</label>
          ))}
        </div>
      </section>

      {!isRequest && (
        <section className="panel"><div className="panel-head"><h2>People</h2></div>
          <div className="form-grid">
            <label className="f">Hiring manager<select id="hm" value={f.hiringManagerId} onChange={set('hiringManagerId')}><option value="">—</option>
              {people.filter((u) => ['hiring_manager', 'hr_admin', 'super_admin'].includes(u.role_key)).map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}</select></label>
            <fieldset className="wide"><legend>Assigned recruiters</legend><div className="row">
              {people.filter((u) => u.role_key === 'recruiter').map((u) => (
                <label key={u.id} className="check"><input type="checkbox" checked={f.recruiterIds.includes(u.id)}
                  onChange={(e) => setF((x: any) => ({ ...x, recruiterIds: e.target.checked ? [...x.recruiterIds, u.id] : x.recruiterIds.filter((i: string) => i !== u.id) }))} />{u.full_name}</label>
              ))}
              {!people.some((u) => u.role_key === 'recruiter') && <span className="muted small">No recruiter accounts yet.</span>}
            </div></fieldset>
          </div>
        </section>
      )}

      {!isRequest && (
        <section className="panel"><div className="panel-head"><h2>Scoring weights</h2>{f.customWeights && <span className={'pill ' + (wsum === 100 ? 'p-Shortlist' : 'p-Reject')}>Total {wsum}%</span>}</div>
          <label className="check"><input type="checkbox" checked={f.customWeights} onChange={(e) => setF((x: any) => ({ ...x, customWeights: e.target.checked }))} />Use custom weights for this vacancy (otherwise the organisation default applies)</label>
          {f.customWeights && (
            <div className="form-grid" style={{ marginTop: 12 }}>
              {Object.keys(DEFAULT_W).map((k) => (
                <label key={k} className="f">{WEIGHT_LABELS[k]} (%)<input id={'w_' + k} type="number" min={0} max={100} value={f.weights[k]}
                  onChange={(e) => setF((x: any) => ({ ...x, weights: { ...x.weights, [k]: e.target.value } }))} /></label>
              ))}
            </div>
          )}
        </section>
      )}
      {err && <div className="error" role="alert">{err}</div>}
      <div className="row"><button className="btn primary" disabled={busy}>{id ? 'Save changes' : isRequest ? 'Submit request' : 'Create vacancy'}</button></div>
    </form>
  );
}
