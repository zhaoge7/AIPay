import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { ConsoleApiError, consoleApi, type DeveloperSession } from './api.js';

interface AuthContextValue {
  readonly status: 'loading' | 'anonymous' | 'authenticated';
  readonly developer: DeveloperSession | null;
  readonly authenticate: (
    mode: 'login' | 'register',
    email: string,
    password: string,
  ) => Promise<void>;
  readonly logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [status, setStatus] = useState<AuthContextValue['status']>('loading');
  const [developer, setDeveloper] = useState<DeveloperSession | null>(null);

  useEffect(() => {
    let active = true;

    void consoleApi
      .session()
      .then((session) => {
        if (active) {
          setDeveloper(session);
          setStatus('authenticated');
        }
      })
      .catch((error: unknown) => {
        if (!active) {
          return;
        }

        if (error instanceof ConsoleApiError && error.status === 401) {
          setDeveloper(null);
          setStatus('anonymous');
          return;
        }

        setDeveloper(null);
        setStatus('anonymous');
      });

    return () => {
      active = false;
    };
  }, []);

  const authenticate = useCallback(
    async (mode: 'login' | 'register', email: string, password: string) => {
      const session =
        mode === 'login'
          ? await consoleApi.login(email, password)
          : await consoleApi.register(email, password);
      setDeveloper(session);
      setStatus('authenticated');
    },
    [],
  );
  const logout = useCallback(async () => {
    await consoleApi.logout();
    setDeveloper(null);
    setStatus('anonymous');
  }, []);
  const value = useMemo(
    () => ({ status, developer, authenticate, logout }),
    [authenticate, developer, logout, status],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);

  if (value === null) {
    throw new Error('useAuth must be used inside AuthProvider');
  }

  return value;
}
