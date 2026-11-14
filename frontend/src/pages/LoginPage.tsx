import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import { Button, Input } from "@heroui/react";
import { useAuth } from "../auth/AuthContext";
import { USE_MOCK } from "../api/config";
import { AuthLayout } from "./AuthLayout";
import { safeRedirect, withRedirect } from "../lib/invite";
import { Field, FormError, PasswordInput } from "../components/FormField";

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
    if (busy) return;
    if (!username.trim() || !password) {
      setError("请输入用户名和密码");
      return;
    }
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
      <form className="flex flex-col gap-5" onSubmit={onSubmit} noValidate>
        {error ? <FormError>{error}</FormError> : null}
        <Field id="login-username" label="用户名">
          <Input
            id="login-username"
            autoComplete="username"
            placeholder="输入用户名"
            value={username}
            autoFocus
            onChange={(e) => setUsername(e.target.value)}
          />
        </Field>
        <Field id="login-password" label="密码">
          <PasswordInput id="login-password" autoComplete="current-password" placeholder="输入密码" value={password} onChange={setPassword} />
        </Field>
        {import.meta.env.DEV && USE_MOCK ? (
          <p className="rounded-md bg-brand-soft px-3 py-2 text-xs text-brand-light">
            开发 Mock 模式：可用 alice / bob / carol / dave 登录，密码任意非空；密码填 wrong 可演示登录失败。
          </p>
        ) : null}
        <Button type="submit" variant="primary" fullWidth isPending={busy} className="mt-1">
          {busy ? "登录中…" : "登录"}
        </Button>
        <p className="text-center text-sm text-[#949ba4]">
          还没有账号？
          <Link to={params.get("redirect") ? withRedirect("/register", from) : "/register"} className="ml-1 text-brand-light hover:underline">
            注册
          </Link>
        </p>
      </form>
    </AuthLayout>
  );
}
