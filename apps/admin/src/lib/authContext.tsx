import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { apiFetch, setAccessToken, setRefreshHandler } from './api';

export type AdminRole = 'ADMIN' | 'VIEWER';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: AdminRole;
  lastLoginAt?: string | null;
}

interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
}

interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshAccessToken: () => Promise<string | null>;
  isAdmin: () => boolean;
}

/**
 * TODO(before production): move the refresh token to an httpOnly, Secure,
 * SameSite=Strict cookie set by the server. localStorage is readable by any
 * script on the origin, so an XSS bug here costs a 7-day session. Acceptable
 * only for the local MVP. The *access* token is deliberately kept in memory.
 */
const REFRESH_TOKEN_KEY = 'streaming.admin.refreshToken';

function readStoredRefreshToken(): string | null {
  try {
    return window.localStorage.getItem(REFRESH_TOKEN_KEY);
  } catch {
    return null;
  }
}

function writeStoredRefreshToken(token: string | null): void {
  try {
    if (token) window.localStorage.setItem(REFRESH_TOKEN_KEY, token);
    else window.localStorage.removeItem(REFRESH_TOKEN_KEY);
  } catch {
    // Private browsing or a full quota — the session just won't survive reload.
  }
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  /**
   * Refresh tokens rotate, so two concurrent refreshes would spend each other's
   * token and log the user out. Every caller shares one in-flight request.
   */
  const inFlightRefresh = useRef<Promise<string | null> | null>(null);

  const clearSession = useCallback(() => {
    setAccessToken(null);
    writeStoredRefreshToken(null);
    setUser(null);
  }, []);

  const refreshAccessToken = useCallback(async (): Promise<string | null> => {
    if (inFlightRefresh.current) return inFlightRefresh.current;

    const stored = readStoredRefreshToken();
    if (!stored) {
      clearSession();
      return null;
    }

    const attempt = (async () => {
      try {
        const result = await apiFetch<RefreshResponse>('/admin/auth/refresh', {
          method: 'POST',
          body: { refreshToken: stored },
          auth: false,
        });

        setAccessToken(result.accessToken);
        writeStoredRefreshToken(result.refreshToken);
        return result.accessToken;
      } catch {
        clearSession();
        return null;
      } finally {
        inFlightRefresh.current = null;
      }
    })();

    inFlightRefresh.current = attempt;
    return attempt;
  }, [clearSession]);

  // Let the API client recover from a 401 on its own.
  useEffect(() => {
    setRefreshHandler(refreshAccessToken);
    return () => setRefreshHandler(null);
  }, [refreshAccessToken]);

  // Restore a session on first paint. The ref keeps StrictMode's double-mount
  // from spending the rotating refresh token twice.
  //
  // Deliberately no "cancelled" cleanup flag: the ref already guarantees a
  // single run, so ignoring the result on unmount would leave isLoading stuck
  // at true forever on the remount. Setting state after unmount is a no-op in
  // React 18+, which is the lesser evil.
  const didBootstrap = useRef(false);
  useEffect(() => {
    if (didBootstrap.current) return;
    didBootstrap.current = true;

    void (async () => {
      try {
        if (!readStoredRefreshToken()) return;

        const token = await refreshAccessToken();
        if (!token) return;

        setUser(await apiFetch<AuthUser>('/admin/auth/me'));
      } catch {
        clearSession();
      } finally {
        setIsLoading(false);
      }
    })();
  }, [clearSession, refreshAccessToken]);

  const login = useCallback(async (email: string, password: string) => {
    const result = await apiFetch<LoginResponse>('/admin/auth/login', {
      method: 'POST',
      body: { email, password },
      auth: false,
    });

    setAccessToken(result.accessToken);
    writeStoredRefreshToken(result.refreshToken);
    setUser(result.user);
  }, []);

  const logout = useCallback(async () => {
    const stored = readStoredRefreshToken();

    if (stored) {
      try {
        await apiFetch<void>('/admin/auth/logout', {
          method: 'POST',
          body: { refreshToken: stored },
        });
      } catch {
        // Server-side revocation is best effort; the client session goes either way.
      }
    }

    clearSession();
  }, [clearSession]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isLoading,
      login,
      logout,
      refreshAccessToken,
      isAdmin: () => user?.role === 'ADMIN',
    }),
    [user, isLoading, login, logout, refreshAccessToken],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside an <AuthProvider>');
  return context;
}
