import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, realtime } from "../api";
import type { LoginInput, RegisterInput, User } from "../api/types";

/**
 * 会话管理：登录/注册返回的会话令牌存 localStorage，REST 用 Bearer 头、WS 首帧 auth 携带（docs/api.md §0.1、§8.1）。
 */
const STORAGE_KEY = "teams.session.token";

interface AuthState {
  user: User | null;
  token: string | null;
  loading: boolean;
  login(input: LoginInput): Promise<void>;
  register(input: RegisterInput): Promise<void>;
  logout(): Promise<void>;
  /** PATCH /me：改显示名称 */
  updateProfile(displayName: string): Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(STORAGE_KEY));
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState<boolean>(() => !!localStorage.getItem(STORAGE_KEY));

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    api
      .me(token)
      .then((u) => {
        if (!cancelled) setUser(u);
      })
      .catch(() => {
        if (cancelled) return;
        localStorage.removeItem(STORAGE_KEY);
        setToken(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (!token || !user) return;
    realtime.connect(token);
    const off = realtime.onAuthFailed(() => {
      localStorage.removeItem(STORAGE_KEY);
      setUser(null);
      setToken(null);
    });
    return () => {
      off();
      realtime.disconnect();
    };
  }, [token, user]);

  const applySession = useCallback((t: string, u: User) => {
    localStorage.setItem(STORAGE_KEY, t);
    setUser(u);
    setToken(t);
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user,
      token,
      loading,
      async login(input) {
        const s = await api.login(input);
        applySession(s.token, s.user);
      },
      async register(input) {
        const s = await api.register(input);
        applySession(s.token, s.user);
      },
      async updateProfile(displayName) {
        if (!token) return;
        setUser(await api.updateMe(token, { display_name: displayName }));
      },
      async logout() {
        if (token) await api.logout(token).catch(() => undefined);
        localStorage.removeItem(STORAGE_KEY);
        setUser(null);
        setToken(null);
      },
    }),
    [user, token, loading, applySession],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

/** 已登录页面使用：断言 token 存在 */
export function useToken(): string {
  const { token } = useAuth();
  if (!token) throw new Error("not authenticated");
  return token;
}
