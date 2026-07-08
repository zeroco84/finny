import { useEffect, useState } from 'react';
import { NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import type { SessionUser } from '@finny/shared';
import { api, ApiError } from './api';
import logo from './assets/finny-logo.png';
import { MetaProvider, useMeta } from './meta';
import Login from './pages/Login';
import Queue from './pages/Queue';
import InvoiceDetailPage from './pages/InvoiceDetail';
import RulesPage from './pages/Rules';
import AlertsPage from './pages/Alerts';
import ExportsPage from './pages/Exports';
import DashboardPage from './pages/Dashboard';
import SettingsPage from './pages/Settings';
import GuidePage from './pages/Guide';

function Badge({ n, tone = 'default' }: { n: number | undefined; tone?: 'default' | 'alert' }) {
  if (!n) return null;
  return <span className={`nav-badge ${tone === 'alert' ? 'nav-badge-alert' : ''}`}>{n}</span>;
}

function Shell() {
  const { user, settings, overview, signOut } = useMeta();
  const navigate = useNavigate();
  return (
    <div className="shell">
      {settings.mode === 'shadow' && (
        <div className="mode-strip">
          SHADOW MODE — the AI proposes and learns, but nothing is sent to Sage or Teams.
          {user.role === 'lead' ? ' Go live from Settings when the accuracy report is ready.' : ''}
        </div>
      )}
      <header className="topbar">
        <button className="wordmark" onClick={() => navigate('/')}>
          <img src={logo} alt="" className="nav-logo" />
          Finny<span className="wordmark-sub">Accounts Payable</span>
        </button>
        <nav>
          <NavLink to="/" end>
            Queue <Badge n={overview?.counts.needs_review} />
          </NavLink>
          <NavLink to="/rules">
            Rules <Badge n={overview?.counts.pending_rules} />
          </NavLink>
          <NavLink to="/exports">
            Sage <Badge n={overview?.counts.export_pool} />
          </NavLink>
          <NavLink to="/alerts">
            Alerts <Badge n={overview?.counts.open_alerts} tone="alert" />
          </NavLink>
          <NavLink to="/dashboard">Dashboard</NavLink>
          <NavLink to="/settings">Settings</NavLink>
          <NavLink to="/guide">Guide</NavLink>
        </nav>
        <div className="topbar-user">
          <span>
            {user.name} <small>({user.role === 'lead' ? 'AP Lead' : 'AP Processor'})</small>
          </span>
          <button className="btn btn-ghost" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<Queue />} />
          <Route path="/invoices/:id" element={<InvoiceDetailPage />} />
          <Route path="/rules" element={<RulesPage />} />
          <Route path="/alerts" element={<AlertsPage />} />
          <Route path="/exports" element={<ExportsPage />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/guide" element={<GuidePage />} />
          <Route path="*" element={<Queue />} />
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    api
      .me()
      .then(setUser)
      .catch((err: unknown) => {
        if (!(err instanceof ApiError && err.status === 401)) console.error(err);
      })
      .finally(() => setChecked(true));
  }, []);

  if (!checked) return <div className="page-loading">Loading Finny…</div>;
  if (!user) return <Login onSignedIn={setUser} />;
  return (
    <MetaProvider user={user} onSignOut={() => setUser(null)}>
      <Shell />
    </MetaProvider>
  );
}
