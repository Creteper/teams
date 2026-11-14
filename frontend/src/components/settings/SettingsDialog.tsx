import { useEffect, useState, type ReactNode } from "react";
import { Button, Modal, Tabs } from "@heroui/react";
import { useAuth, useToken } from "../../auth/AuthContext";
import { PushSettings } from "../PushSettings";
import { CLOSE_BUTTON_CLASS, ConfirmDialog } from "../ui";
import { errorText } from "../../lib/errorText";
import { ProfileSettings } from "./ProfileSettings";
import { SkillDownload } from "./SkillDownload";

export type SettingsTab = "profile" | "notifications" | "skill";

const TABS: { id: SettingsTab; label: string; title: string; desc: string; icon: ReactNode }[] = [
  { id: "profile", label: "个人资料", title: "个人资料", desc: "头像和显示名称，所在 team 的成员都会看到。", icon: <UserIcon /> },
  { id: "notifications", label: "通知", title: "通知", desc: "有人 @ 你时怎么提醒你。", icon: <BellIcon /> },
  { id: "skill", label: "Skill 下载", title: "Skill 下载", desc: "把 TeAms 的接入说明装给你的 AI agent，让它能当 TeAms 的 bot。", icon: <DownloadIcon /> },
];

/** 窄屏（< 640px）：分类列表和内容各占满一屏，内容页带「返回」 */
function useNarrow() {
  const q = "(max-width: 639px)";
  const get = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(q).matches;
  const [narrow, setNarrow] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(q);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return narrow;
}

/**
 * 设置窗口（HeroUI Modal + 垂直 Tabs）：左侧分类导航（图标 + 文字，选中项高亮），右侧标题 + 分组卡片。
 * Esc / 右上角 × / 点遮罩关闭；里面再开的裁剪、确认等弹窗在上层，Esc 只关最上层。
 * - 选中项直接用底色标出（不用 Tabs.Indicator 的滑动块：它会在切换 / 改窗口大小时停在两项中间、盖住文字）；
 * - 左侧导航最底下是红字「退出登录」，点了先弹 AlertDialog 确认；
 * - 右上角 × 单独占一栏：宽屏内容区右侧留出 72px，窄屏内容页顶部有不滚动的标题栏，滚动时都不会和内容重叠。
 */
