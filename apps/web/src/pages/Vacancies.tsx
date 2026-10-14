import { DragEvent, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { download, upload } from '../api';
import { fmtDate, useAction, useCan, useData, useToast } from '../lib';
import { Drawer, ErrorBox, Loading, PageHead, Pill } from '../ui';

export default function Vacancies() {
  const can = useCan();
  const { data, error, reload } = useData<any[]>('/jobs');
  const [batch, setBatch] = useState(false);
  return (
    <>
      <PageHead eyebrow="Recruitment campaigns" title="Vacancies">
        {can('jobs.create') && <button className="btn primary" onClick={() => setBatch(true)}>Batch upload</button>}
        {can('jobs.create') ? <Link className="btn primary" to="/vacancies/new">New vacancy</Link>
          : can('hiring_requests.create') ? <Link className="btn primary" to="/vacancies/new">Raise hiring request</Link> : null}
      </PageHead>
      {batch && <BatchUpload onClose={() => setBatch(false)} onDone={reload} />}
      {error && <ErrorBox error={error} />}
      {!data ? <Loading /> : (
        <div className="tbl-wrap"><table>
          <thead><tr><th>Vacancy</th><th>Department</th><th>Location</th><th>Status</th><th className="n">Applicants</th><th className="n">Shortlist</th><th>Hiring manager</th><th>Opened</th></tr></thead>
          <tbody>
            {data.map((j) => (
              <tr key={j.id}>
                <td><Link to={`/vacancies/${j.id}`}>{j.title}</Link><div className="muted small mono">{j.ref_code}{j.project ? ` · ${j.project}` : ''}{j.evaluating > 0 && ` · ${j.evaluating} evaluating`}</div></td>
                <td>{j.department ?? '—'}</td><td>{j.location || '—'}{j.number_of_positions > 1 ? ` · ${j.number_of_positions} positions` : ''}</td>
                <td><Pill value={j.status} />{j.status === 'requested' && <div className="muted small">by {j.requested_by_name}</div>}</td>
                <td className="n">{j.applicants}</td><td className="n">{j.shortlisted}</td>
                <td>{j.hiring_manager ?? '—'}</td><td style={{ whiteSpace: 'nowrap' }}>{fmtDate(j.created_at)}</td>
              </tr>
            ))}
            {!data.length && <tr><td colSpan={8} className="empty">No vacancies available to your role yet.</td></tr>}
          </tbody>
        </table></div>
      )}
    </>
  );
}

/** Bulk-create vacancies from an Excel sheet or a Word document. */
function BatchUpload({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [result, setResult] = useState<any>(null);

  async function send(file?: File | null) {
    if (!file) return;
    if (!/\.(xlsx|xlsm|docx)$/i.test(file.name)) { toast('Upload an .xlsx spreadsheet or a .docx document', true); return; }
    const fd = new FormData();
    fd.append('file', file);
    const r = await run(() => upload('/jobs/batch', fd));
    if (input.current) input.current.value = '';
    if (r) { setResult(r); if (r.created.length) onDone(); }
  }
  const drop = (e: DragEvent) => { e.preventDefault(); setOver(false); send(e.dataTransfer.files?.[0]); };

  return (
    <Drawer title="Batch upload vacancies" eyebrow="Excel or Word" onClose={onClose}>
      <div className="stack">
        <div className={'drop' + (over ? ' over' : '')} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={drop}>
          <b>Drop a spreadsheet or document here</b>
          <div className="muted" style={{ margin: '4px 0 12px' }}>.xlsx — one row per vacancy · .docx — one Heading per vacancy</div>
          <label className="btn primary" htmlFor="batchFile">{busy ? 'Importing…' : 'Choose file'}</label>
          <input id="batchFile" ref={input} type="file" accept=".xlsx,.xlsm,.docx" hidden onChange={(e) => send(e.target.files?.[0])} />
        </div>

        <div className="row">
          <span className="muted small">Not sure of the format? Start from a template:</span>
          <button className="btn sm primary" disabled={busy} onClick={() => run(() => download('/jobs/batch/template?format=xlsx', 'vacancy-batch-template.xlsx'))}>Excel</button>
          <button className="btn sm primary" disabled={busy} onClick={() => run(() => download('/jobs/batch/template?format=docx', 'vacancy-batch-template.docx'))}>Word</button>
        </div>

        <div className="note">
          Each row or section becomes an <b>open</b> vacancy. <b>Title</b> and at least one technical skill are required;
          department names must already exist. Rows that fail are listed with the reason and the rest are still created.
        </div>

        {result && (
          <section className="panel stack">
            <div className="panel-head">
              <h2>Result</h2>
              <span className="tag hit">{result.created.length} created</span>
              {result.skipped.length > 0 && <span className="tag miss">{result.skipped.length} skipped</span>}
            </div>
            {result.truncated && <div className="note warn">Only the first rows in the file were read.</div>}
            {result.created.map((c: any) => (
              <div key={c.id}>
                <Link to={`/vacancies/${c.id}`}>{c.title}</Link> <span className="muted small mono">{c.ref}</span>
                {c.warnings?.map((w: string) => <div key={w} className="note warn">{w}</div>)}
              </div>
            ))}
            {result.skipped.map((s: any) => (
              <div key={`${s.label}-${s.reason}`}>
                <b>{s.title || s.label}</b>
                <div className="error">{s.label}: {s.reason}</div>
              </div>
            ))}
            {!result.created.length && !result.skipped.length && <div className="muted">Nothing to import.</div>}
          </section>
        )}
      </div>
    </Drawer>
  );
}
