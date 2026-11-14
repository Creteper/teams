import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import { Button, Input, Label } from "@heroui/react";
import { useAuth } from "../auth/AuthContext";
import { USE_MOCK } from "../api/config";
import { AuthLayout } from "./AuthLayout";
import { safeRedirect, withRedirect } from "../lib/invite";

export default function LoginPage() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 只允许站内路径，防止开放重定向
  const from = safeRedirect(params.get("redirect"));

  if (user) return <Navigate to={from} replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login({ username, password });
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout title="欢迎回来" subtitle="登录 TeAms，回到你的团队">
      <form className="flex flex-col gap-3" onSubmit={onSubmit}>
        <Label htmlFor="login-username">用户名</Label>
        <Input id="login-username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
        <Label htmlFor="login-password">密码</Label>
        <Input
          id="login-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {USE_MOCK ? (
          <p className="text-xs text-[#949ba4]">Mock 模式：可用 alice / bob / carol / dave 登录，密码任意非空（mock 不校验）。</p>
        ) : null}
        {error ? <p className="text-sm text-[#f23f43]">{error}</p> : null}
        <Button type="submit" variant="primary" fullWidth isPending={busy} isDisabled={!username || !password}>
          登录
        </Button>
        <p className="text-sm text-[#949ba4]">
          还没有账号？
          <Link to={params.get("redirect") ? withRedirect("/register", from) : "/register"} className="text-[#00a8fc] hover:underline">
            注册
          </Link>
        </p>
      </form>
    </AuthLayout>
  );
}
