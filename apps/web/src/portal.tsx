import { createContext, ReactNode, useContext, useEffect, useState } from 'react';
import { apiBase } from './api';

export interface Applicant {
  id: string;
  email: string;
  fullName: string;
}

let applicantToken: string | null = null;
export function setApplicantToken(t: string | null) { applicantToken = t; }

async function portalRefresh(): Promise<Applicant | null> {
  const r = await fetch(apiBase + '/api/portal/refresh', { method: 'POST', credentials: 'include' });
  if (!r.ok) return null;
  const j = await r.json();
  applicantToken = j.accessToken;
  return j.applicant;
}

async function raw(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
  const headers = new Headers(init.headers);
  if (applicantToken) headers.set('Authorization', `Bearer ${applicantToken}`);
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const r = await fetch(apiBase + '/api/portal' + path, { ...init, headers, credentials: 'include' });
  if (r.status === 401 && retry && !path.startsWith('/login') && !path.startsWith('/register')) {
    const a = await portalRefresh();
    if (a) return raw(path, init, false);
  }
  return r;
}

async function errorOf(r: Response) {
  try {
    const j = await r.json();
    const m = Array.isArray(j.message) ? j.message.join('; ') : j.message;
    return new Error(m || `Request failed (${r.status})`);
  } catch { return new Error(`Request failed (${r.status})`); }
}

export async function papi<T = any>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const r = await raw(path, json !== undefined ? { ...rest, body: JSON.stringify(json) } : rest);
  if (!r.ok) throw await errorOf(r);
  if (r.status === 204) return undefined as T;
  return r.json() as Promise<T>;
}
export const pget = <T = any>(p: string) => papi<T>(p);
export const ppost = <T = any>(p: string, json?: unknown) => papi<T>(p, { method: 'POST', json: json ?? {} });
export const pput = <T = any>(p: string, json: unknown) => papi<T>(p, { method: 'PUT', json });
export const pupload = <T = any>(p: string, form: FormData) => papi<T>(p, { method: 'POST', body: form });

// ------------------------------------------------------------------ session
interface PortalSession {
  applicant: Applicant | null;
  setApplicant: (a: Applicant | null) => void;
  signOut: () => void;
}
const PortalSessionCtx = createContext<PortalSession>(null!);
export const usePortalSession = () => useContext(PortalSessionCtx);

export function PortalProvider({ children }: { children: ReactNode }) {
  const [applicant, setApplicant] = useState<Applicant | null>(null);
  useEffect(() => {
    portalRefresh().then((a) => { if (a) setApplicant(a); });
  }, []);
  const signOut = async () => {
    await fetch(apiBase + '/api/portal/logout', { method: 'POST', credentials: 'include' }).catch(() => undefined);
    setApplicantToken(null);
    setApplicant(null);
  };
  return <PortalSessionCtx.Provider value={{ applicant, setApplicant, signOut }}>{children}</PortalSessionCtx.Provider>;
}
