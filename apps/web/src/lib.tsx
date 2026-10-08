import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api, User } from './api';

// ------------------------------------------------------------------ session
export interface Session { user: User; mustChangePassword: boolean }
export const SessionCtx = createContext<{ session: Session | null; setSession: (s: Session | null) => void; signOut: () => void }>(null!);
export const useSession = () => useContext(SessionCtx);
export function useCan() {
  const { session } = useSession();
  return (...perms: string[]) => !!session && perms.some((p) => session.user.permissions.includes(p));
}

// ------------------------------------------------------------------ data loading
export function useData<T = any>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!path);
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!path) return;
    const n = ++seq.current;
    setLoading(true);
    try { const d = await api<T>(path); if (n === seq.current) { setData(d); setError(null); } }
    catch (e) { if (n === seq.current) setError((e as Error).message); }
    finally { if (n === seq.current) setLoading(false); }
  }, [path]);
  useEffect(() => { load(); }, [load, ...deps]);
  return { data, error, loading, reload: load, setData };
}

// ------------------------------------------------------------------ toasts
type Toast = { id: number; text: string; err?: boolean };
const ToastCtx = createContext<(text: string, err?: boolean) => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, err = false) => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, text, err }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), err ? 6000 : 3000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">{items.map((t) => <div key={t.id} className={'toast' + (t.err ? ' err' : '')}>{t.text}</div>)}</div>
    </ToastCtx.Provider>
  );
}

/** Wrap an async action: shows errors as toasts, returns a busy flag. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>, ok?: string): Promise<T | undefined> => {
    setBusy(true);
    try { const r = await fn(); if (ok) toast(ok); return r; }
    catch (e) { toast((e as Error).message, true); return undefined; }
    finally { setBusy(false); }
  }, [toast]);
  return { busy, run };
}

// ------------------------------------------------------------------ formatting
export const fmtDate = (d?: string | null) => (d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
export const fmtDateTime = (d?: string | null) => (d ? new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
export const initials = (n = '') => n.replace(/^Dr\.?\s*/, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
export const LEVELS: Record<string, string> = { '1': 'Secondary (SSCE/WAEC)', '2': 'Diploma (OND/ND)', '3': "Bachelor's / HND", '3.5': 'Postgraduate Diploma', '4': "Master's", '5': 'Doctorate' };
export const STATUS_LABEL: Record<string, string> = {
  new: 'New', screening: 'Screening', shortlisted: 'Shortlisted', interview: 'Interview', offer: 'Offer', hired: 'Hired', rejected: 'Rejected', withdrawn: 'Withdrawn',
  open: 'Open', requested: 'Hiring request', closed: 'Closed', filled: 'Filled', draft: 'Draft', hire: 'Hire', hold: 'Hold', no_hire: 'Do not hire',
  pending: 'Queued', running: 'Evaluating', completed: 'Completed', failed: 'Failed', scheduled: 'Scheduled', cancelled: 'Cancelled',
};
export const WEIGHT_LABELS: Record<string, string> = {
  qualifications: 'Qualifications', technical: 'Technical skills', experience: 'Relevant experience',
  certifications: 'Certifications', preferred: 'Preferred & soft skills', progression: 'Career progression',
};
