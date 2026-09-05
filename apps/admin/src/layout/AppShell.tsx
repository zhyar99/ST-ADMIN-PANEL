import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import {
  ChartNoAxesColumn,
  Clapperboard,
  FileUp,
  Image,
  LayoutDashboard,
  LogOut,
  Megaphone,
  Radio,
  Rows3,
  Settings,
  Tags,
  Tv,
  Users,
} from 'lucide-react';

import { useAuth } from '../lib/authContext';

const NAV_ITEMS = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true, adminOnly: false },
  { to: '/movies', label: 'Movies', icon: Clapperboard, end: false, adminOnly: false },
  { to: '/genres', label: 'Genres', icon: Tags, end: false, adminOnly: false },
  { to: '/series', label: 'Series', icon: Tv, end: false, adminOnly: false },
  { to: '/live-tv', label: 'Live TV', icon: Radio, end: false, adminOnly: false },
  { to: '/media', label: 'Media Library', icon: Image, end: false, adminOnly: false },
  { to: '/import', label: 'Import', icon: FileUp, end: false, adminOnly: false },
  { to: '/home', label: 'Home Rows', icon: Rows3, end: false, adminOnly: false },
  { to: '/advertising', label: 'Advertising', icon: Megaphone, end: false, adminOnly: false },
  // Visible to both roles: the section's own pages are platform-wide. The
  // per-device pages it links to are ADMIN-only and guard themselves.
  { to: '/analytics', label: 'Analytics', icon: ChartNoAxesColumn, end: false, adminOnly: false },
  { to: '/users', label: 'Users', icon: Users, end: false, adminOnly: true },
  { to: '/settings', label: 'Settings', icon: Settings, end: false, adminOnly: false },
] as const;

const ROLE_BADGE: Record<string, string> = {
  ADMIN: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  VIEWER: 'bg-slate-500/15 text-slate-300 ring-slate-500/30',
};

/** Top bar + sidebar shell for every authenticated page. */
export default function AppShell() {
  const { user, logout, isAdmin } = useAuth();
  const navigate = useNavigate();

  const navItems = NAV_ITEMS.filter((item) => !item.adminOnly || isAdmin());

  async function handleLogout() {
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="flex h-14 items-center justify-between border-b border-slate-800 px-6">
        <span className="font-semibold tracking-tight">Streaming Admin</span>

        {user && (
          <div className="flex items-center gap-3">
            <span className="text-sm text-slate-300">{user.name}</span>
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${
                ROLE_BADGE[user.role] ?? ROLE_BADGE.VIEWER
              }`}
            >
              {user.role}
            </span>
            <button
              type="button"
              onClick={handleLogout}
              className="flex items-center gap-1.5 rounded-md border border-slate-700 px-2.5 py-1.5 text-sm text-slate-300 transition hover:bg-slate-800 hover:text-white"
            >
              <LogOut size={14} aria-hidden />
              Log out
            </button>
          </div>
        )}
      </header>

      <div className="flex">
        <nav className="min-h-[calc(100vh-3.5rem)] w-56 shrink-0 border-r border-slate-800 p-3">
          <ul className="space-y-1">
            {navItems.map(({ to, label, icon: Icon, end }) => (
              <li key={to}>
                <NavLink
                  to={to}
                  end={end}
                  className={({ isActive }) =>
                    `flex items-center gap-2 rounded-md px-3 py-2 text-sm ${
                      isActive ? 'bg-slate-800 text-white' : 'text-slate-400 hover:bg-slate-900'
                    }`
                  }
                >
                  <Icon size={16} aria-hidden />
                  {label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <main className="flex-1">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
