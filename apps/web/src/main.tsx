import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import './styles.css';
import { post, refreshSession, setSignedOutHandler, setToken } from './api';
import { Session, SessionCtx, ToastProvider, initials, useCan, useData, useSession } from './lib';
import { Icon, ThemeToggle } from './ui';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Vacancies from './pages/Vacancies';
import VacancyForm from './pages/VacancyForm';
import VacancyDetail from './pages/VacancyDetail';
import Candidates from './pages/Candidates';
import CandidateDetail from './pages/CandidateDetail';
import Compare from './pages/Compare';
import Interviews from './pages/Interviews';
import Reports from './pages/Reports';
import Users from './pages/Users';
import Roles from './pages/Roles';
import Settings from './pages/Settings';
import Audit from './pages/Audit';
import Notifications from './pages/Notifications';
import Account from './pages/Account';

const NAV: { group?: string; to: string; label: string; icon: keyof typeof Icon; perms: string[] }[] = [
  { to: '/', label: 'Dashboard', icon: 'dashboard', perms: [] },
  { group: 'Recruitment', to: '/vacancies', label: 'Vacancies', icon: 'vacancies', perms: ['jobs.view_all', 'jobs.view_assigned', 'hiring_requests.create'] },
  { to: '/candidates', label: 'Candidates', icon: 'candidates', perms: ['candidates.view', 'candidates.view_assigned'] },
  { to: '/compare', label: 'Compare', icon: 'compare', perms: ['evaluations.view', 'shortlist.review'] },
  { to: '/interviews', label: 'Interviews', icon: 'interviews', perms: ['interviews.view', 'interviews.score', 'interviews.schedule'] },
  { to: '/reports', label: 'Reports', icon: 'reports', perms: ['reports.view'] },
  { group: 'Administration', to: '/admin/users', label: 'Users', icon: 'users', perms: ['users.manage'] },
  { to: '/admin/roles', label: 'Roles & permissions', icon: 'roles', perms: ['roles.manage'] },
  { to: '/admin/settings', label: 'Scoring & AI', icon: 'settings', perms: ['scoring.configure', 'ai.configure'] },
  { to: '/admin/audit', label: 'Audit log', icon: 'audit', perms: ['audit.view'] },
];

function Shell({ children }: { children: React.ReactNode }) {
  const { session, signOut } = useSession();
  const can = useCan();
  const loc = useLocation();
  const notes = useData<any[]>('/notifications', [loc.pathname]);
  const unread = (notes.data ?? []).filter((n) => !n.read_at).length;
  const items = NAV.filter((n) => !n.perms.length || can(...n.perms));
  const title = [...items].reverse().find((n) => n.to === '/' ? loc.pathname === '/' : loc.pathname.startsWith(n.to))?.label ?? '';
  let lastGroup: string | undefined;
  return (
    <div className="app">
      <aside className="side">
        <NavLink to="/" className="brand"><img src="/ecews-emblem.png" alt="ECEWS emblem" /><div><b>TalentScreen</b><small>ECEWS Recruitment</small></div></NavLink>
        <nav className="nav" aria-label="Main">
          {items.map((n) => {
            const g = n.group && n.group !== lastGroup ? <div className="group" key={'g' + n.group}>{n.group}</div> : null;
            if (n.group) lastGroup = n.group;
            return <React.Fragment key={n.to}>{g}<NavLink to={n.to} end={n.to === '/'}>{Icon[n.icon]}{n.label}</NavLink></React.Fragment>;
          })}
        </nav>
        <div className="foot">Decision support only. Every recommendation is reviewed by authorised ECEWS staff before any hiring decision.</div>
      </aside>
      <div className="main">
        <header className="top">
          <div className="title">{title}</div>
          <NavLink to="/notifications" className="icon-btn" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}>{Icon.bell}{unread > 0 && <span className="dot">{unread}</span>}</NavLink>
          <ThemeToggle />
          <NavLink to="/account" className="me"><div className="avatar">{initials(session!.user.name)}</div><div className="who">{session!.user.name}<span>{session!.user.roleName}</span></div></NavLink>
          <button className="icon-btn" onClick={signOut} aria-label="Sign out" title="Sign out">{Icon.logout}</button>
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}

function Guard({ perms, children }: { perms?: string[]; children: React.ReactElement }) {
  const can = useCan();
  if (perms?.length && !can(...perms)) return <div className="empty">Your role does not have access to this page.</div>;
  return children;
}

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setSignedOutHandler(() => { setToken(null); setSession(null); });
    refreshSession().then((s) => { if (s) setSession({ user: s.user, mustChangePassword: s.mustChangePassword }); }).finally(() => setReady(true));
  }, []);
  const signOut = async () => { await post('/auth/logout').catch(() => undefined); setToken(null); setSession(null); };
  if (!ready) return <div className="login"><div className="muted">Loading TalentScreen…</div></div>;
  return (
    <SessionCtx.Provider value={{ session, setSession, signOut }}>
      <ToastProvider>
        <BrowserRouter>
          {!session ? (
            <Routes><Route path="*" element={<Login />} /></Routes>
          ) : session.mustChangePassword ? (
            <Routes><Route path="*" element={<div className="login"><div className="login-card"><Account forced /></div></div>} /></Routes>
          ) : (
            <Shell>
              <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/vacancies" element={<Guard perms={NAV[1].perms}><Vacancies /></Guard>} />
                <Route path="/vacancies/new" element={<Guard perms={['jobs.create', 'hiring_requests.create']}><VacancyForm /></Guard>} />
                <Route path="/vacancies/:id/edit" element={<Guard perms={['jobs.edit']}><VacancyForm /></Guard>} />
                <Route path="/vacancies/:id" element={<VacancyDetail />} />
                <Route path="/vacancies/:id/:tab" element={<VacancyDetail />} />
                <Route path="/candidates" element={<Guard perms={NAV[2].perms}><Candidates /></Guard>} />
                <Route path="/candidates/:id" element={<Guard perms={NAV[2].perms}><CandidateDetail /></Guard>} />
                <Route path="/compare" element={<Guard perms={NAV[3].perms}><Compare /></Guard>} />
                <Route path="/interviews" element={<Guard perms={NAV[4].perms}><Interviews /></Guard>} />
                <Route path="/reports" element={<Guard perms={['reports.view']}><Reports /></Guard>} />
                <Route path="/admin/users" element={<Guard perms={['users.manage']}><Users /></Guard>} />
                <Route path="/admin/roles" element={<Guard perms={['roles.manage']}><Roles /></Guard>} />
                <Route path="/admin/settings" element={<Guard perms={['scoring.configure', 'ai.configure']}><Settings /></Guard>} />
                <Route path="/admin/audit" element={<Guard perms={['audit.view']}><Audit /></Guard>} />
                <Route path="/notifications" element={<Notifications />} />
                <Route path="/account" element={<Account />} />
                <Route path="/login" element={<Navigate to="/" replace />} />
                <Route path="*" element={<div className="empty">Page not found.</div>} />
              </Routes>
            </Shell>
          )}
        </BrowserRouter>
      </ToastProvider>
    </SessionCtx.Provider>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
