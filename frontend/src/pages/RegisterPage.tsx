import { errorText } from "../lib/errorText";
import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import { Button, Input } from "@heroui/react";
import { useAuth } from "../auth/AuthContext";
import { AuthLayout } from "./AuthLayout";
import { safeRedirect, withRedirect } from "../lib/invite";
import { Field, FormError, PasswordInput } from "../components/FormField";
import { retryAfterSeconds, useCooldown } from "../lib/cooldown";
import { registerErrorFields, validateRegister, type RegisterField } from "../lib/authForm";

export default function RegisterPage() {
  const { user, register } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const target = safeRedirect(params.get("redirect"));
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [invalid, setInvalid] = useState<RegisterField[]>([]);
  const cooldown = useCooldown();
  const [rateLimited, setRateLimited] = useState(false);
  const limited = rateLimited && cooldown.remaining > 0;
  const clear = (f: RegisterField) => setInvalid((v) => v.filter((x) => x !== f));

  if (user) return <Navigate to={target} replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy || limited) return;
    const bad = validateRegister({ username, password, confirm });
    if (bad) {
      setError(bad.message);
      setInvalid([bad.field]);
      return;
    }
    setBusy(true);
    setError(null);
    setInvalid([]);
    setRateLimited(false);
    try {
      await register({ username, display_name: displayName, password });
      navigate(target, { replace: true });
    } catch (err) {
      setError(errorText(err));
      setInvalid(registerErrorFields(err));
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
    <AuthLayout title="创建账号" subtitle="注册后即可创建或加入 Team">
      <form className="flex flex-col gap-5" onSubmit={onSubmit} noValidate>
        {limited ? (
          <FormError>操作太频繁了，请 {cooldown.remaining} 秒后再试</FormError>
        ) : error && !rateLimited ? (
          <FormError>{error}</FormError>
        ) : null}
        <Field id="reg-username" label="用户名" hint="3–32 位小写字母、数字或下划线，注册后不能修改" invalid={invalid.includes("username")}>
          <Input
            id="reg-username"
            autoComplete="username"
            placeholder="例如：alice_01"
            value={username}
            autoFocus
            onChange={(e) => {
              setUsername(e.target.value);
              clear("username");
            }}
          />
        </Field>
        <Field id="reg-display" label="显示名称" hint="别人看到的名字，可留空（默认用用户名）" invalid={invalid.includes("display_name")}>
          <Input
            id="reg-display"
            placeholder="例如：Alice"
            value={displayName}
            onChange={(e) => {
              setDisplayName(e.target.value);
              clear("display_name");
            }}
          />
        </Field>
        <Field id="reg-password" label="密码" invalid={invalid.includes("password")}>
          <PasswordInput
            id="reg-password"
            autoComplete="new-password"
            placeholder="至少 8 位"
            value={password}
            onChange={(v) => {
              setPassword(v);
              clear("password");
            }}
          />
        </Field>
        <Field id="reg-confirm" label="确认密码" invalid={invalid.includes("confirm")}>
          <PasswordInput
            id="reg-confirm"
            autoComplete="new-password"
            placeholder="再输入一次密码"
            value={confirm}
            onChange={(v) => {
              setConfirm(v);
              clear("confirm");
            }}
          />
        </Field>
        <Button type="submit" variant="primary" fullWidth isPending={busy} isDisabled={limited} className="mt-1">
          {busy ? "注册中…" : limited ? `请 ${cooldown.remaining} 秒后再试` : "注册"}
        </Button>
        <p className="text-center text-sm text-[#949ba4]">
          已有账号？
          <Link to={params.get("redirect") ? withRedirect("/login", target) : "/login"} className="ml-1 text-brand-light hover:underline">
            登录
          </Link>
        </p>
      </form>
    </AuthLayout>
  );
}
