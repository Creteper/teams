import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import { Button, Input } from "@heroui/react";
import { useAuth } from "../auth/AuthContext";
import { AuthLayout } from "./AuthLayout";
import { safeRedirect, withRedirect } from "../lib/invite";
import { Field, FormError, PasswordInput } from "../components/FormField";

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

  if (user) return <Navigate to={target} replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!/^[a-z0-9_]{3,32}$/.test(username.trim().toLowerCase())) {
      setError("用户名需 3–32 位，只能包含小写字母、数字和下划线");
      return;
    }
    if (password.length < 8) {
      setError("密码至少 8 位");
      return;
    }
    if (password !== confirm) {
      setError("两次输入的密码不一致");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await register({ username, display_name: displayName, password });
      navigate(target, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout title="创建账号" subtitle="注册后即可创建或加入 Team">
      <form className="flex flex-col gap-5" onSubmit={onSubmit} noValidate>
        {error ? <FormError>{error}</FormError> : null}
        <Field id="reg-username" label="用户名" hint="3–32 位小写字母、数字或下划线，注册后不能修改">
          <Input
            id="reg-username"
            autoComplete="username"
            placeholder="例如：alice_01"
            value={username}
            autoFocus
            onChange={(e) => setUsername(e.target.value)}
          />
        </Field>
        <Field id="reg-display" label="显示名称" hint="别人看到的名字，可留空（默认用用户名）">
          <Input id="reg-display" placeholder="例如：Alice" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </Field>
        <Field id="reg-password" label="密码">
          <PasswordInput id="reg-password" autoComplete="new-password" placeholder="至少 8 位" value={password} onChange={setPassword} />
        </Field>
        <Field id="reg-confirm" label="确认密码">
          <PasswordInput id="reg-confirm" autoComplete="new-password" placeholder="再输入一次密码" value={confirm} onChange={setConfirm} />
        </Field>
        <Button type="submit" variant="primary" fullWidth isPending={busy} className="mt-1">
          {busy ? "注册中…" : "注册"}
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
