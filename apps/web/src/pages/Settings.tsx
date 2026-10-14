import { useEffect, useState } from 'react';
import { post, put } from '../api';
import { WEIGHT_LABELS, useAction, useCan, useData, useToast } from '../lib';
import { Loading, PageHead } from '../ui';

export default function Settings() {
  const can = useCan();
  return (
    <>
      <PageHead eyebrow="Administration" title="Scoring and AI settings" />
      {can('scoring.configure') && <Scoring />}
      {can('ai.configure', 'scoring.configure') && <Ai readOnly={!can('ai.configure')} />}
      {can('ai.configure') && <Mail />}
    </>
  );
}

function Scoring() {
  const { data, reload } = useData<any[]>('/settings/scoring');
  const { busy, run } = useAction();
  const [f, setF] = useState<any>(null);
  const [rescore, setRescore] = useState(true);
  useEffect(() => { const d = data?.find((p) => p.is_default); if (d) setF({ weights: { ...d.weights }, thresholds: { ...d.thresholds }, rules: { ...d.rules } }); }, [data]);
  if (!f) return <Loading />;
  const sum = Object.values(f.weights as Record<string, number>).reduce((a, b) => a + (+b || 0), 0);
  const setW = (k: string, v: string) => setF({ ...f, weights: { ...f.weights, [k]: +v } });
  const setT = (k: string, v: string) => setF({ ...f, thresholds: { ...f.thresholds, [k]: +v } });
  const save = async () => {
    const r = await run(() => put('/settings/scoring/default', { ...f, rescore }));
    if (r) { reload(); }
    return r;
  };
  return (
    <>
      <section className="panel">
        <div className="panel-head"><h2>Default scoring weights</h2><span className={'pill ' + (sum === 100 ? 'p-Shortlist' : 'p-Reject')}>Total {sum}%</span></div>
        <div className="form-grid">{Object.keys(WEIGHT_LABELS).map((k) => <label key={k} className="f">{WEIGHT_LABELS[k]} (%)<input id={'w_' + k} type="number" min={0} max={100} value={f.weights[k]} onChange={(e) => setW(k, e.target.value)} /></label>)}</div>
        <p className="muted small" style={{ marginBottom: 0 }}>Vacancies can override these weights individually.</p>
      </section>
      <section className="panel">
        <div className="panel-head"><h2>Recommendation thresholds and rules</h2></div>
        <div className="form-grid">
          <label className="f">Shortlist at or above<input id="t_s" type="number" value={f.thresholds.shortlist} onChange={(e) => setT('shortlist', e.target.value)} /></label>
          <label className="f">Consider at or above<input id="t_c" type="number" value={f.thresholds.consider} onChange={(e) => setT('consider', e.target.value)} /></label>
          <label className="f">Hold at or above<input id="t_h" type="number" value={f.thresholds.hold} onChange={(e) => setT('hold', e.target.value)} /><small>Below this: Reject</small></label>
          <label className="f">Experience counted for minimums<select id="basis" value={f.rules.experienceBasis} onChange={(e) => setF({ ...f, rules: { ...f.rules, experienceBasis: e.target.value } })}>
            <option value="relevant">Relevant experience only</option><option value="total">Total experience</option></select></label>
        </div>
        <div className="stack" style={{ marginTop: 14, gap: 8 }}>
          <label className="check"><input type="checkbox" checked={f.rules.enforceMinExperience} onChange={(e) => setF({ ...f, rules: { ...f.rules, enforceMinExperience: e.target.checked } })} />Reject when experience is below the vacancy minimum</label>
          <label className="check"><input type="checkbox" checked={f.rules.enforceMandatory} onChange={(e) => setF({ ...f, rules: { ...f.rules, enforceMandatory: e.target.checked } })} />Reject when a mandatory requirement has no evidence</label>
          <label className="check"><input type="checkbox" checked={rescore} onChange={(e) => setRescore(e.target.checked)} />Re-score every candidate on open and closed vacancies after saving</label>
        </div>
        <div className="row" style={{ marginTop: 14 }}><button className="btn primary" disabled={busy || sum !== 100} onClick={save}>Save scoring rules</button></div>
      </section>
    </>
  );
}