export function SettingsDialog({ initialTab, onClose }: { initialTab?: SettingsTab; onClose(): void }) {
  const { user, logout } = useAuth();
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [logoutPending, setLogoutPending] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const token = useToken();
  const narrow = useNarrow();
  const [tab, setTab] = useState<SettingsTab>(initialTab ?? "profile");
  // 窄屏：指定了打开哪一页就直接进内容页，否则先显示分类列表
  const [view, setView] = useState<"list" | "content">(initialTab ? "content" : "list");
  const showList = !narrow || view === "list";
  const showContent = !narrow || view === "content";
  const current = TABS.find((t) => t.id === tab)!;
  // 窄屏分类列表只是入口，不预先高亮任何一项
  const highlight = !narrow;

  async function doLogout() {
    setLogoutPending(true);
    setLogoutError(null);
    try {
      await logout();
    } catch (e) {
      setLogoutError(errorText(e, "退出登录失败，请稍后再试"));
      setLogoutPending(false);
    }
  }

  return (
    <Modal.Backdrop isOpen onOpenChange={(open) => !open && onClose()} className="z-40 bg-black/70">
      <Modal.Container placement="center" className="h-full w-full p-0 sm:w-full sm:p-6">
        <Modal.Dialog
          aria-label="设置"
          data-testid="settings-dialog"
          className="h-full max-w-[960px] overflow-hidden rounded-none bg-[#313338] p-0 text-[#dbdee1] shadow-2xl sm:h-[min(720px,100%)] sm:rounded-xl"
        >
          <Tabs
            orientation="vertical"
            keyboardActivation="manual"
            selectedKey={tab}
            onSelectionChange={(k) => {
              setTab(k as SettingsTab);
              setView("content");
            }}
            className="h-full min-h-0 gap-0"
          >
            <nav
              aria-label="设置分类"
              className={`${showList ? "flex" : "hidden"} w-full shrink-0 flex-col bg-[#2b2d31] px-3 pt-16 pb-6 sm:w-60 sm:px-4 sm:py-10`}
              // 窄屏下点 / 回车已选中的分类也要进入内容页（Tabs 只在选中项变化时回调）
              onClick={(e) => narrow && (e.target as HTMLElement).closest("[role=tab]") && setView("content")}
              onKeyDown={(e) => narrow && (e.key === "Enter" || e.key === " ") && (e.target as HTMLElement).closest("[role=tab]") && setView("content")}
            >
              <h2 className="mb-2 px-2.5 text-xs font-bold tracking-wide text-[#949ba4] uppercase">用户设置</h2>
              <Tabs.ListContainer className="rounded-none bg-transparent">
                <Tabs.List aria-label="设置分类" className="w-full gap-0.5 bg-transparent p-0">
                  {TABS.map((t) => (
                    <Tabs.Tab
                      key={t.id}
                      id={t.id}
                      data-highlight={highlight && t.id === tab ? "true" : undefined}
                      className={`h-10 w-full justify-start gap-2.5 rounded-md px-2.5 text-[15px] font-medium text-[#b5bac1] transition-none hover:text-[#dbdee1] data-[hovered=true]:bg-[#35373c] sm:h-9 ${
                        highlight ? "data-[selected=true]:bg-[#404249] data-[selected=true]:text-white" : ""
                      }`}
                    >
                      <span className="relative z-1 flex items-center gap-2.5">
                        {t.icon}
                        {t.label}
                      </span>
                      {narrow ? <span className="relative z-1 ml-auto text-[#80848e]" aria-hidden="true">›</span> : null}
                    </Tabs.Tab>
                  ))}
                </Tabs.List>
              </Tabs.ListContainer>
              <div className="mt-auto pt-4">
                <div className="mx-2.5 mb-2 h-px bg-white/10" />
                <Button
                  variant="ghost"
                  data-testid="settings-logout"
                  onPress={() => {
                    setLogoutError(null);
                    setConfirmLogout(true);
                  }}
                  className="h-10 w-full justify-start gap-2.5 rounded-md bg-transparent px-2.5 text-[15px] font-medium text-[#f23f43] hover:bg-[#f23f43]/10 data-[hovered=true]:bg-[#f23f43]/10 data-[pressed=true]:scale-100 sm:h-9"
                >
                  <LogoutIcon />
                  退出登录
                </Button>
              </div>
            </nav>
            <section className={`${showContent ? "flex" : "hidden"} min-h-0 min-w-0 flex-1 flex-col`}>
              {narrow ? (
                // 窄屏：返回按钮和右上角 × 在同一条不滚动的顶栏里
                <div className="flex h-16 shrink-0 items-center border-b border-black/20 pr-16 pl-2">
                  <Button variant="ghost" size="sm" className="px-2 text-[#b5bac1]" onPress={() => setView("list")} aria-label="返回设置分类">
                    ‹ 返回
                  </Button>
                </div>
              ) : null}
              <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:py-10 sm:pr-[72px] sm:pl-10" data-testid="settings-scroll">
                <h3 className="text-xl font-bold text-white" data-testid="settings-title">
                  {current.title}
                </h3>
                <p className="mt-1 mb-5 text-sm text-[#949ba4]">{current.desc}</p>
                <Tabs.Panel id="profile" className="p-0">
                  <ProfileSettings />
                </Tabs.Panel>
                <Tabs.Panel id="notifications" className="p-0">
                  {user ? (
                    <PushSettings
                      token={token}
                      userId={user.id}
                      hiddenFallback={
                        <div className="rounded-lg bg-[#2b2d31] p-4 text-sm text-[#949ba4]" data-testid="push-hidden">
                          服务器没有开启网页推送，暂时不能设置 @ 消息通知。
                        </div>
                      }
                    />
                  ) : null}
                </Tabs.Panel>
                <Tabs.Panel id="skill" className="p-0">
                  <SkillDownload />
                </Tabs.Panel>
              </div>
            </section>
          </Tabs>
          {confirmLogout ? (
            <ConfirmDialog
              title="退出登录"
              message="确定要退出登录吗？"
              confirmText="退出登录"
              pending={logoutPending}
              error={logoutError}
              onConfirm={() => void doLogout()}
              onCancel={() => setConfirmLogout(false)}
            />
          ) : null}
          <Modal.CloseTrigger aria-label="关闭设置" className={`${CLOSE_BUTTON_CLASS} top-5 right-5 rounded-full ring-1 ring-[#b5bac1]/50 hover:ring-white`} />
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

function UserIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </svg>
  );
}
function BellIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}
function DownloadIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M7 10l5 5 5-5" />
      <path d="M12 15V3" />
    </svg>
  );
}
function LogoutIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="M16 17l5-5-5-5" />
      <path d="M21 12H9" />
    </svg>
  );
}
