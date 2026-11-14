import type { ReactNode } from "react";
import { Logo } from "../components/Logo";

/** 登录/注册外壳：卡片内边距 32px，LOGO 与标题、表单之间留足间距 */
export function AuthLayout({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center bg-[#313338] bg-[radial-gradient(circle_at_20%_20%,#6d5cf633,transparent_40%),radial-gradient(circle_at_80%_80%,#4fa8ff22,transparent_40%)] p-6">
      <div className="w-full max-w-[440px] rounded-2xl bg-[#2b2d31] p-8 shadow-2xl ring-1 ring-white/5">
        <div className="mb-8 flex flex-col items-center text-center">
          <Logo size={64} className="mb-3" />
          <span className="mb-5 text-sm font-bold tracking-wide text-[#b5bac1]">TeAms</span>
          <h1 className="text-2xl font-bold text-white">{title}</h1>
          <p className="mt-2 text-sm text-[#b5bac1]">{subtitle}</p>
        </div>
        {children}
      </div>
    </div>
  );
}
