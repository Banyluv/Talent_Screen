import { ReactNode, useEffect } from 'react';
import { STATUS_LABEL } from './lib';
import { useTheme } from './theme';

export function Pill({ value, label }: { value?: string | null; label?: string }) {
  if (!value) return <span className="muted">—</span>;
  return <span className={`pill p-${value}`}>{label ?? STATUS_LABEL[value] ?? value}</span>;
}

export function ScoreRing({ value, thresholds, lg }: { value?: number | null; thresholds?: { shortlist: number; consider: number; hold: number }; lg?: boolean }) {
  if (value === null || value === undefined) return <span className={'score' + (lg ? ' lg' : '')} style={{ ['--v' as any]: 0, ['--c' as any]: 'var(--line)' }}><span>…</span></span>;
  const t = thresholds ?? { shortlist: 85, consider: 65, hold: 50 };
  const c = value >= t.shortlist ? 'var(--green)' : value >= t.consider ? 'var(--amber)' : value >= t.hold ? 'var(--slate)' : 'var(--crimson)';
  return <span className={'score' + (lg ? ' lg' : '')} style={{ ['--v' as any]: value, ['--c' as any]: c }} aria-label={`Score ${value} of 100`}><span>{value}</span></span>;
}

export function Bar({ value }: { value: number }) {
  return <div className={'bar' + (value < 50 ? ' low' : '')} role="meter" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></div>;
}

export function Drawer({ title, eyebrow, onClose, children }: { title: ReactNode; eyebrow?: ReactNode; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="drawer" role="dialog" aria-modal="true">
        <div className="drawer-head"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1></div><button className="btn sm primary" onClick={onClose}>Close</button></div>
        {children}
      </div>
    </div>
  );
}

export function Loading({ what = 'Loading' }: { what?: string }) { return <div className="empty">{what}…</div>; }
export function ErrorBox({ error }: { error: string }) { return <div className="note warn">{error}</div>; }

export function PageHead({ eyebrow, title, children }: { eyebrow?: ReactNode; title: ReactNode; children?: ReactNode }) {
  return <div className="page-head"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1></div>{children}</div>;
}

const P = (d: string) => <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d={d} /></svg>;
export const Icon = {
  dashboard: P('M3 13h8V3H3zm10 8h8V11h-8zM3 21h8v-6H3zm10-18v6h8V3z'),
  vacancies: P('M10 3h4a2 2 0 0 1 2 2v2h4a1 1 0 0 1 1 1v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a1 1 0 0 1 1-1h4V5a2 2 0 0 1 2-2zm0 4h4V5h-4z'),
  candidates: P('M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-7 9a7 7 0 0 1 14 0v1H2zm15-9a3 3 0 1 0 0-6v6zm1 2.2A6.5 6.5 0 0 1 22 20v1h-4v-1a8.9 8.9 0 0 0-2.4-6.1c.8-.4 1.6-.7 2.4-.7z'),
  compare: P('M3 4h7v16H3zm11 0h7v16h-7zM5 7v2h3V7zm11 0v2h3V7z'),
  interviews: P('M7 2h2v2h6V2h2v2h3a1 1 0 0 1 1 1v15a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a1 1 0 0 1 1-1h3zm-2 8v10h14V10zm2 2h4v4H7z'),
  reports: P('M4 20h16v2H4zm1-8h3v6H5zm5-5h3v11h-3zm5 3h3v8h-3z'),
  users: P('M12 2 4 5v6c0 5 3.4 9.7 8 11 4.6-1.3 8-6 8-11V5zm0 5a3 3 0 1 1 0 6 3 3 0 0 1 0-6zm-5 10a5 5 0 0 1 10 0z'),
  roles: P('M7 14a5 5 0 1 1 4.9-6H22v4h-2v3h-3v-3h-5.1A5 5 0 0 1 7 14zm0-3a2 2 0 1 0 0-4 2 2 0 0 0 0 4z'),
  settings: P('M4 6h10v2H4zm14 0h2v2h-2zM4 16h4v2H4zm8 0h8v2h-8zm4-4h4v2h-4zM4 11h8v2H4zm11-6h2v4h-2zM9 15h2v4H9zm5-4h2v4h-2z'),
  audit: P('M6 2h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm8 1.5V8h4.5zM7 12h10v2H7zm0 4h10v2H7zm0-8h5v2H7z'),
  logout: P('M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h5v-2H5V5h5zM16.6 7.4 15.2 8.8 17.4 11H11v2h6.4l-2.2 2.2 1.4 1.4L21.4 12z'),
  // Eye / eye-with-slash for the password reveal control. Outlined rather than
  // filled so the pupil stays a hole at small sizes.
  eye: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ),
  eyeOff: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3.6-6.5 10-6.5c2.1 0 3.9.7 5.3 1.6" />
      <path d="M22 12s-3.6 6.5-10 6.5c-2.1 0-3.9-.7-5.3-1.6" />
      <path d="M4 4l16 16" />
    </svg>
  ),
  sun: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  ),
  moon: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  ),
  bell: P('M12 22a2.5 2.5 0 0 0 2.5-2.5h-5A2.5 2.5 0 0 0 12 22zm7-6V11a7 7 0 0 0-5.5-6.8V3a1.5 1.5 0 0 0-3 0v1.2A7 7 0 0 0 5 11v5l-2 2v1h18v-1z'),
};

/** Light/dark switch. Remembers the choice in this browser; until then it follows the OS. */
export function ThemeToggle({ className = 'icon-btn' }: { className?: string }) {
  const { theme, toggle } = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      className={className}
      onClick={toggle}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
    >
      {theme === 'dark' ? Icon.sun : Icon.moon}
    </button>
  );
}