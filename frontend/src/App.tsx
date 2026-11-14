import type { ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router";
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

export default function App() {
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
      <Route path="*" element={<Navigate to="/teams" replace />} />
    </Routes>
  );
}
