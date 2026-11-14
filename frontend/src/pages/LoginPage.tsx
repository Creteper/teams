import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import { Button, Input } from "@heroui/react";
import { useAuth } from "../auth/AuthContext";
import { USE_MOCK } from "../api/config";
import { AuthLayout } from "./AuthLayout";
import { safeRedirect, withRedirect } from "../lib/invite";
import { Field, FormError, PasswordInput } from "../components/FormField";
import { retryAfterSeconds, useCooldown } from "../lib/cooldown";
import { loginErrorFields, type LoginField } from "../lib/authForm";

export default function LoginPage() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [invalid, setInvalid] = useState<LoginField[]>([]);
  // 429：按 Retry-After 倒计时，期间按钮禁用并显示剩余秒数
  const cooldown = useCooldown();
  const [rateLimited, setRateLimited] = useState(false);
  const limited = rateLimited && cooldown.remaining > 0;
  // 只允许站内路径，防止开放重定向
  const from = safeRedirect(params.get("redirect"));

  if (user) return <Navigate to={from} replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy || limited) return;
    if (!username.trim() || !password) {
      setError("请输入用户名和密码");
      setInvalid([...(username.trim() ? [] : ["username" as const]), ...(password ? [] : ["password" as const])]);
      return;
    }
    setBusy(true);
    setError(null);
    setInvalid([]);
    setRateLimited(false);
    try {
      await login({ username, password });
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setInvalid(loginErrorFields(err));
      const wait = retryAfterSeconds(err);
      if (wait !== null) {
        setRateLimited(true);
        cooldown.start(wait);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout title="欢迎回来" subtitle="登录 TeAms，回到你的团队">
      <form className="flex flex-col gap-5" onSubmit={onSubmit} noValidate>
        {limited ? (
          <FormError>操作太频繁了，请 {cooldown.remaining} 秒后再试</FormError>
        ) : error && !rateLimited ? (
          <FormError>{error}</FormError>
        ) : null}
        <Field id="login-username" label="用户名" invalid={invalid.includes("username")}>
          <Input
            id="login-username"
            autoComplete="username"
            placeholder="输入用户名"
            value={username}
            autoFocus
            onChange={(e) => {
              setUsername(e.target.value);
              setInvalid((v) => v.filter((f) => f !== "username"));
            }}
          />
        </Field>
        <Field id="login-password" label="密码" invalid={invalid.includes("password")}>
          <PasswordInput
            id="login-password"
            autoComplete="current-password"
            placeholder="输入密码"
            value={password}
            onChange={(v) => {
              setPassword(v);
              setInvalid((x) => x.filter((f) => f !== "password"));
            }}
          />
        </Field>
        {import.meta.env.DEV && USE_MOCK ? (
          <p className="rounded-md bg-brand-soft px-3 py-2 text-xs text-brand-light">
            开发 Mock 模式：可用 alice / bob / carol / dave 登录，密码任意非空；密码填 wrong 可演示登录失败。
          </p>
        ) : null}
        <Button type="submit" variant="primary" fullWidth isPending={busy} isDisabled={limited} className="mt-1">
          {busy ? "登录中…" : limited ? `请 ${cooldown.remaining} 秒后再试` : "登录"}
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
