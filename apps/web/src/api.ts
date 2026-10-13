/* Thin API client: access token in memory, refresh via httpOnly cookie, one retry on 401.
 *
 * The browser talks to the API directly. Set VITE_API_URL to the API origin
 * (e.g. http://localhost:8000); in development it defaults to that, and in a
 * production build it defaults to the origin the app itself is served from. */
export interface User { id: string; email: string; name: string; role: string; roleName: string; permissions: string[] }

const configuredBase = import.meta.env.VITE_API_URL as string | undefined;
export const apiBase = (configuredBase ?? (import.meta.env.DEV ? 'http://localhost:8000' : '')).replace(/\/+$/, '');

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
let onSignedOut: () => void = () => undefined;

export function setSignedOutHandler(fn: () => void) { onSignedOut = fn; }
export function setToken(t: string | null) { accessToken = t; }

export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }

export async function refreshSession(): Promise<{ accessToken: string; user: User; mustChangePassword: boolean } | null> {
  const r = await fetch(apiBase + '/api/auth/refresh', { method: 'POST', credentials: 'include' });
  if (!r.ok) return null;
  const j = await r.json();
  accessToken = j.accessToken;
  return j;
}

async function raw(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
  const headers = new Headers(init.headers);
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const r = await fetch(apiBase + '/api' + path, { ...init, headers, credentials: 'include' });
  if (r.status === 401 && retry && !path.startsWith('/auth/')) {
    refreshing ??= refreshSession().then((x) => !!x).finally(() => { refreshing = null; });
    if (await refreshing) return raw(path, init, false);
    onSignedOut();
  }
  return r;
}

async function errorOf(r: Response) {
  try {
    const j = await r.json();
    const m = Array.isArray(j.message) ? j.message.join('; ') : j.message;
    return new ApiError(r.status, m || `Request failed (${r.status})`);
  } catch { return new ApiError(r.status, `Request failed (${r.status})`); }
}

export async function api<T = any>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const r = await raw(path, json !== undefined ? { ...rest, body: JSON.stringify(json) } : rest);
  if (!r.ok) throw await errorOf(r);
  if (r.status === 204) return undefined as T;
  const ct = r.headers.get('content-type') ?? '';
  return (ct.includes('json') ? r.json() : r.text()) as Promise<T>;
}
export const get = <T = any>(p: string) => api<T>(p);
export const post = <T = any>(p: string, json?: unknown) => api<T>(p, { method: 'POST', json: json ?? {} });
export const put = <T = any>(p: string, json: unknown) => api<T>(p, { method: 'PUT', json });
export const patch = <T = any>(p: string, json: unknown) => api<T>(p, { method: 'PATCH', json });
export const del = <T = any>(p: string) => api<T>(p, { method: 'DELETE' });
export const upload = <T = any>(p: string, form: FormData) => api<T>(p, { method: 'POST', body: form });

/** Download a file from an authenticated endpoint. */
export async function download(path: string, fallbackName: string) {
  const r = await raw(path);
  if (!r.ok) throw await errorOf(r);
  const cd = r.headers.get('content-disposition') ?? '';
  const name = decodeURIComponent(cd.match(/filename="?([^";]+)"?/)?.[1] ?? fallbackName);
  const url = URL.createObjectURL(await r.blob());
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
