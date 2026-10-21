import { useEffect, useRef, useState } from 'react';
import { pget, pupload, pput, usePortalSession } from '../../portal';
import { useToast } from '../../lib';
import PortalLayout, { RequireApplicant } from './PortalLayout';

export default function PortalProfile() {
  return <PortalLayout><RequireApplicant><ProfileForm /></RequireApplicant></PortalLayout>;
}

function ProfileForm() {
  const { setApplicant } = usePortalSession();
  const toast = useToast();
  const [a, setA] = useState<any>(null);
  const [f, setF] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { pget<{ applicant: any }>('/me').then((r) => { setA(r.applicant); setF({ fullName: r.applicant.full_name, phone: r.applicant.phone, headline: r.applicant.headline, summary: r.applicant.summary, location: r.applicant.location, skills: r.applicant.skills.join(', ') }); }); }, []);

  async function save() {
    setBusy(true);
    try {
      const body = { fullName: f.fullName, phone: f.phone, headline: f.headline, summary: f.summary, location: f.location, skills: f.skills.split(',').map((s: string) => s.trim()).filter(Boolean) };
      const r = await pput<{ applicant: any }>('/me', body);
      setA(r.applicant); setApplicant({ id: r.applicant.id, email: r.applicant.email, fullName: r.applicant.full_name });
      toast('Profile saved');
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  }

  async function uploadCv(file: File) {
    if (!/\.(pdf|docx|txt)$/i.test(file.name)) { toast('Only PDF, DOCX and TXT files are accepted', true); return; }
    setBusy(true);
    try {
      const fd = new FormData(); fd.append('file', file);
      const r = await pupload<{ applicant: any }>('/me/cv', fd);
      setA(r.applicant);
      toast('CV uploaded');
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  }

  if (!a || !f) return <div className="empty">Loading profile…</div>;
  return (
    <>
      <h1>Your profile</h1>
      <div className="grid2">
        <section className="panel stack">
          <div className="section-title">Professional details</div>
          <label className="f">Full name<input value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} /></label>
          <label className="f">Headline<input value={f.headline} onChange={(e) => setF({ ...f, headline: e.target.value })} placeholder="e.g. Health Data Analyst" /></label>
          <label className="f">Phone<input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></label>
          <label className="f">Location<input value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} /></label>
          <label className="f">Skills (comma-separated)<input value={f.skills} onChange={(e) => setF({ ...f, skills: e.target.value })} placeholder="DHIS2, Excel, Power BI" /></label>
          <label className="f wide">Summary<textarea rows={6} value={f.summary} onChange={(e) => setF({ ...f, summary: e.target.value })} /></label>
          <div className="row"><button className="btn primary" disabled={busy} onClick={save}>Save profile</button></div>
        </section>
        <section className="panel stack">
          <div className="section-title">CV / résumé</div>
          {a.cv_file_name ? <div className="note">Current CV: <b>{a.cv_file_name}</b></div> : <div className="note">No CV uploaded yet. Add one so you can apply in one click.</div>}
          <input ref={input} type="file" accept=".pdf,.docx,.txt" onChange={(e) => e.target.files?.[0] && uploadCv(e.target.files[0])} />
          <p className="muted small" style={{ margin: 0 }}>Your CV is encrypted at rest and only shared with the team when you apply.</p>
        </section>
      </div>
    </>
  );
}
