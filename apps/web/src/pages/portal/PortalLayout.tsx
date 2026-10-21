import { Link, useLocation, useNavigate } from 'react-router-dom';
import { usePortalSession } from '../../portal';

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  const { applicant, signOut } = usePortalSession();
  const nav = useNavigate();
  const loc = useLocation();
  const links = [
    { to: '/jobs', label: 'Find jobs' },
    ...(applicant ? [{ to: '/portal/profile', label: 'Profile' }, { to: '/portal/applications', label: 'My applications' }] : []),
  ];
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 20, padding: '14px 28px', borderBottom: '1px solid var(--line)', background: 'var(--surface)', position: 'sticky', top: 0, zIndex: 10 }}>
        <Link to="/jobs" style={{ textDecoration: 'none', color: 'var(--ink)', display: 'flex', alignItems: 'center', gap: 10, fontWeight: 700 }}>
          <img src="/ecews-emblem.png" alt="ECEWS emblem" style={{ width: 28, height: 28 }} />
          <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.05 }}>
            <b>TalentScreen</b>
            <small className="muted" style={{ fontWeight: 500 }}>ECEWS Recruitment</small>
          </span>
        </Link>
        <nav style={{ display: 'flex', gap: 4, marginRight: 'auto' }}>
          {links.map((l) => (
            <Link key={l.to} to={l.to} className="btn ghost sm" style={{ fontWeight: loc.pathname.startsWith(l.to) ? 700 : 500 }}>{l.label}</Link>
          ))}
        </nav>
        {applicant ? (
          <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="muted small">{applicant.fullName}</span>
            <button className="btn sm" onClick={async () => { await signOut(); nav('/jobs'); }}>Sign out</button>
          </span>
        ) : (
          <span style={{ display: 'flex', gap: 8 }}>
            <Link className="btn sm ghost" to="/portal/login">Sign in</Link>
            <Link className="btn sm" to="/portal/register">Register</Link>
          </span>
        )}
      </header>
      <main style={{ flex: 1, width: '100%', maxWidth: 1000, margin: '0 auto', padding: '24px 20px 60px' }}>{children}</main>
    </div>
  );
}

/** Redirect to the portal sign-in screen unless an applicant session exists. */
export function RequireApplicant({ children }: { children: React.ReactNode }) {
  const { applicant } = usePortalSession();
  if (!applicant) return <PortalLayout><div className="empty">Sign in to continue. <Link to="/portal/login">Sign in</Link></div></PortalLayout>;
  return <>{children}</>;
}