function Ai({ readOnly }: { readOnly: boolean }) {
  const { data, reload } = useData<any>('/settings/ai');
  const { busy, run } = useAction();
  const [f, setF] = useState<any>(null);
  useEffect(() => { if (data) setF({ provider: data.provider, temperature: Number(data.temperature), requireEvidence: data.require_evidence, redactPii: data.redact_pii, generateNarrative: data.generate_narrative, retentionMonths: data.retention_months }); }, [data]);
  if (!f || !data) return <Loading />;
  const st = data.status;
  return (
    <section className="panel">
      <div className="panel-head"><h2>AI evaluation</h2></div>
      <div className="form-grid">
        <label className="f">Evaluation engine<select id="prov" disabled={readOnly} value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value })}>
          <option value="rules">Rules engine only (no data leaves the server)</option>
          <option value="azure-openai" disabled={!st['azure-openai'].ok}>Azure OpenAI + rules{!st['azure-openai'].ok ? ' (not configured)' : ''}</option>
          <option value="openai" disabled={!st.openai.ok}>OpenAI + rules{!st.openai.ok ? ' (not configured)' : ''}</option>
        </select><small>Keys and endpoints are set in the server environment, never in the browser.</small></label>
        <label className="f">Model temperature<input id="temp" type="number" step="0.1" min={0} max={1} disabled={readOnly} value={f.temperature} onChange={(e) => setF({ ...f, temperature: +e.target.value })} /><small>0 gives the most repeatable results.</small></label>
        <label className="f">Retention (months)<input id="ret" type="number" min={1} max={120} disabled={readOnly} value={f.retentionMonths} onChange={(e) => setF({ ...f, retentionMonths: +e.target.value })} /><small>Personal data on closed vacancies is erased after this period. Hired candidates are kept.</small></label>
      </div>
      <div className="stack" style={{ marginTop: 14, gap: 8 }}>
        <label className="check"><input type="checkbox" disabled={readOnly} checked={f.requireEvidence} onChange={(e) => setF({ ...f, requireEvidence: e.target.checked })} />Show a quoted CV line for every strength</label>
        <label className="check"><input type="checkbox" disabled={readOnly} checked={f.redactPii} onChange={(e) => setF({ ...f, redactPii: e.target.checked })} />Remove name, email and phone before CV text is sent to the AI provider</label>
        <label className="check"><input type="checkbox" disabled={readOnly} checked={f.generateNarrative} onChange={(e) => setF({ ...f, generateNarrative: e.target.checked })} />Write a short AI summary from the computed facts</label>
      </div>
      <div className="note" style={{ marginTop: 14 }}>The AI model only checks requirements the rules engine could not evidence. Every claim must quote the CV word for word; claims that don't are discarded and logged. Scores are always computed by the rules engine, so they stay explainable.</div>
      {!readOnly && <div className="row" style={{ marginTop: 14 }}><button className="btn primary" disabled={busy} onClick={async () => { await run(() => put('/settings/ai', f), 'AI settings saved'); reload(); }}>Save AI settings</button></div>}
    </section>
  );
}

function Mail() {
  const { data, loading } = useData<any>('/settings/mail');
  const { busy, run } = useAction();
  const toast = useToast();
  const [to, setTo] = useState('');
  if (loading || !data) return <Loading />;
  const send = async () => {
    const r = await run(() => post<{ ok: boolean; message: string }>('/settings/mail/test', { to }));
    if (r) toast(r.message, !r.ok);
  };
  return (
    <section className="panel">
      <div className="panel-head"><h2>Outbound email</h2><span className={'pill ' + (data.configured ? 'p-Shortlist' : 'p-Reject')}>{data.configured ? 'Configured' : 'Not configured'}</span></div>
      {data.configured ? (
        <p className="muted" style={{ marginTop: 0 }}>
          Emails — for example, when an interview panel is assigned — are sent from <strong>{data.from}</strong> via <strong>{data.host}:{data.port}</strong>{data.secure ? ' over TLS' : ''}{data.authenticated ? ' (authenticated)' : ''}.
        </p>
      ) : (
        <div className="note" style={{ marginTop: 0 }}>
          No SMTP server is configured, so email notifications are skipped. Set SMTP_HOST, SMTP_PORT, SMTP_USER,
          SMTP_PASS and SMTP_FROM in the server environment, then restart the API. These stay on the server and are
          never shown in the browser.
        </div>
      )}
      <div className="row" style={{ marginTop: 14, gap: 8 }}>
        <input id="mail_to" type="email" placeholder="you@example.com" value={to} onChange={(e) => setTo(e.target.value)} style={{ minWidth: 260 }} />
        <button className="btn primary" disabled={busy || !to || !data.configured} onClick={send}>Send test email</button>
      </div>
    </section>
  );
}
