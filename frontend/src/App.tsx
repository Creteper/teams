import { useEffect, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router";
import { Spinner } from "@heroui/react";
import { useAuth } from "./auth/AuthContext";
import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
import TeamsPage from "./pages/TeamsPage";
import TeamPage from "./pages/TeamPage";
import InvitePage from "./pages/InvitePage";
import { withRedirect } from "./lib/invite";

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (!user) return <Navigate to={withRedirect("/login", location.pathname + location.search)} replace />;
  return <>{children}</>;
}

/**
 * 点击推送通知时，Service Worker 聚焦已打开的标签页并发来 {type:"teams:navigate", url}（public/sw.js），
 * 这里用前端路由跳过去（不整页刷新）；url 形如 /teams/<tid>/channels/<cid>?msg=<mid>（§9.4）。
 */
export function isSafeAppPath(url: unknown): url is string {
  return typeof url === "string" && url.startsWith("/") && !url.startsWith("//");
}

function useServiceWorkerNavigate() {
  const navigate = useNavigate();
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { type?: string; url?: unknown } | null;
      if (d?.type === "teams:navigate" && isSafeAppPath(d.url)) navigate(d.url);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [navigate]);
}

export default function App() {
  useServiceWorkerNavigate();
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      {/* 邀请落地页：无需登录即可预览 */}
      <Route path="/invite/:code" element={<InvitePage />} />
      <Route
        path="/teams"
        element={
          <RequireAuth>
            <TeamsPage />
          </RequireAuth>
        }
      />
      <Route
        path="/teams/:teamId"
        element={
          <RequireAuth>
            <TeamPage />
          </RequireAuth>
        }
      />
      <Route
        path="/teams/:teamId/channels/:channelId"
        element={
          <RequireAuth>
            <TeamPage />
          </RequireAuth>
        }
      />
      <Route path="/issues/archive" element={<RequireAuth><TeamsPage issues /></RequireAuth>} />
      <Route path="/teams/:teamId/issues/archive" element={<RequireAuth><TeamPage issues /></RequireAuth>} />
      <Route path="/issues" element={<RequireAuth><TeamsPage issues /></RequireAuth>} />
      <Route path="/teams/:teamId/issues" element={<RequireAuth><TeamPage issues /></RequireAuth>} />
      <Route path="*" element={<Navigate to="/teams" replace />} />
    </Routes>
  );
}
