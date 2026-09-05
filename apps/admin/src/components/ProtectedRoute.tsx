import { Navigate, Outlet, useLocation } from 'react-router-dom';

import { useAuth, type AdminRole } from '../lib/authContext';

interface ProtectedRouteProps {
  /** When set, the caller's role must be one of these; otherwise 403. */
  allowedRoles?: AdminRole[];
}

function Spinner() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950">
      <div
        role="status"
        aria-label="Loading"
        className="size-8 animate-spin rounded-full border-2 border-slate-700 border-t-slate-200"
      />
    </div>
  );
}

function Forbidden() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-2 p-8 text-center">
      <p className="text-lg font-semibold text-slate-100">403 — Not authorised</p>
      <p className="max-w-md text-sm text-slate-400">
        Your account does not have permission to view this page. Ask an administrator if you need
        access.
      </p>
    </div>
  );
}

/**
 * Route guard. Renders nested routes only for a signed-in user whose role is
 * allowed; otherwise sends them to the login page or shows a 403.
 */
export default function ProtectedRoute({ allowedRoles }: ProtectedRouteProps) {
  const { user, isLoading } = useAuth();
  const location = useLocation();

  // Wait for the silent refresh to settle — redirecting first would bounce a
  // signed-in user out on every page load.
  if (isLoading) return <Spinner />;

  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;

  if (allowedRoles && !allowedRoles.includes(user.role)) return <Forbidden />;

  return <Outlet />;
}
