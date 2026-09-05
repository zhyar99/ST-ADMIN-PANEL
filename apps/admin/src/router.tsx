import { createBrowserRouter } from 'react-router-dom';

import AppShell from './layout/AppShell';
import PlaceholderPage from './components/PlaceholderPage';
import ProtectedRoute from './components/ProtectedRoute';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import MediaPage from './pages/MediaPage';
import UsersPage from './pages/UsersPage';
import SettingsPage from './pages/SettingsPage';

/**
 * The SPA is served under /admin, so every route path below is relative to
 * that basename (e.g. "/movies" is reachable at /admin/movies).
 *
 * /login is the only public route; everything else sits behind ProtectedRoute,
 * and /users additionally requires the ADMIN role.
 *
 * The catalogue routes are lazy because they drag in TanStack Table, React Hook
 * Form and the asset pickers; the remaining pages are small enough that a split
 * point would cost more than it saves.
 */
const lazyPage = (load: () => Promise<{ default: React.ComponentType }>) => async () => ({
  Component: (await load()).default,
});
export const router = createBrowserRouter(
  [
    { path: '/login', element: <LoginPage /> },
    {
      element: <ProtectedRoute />,
      children: [
        {
          path: '/',
          element: <AppShell />,
          children: [
            { index: true, element: <DashboardPage /> },
            { path: 'movies', lazy: lazyPage(() => import('./pages/movies/MoviesPage')) },
            { path: 'movies/new', lazy: lazyPage(() => import('./pages/movies/MovieEditPage')) },
            { path: 'movies/:id', lazy: lazyPage(() => import('./pages/movies/MovieEditPage')) },
            { path: 'genres', lazy: lazyPage(() => import('./pages/movies/GenresPage')) },
            { path: 'series', lazy: lazyPage(() => import('./pages/series/SeriesListPage')) },
            { path: 'series/new', lazy: lazyPage(() => import('./pages/series/SeriesEditPage')) },
            {
              path: 'series/:seriesId',
              lazy: lazyPage(() => import('./pages/series/SeriesEditPage')),
            },
            // An episode is addressed through its season, mirroring the API —
            // the season id is what scopes the request server-side, so a route
            // that omitted it could not load the page without a lookup first.
            // "new" in the :episodeId slot is the create mode.
            {
              path: 'series/:seriesId/seasons/:seasonId/episodes/:episodeId',
              lazy: lazyPage(() => import('./pages/series/EpisodeEditPage')),
            },
            { path: 'live-tv', lazy: lazyPage(() => import('./pages/live-tv/LiveTvListPage')) },
            { path: 'live-tv/new', lazy: lazyPage(() => import('./pages/live-tv/LiveTvEditPage')) },
            { path: 'live-tv/:id', lazy: lazyPage(() => import('./pages/live-tv/LiveTvEditPage')) },
            { path: 'import', lazy: lazyPage(() => import('./pages/import/ImportPage')) },
            { path: 'import/:jobId', lazy: lazyPage(() => import('./pages/import/ImportJobPage')) },
            { path: 'media', element: <MediaPage /> },
            { path: 'home', lazy: lazyPage(() => import('./pages/home/HomeOrderPage')) },
            {
              path: 'advertising',
              lazy: lazyPage(() => import('./pages/advertising/AdvertisingPage')),
            },
            {
              path: 'analytics',
              lazy: lazyPage(() => import('./pages/analytics/AnalyticsPage')),
            },
            // ADMIN-only, enforced server-side as well: the page itself
            // redirects a VIEWER back to /analytics with a notice, because a
            // 403 shell would suggest the wrong fix ("ask for access to this
            // page") for a boundary that is about one device's history.
            {
              path: 'analytics/devices/:deviceId',
              lazy: lazyPage(() => import('./pages/analytics/DeviceDetailPage')),
            },
            {
              element: <ProtectedRoute allowedRoles={['ADMIN']} />,
              children: [{ path: 'users', element: <UsersPage /> }],
            },
            { path: 'settings', element: <SettingsPage /> },
            {
              path: '*',
              element: <PlaceholderPage title="Not found" description="No such page." />,
            },
          ],
        },
      ],
    },
  ],
  { basename: '/admin' },
);
