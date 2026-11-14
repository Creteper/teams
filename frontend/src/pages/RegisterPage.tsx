import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import { Button, Input, Label } from "@heroui/react";
import { useAuth } from "../auth/AuthContext";
import { AuthLayout } from "./AuthLayout";
import { safeRedirect, withRedirect } from "../lib/invite";

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
      <form className="flex flex-col gap-3" onSubmit={onSubmit}>
        <Label htmlFor="reg-username">用户名</Label>
        <Input id="reg-username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
        <p className="text-xs text-[#949ba4]">3–32 位，小写字母、数字和 _ . -</p>
        <Label htmlFor="reg-display">显示名称</Label>
        <Input id="reg-display" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        <Label htmlFor="reg-password">密码</Label>
        <Input
          id="reg-password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Label htmlFor="reg-confirm">确认密码</Label>
        <Input
          id="reg-confirm"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        {error ? <p className="text-sm text-[#f23f43]">{error}</p> : null}
        <Button type="submit" variant="primary" fullWidth isPending={busy} isDisabled={!username || !password}>
          注册
        </Button>
        <p className="text-sm text-[#949ba4]">
          已有账号？
          <Link to={params.get("redirect") ? withRedirect("/login", target) : "/login"} className="text-[#00a8fc] hover:underline">
            登录
          </Link>
        </p>
      </form>
    </AuthLayout>
  );
}
