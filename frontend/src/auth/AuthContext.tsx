import { PUSH_OWNER_KEY } from "../lib/push";
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
  /** PUT /me/avatar（multipart file）→ User */
  uploadAvatar(file: Blob, filename: string): Promise<void>;
  /** DELETE /me/avatar → User */
  removeAvatar(): Promise<void>;
  /** 收到自己的 member.updated（其他窗口改了昵称/头像）时同步本地 user */
  syncUser(patch: Partial<Pick<User, "display_name" | "avatar_url">>): void;
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

  // 只在“登录态”变化时连 / 断 WS；user 对象变化（改昵称、换头像）不重连
  const authed = !!user;
  useEffect(() => {
    if (!token || !authed) return;
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
  }, [token, authed]);

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
      async uploadAvatar(file, filename) {
        if (!token) return;
        setUser(await api.uploadMyAvatar(token, file, filename));
      },
      async removeAvatar() {
        if (!token) return;
        setUser(await api.deleteMyAvatar(token));
      },
      syncUser(patch) {
        setUser((prev) =>
          prev && (patch.display_name ?? prev.display_name) === prev.display_name && (patch.avatar_url === undefined || patch.avatar_url === prev.avatar_url)
            ? prev
            : prev
              ? { ...prev, ...patch }
              : prev,
        );
      },
      async logout() {
        if (token) await api.logout(token).catch(() => undefined);
        localStorage.removeItem(STORAGE_KEY);
        // 退出登录时服务端会删掉该会话的推送订阅（§9.4），本地“已开启”记录也清掉
        localStorage.removeItem(PUSH_OWNER_KEY);
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
