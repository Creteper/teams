import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Link } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog, DialogShell, RailTooltip } from "./ui";

afterEach(cleanup);

describe("DialogShell / ConfirmDialog（HeroUI Modal / AlertDialog）", () => {
  it("带标题和关闭按钮；点 × 关闭", async () => {
    const onClose = vi.fn();
    render(
      <DialogShell label="测试弹窗" title="标题" onClose={onClose}>
        <p>内容</p>
      </DialogShell>,
    );
    const dialog = await screen.findByRole("dialog", { name: "测试弹窗" });
    expect(dialog.textContent).toContain("标题");
    expect(dialog.textContent).toContain("内容");
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("确认框：点「取消」= onCancel，点确认 = onConfirm；出错时显示红字", async () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(<ConfirmDialog title="删除频道" message="确定吗" confirmText="删除" error="删除失败" onConfirm={onConfirm} onCancel={onCancel} />);
    const alert = await screen.findByRole("alertdialog", { name: "删除频道" });
    expect(alert.textContent).toContain("删除失败");
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
  // 嵌套时 Esc 只关最上层：jsdom 下 React Aria 的 overlay 键盘关闭不触发，改在浏览器里（Playwright）验证
});

describe("RailTooltip（HeroUI Tooltip）", () => {
  it("触发元素就是 Link 本身（不额外包 role=button 的 div），聚焦时显示提示", async () => {
    render(
      <MemoryRouter>
        <RailTooltip text="我的 Team">{(p) => <Link {...p} to="/teams" aria-label="主页">LOGO</Link>}</RailTooltip>
      </MemoryRouter>,
    );
    const link = screen.getByRole("link", { name: "主页" });
    expect(screen.queryByRole("button")).toBeNull();
    fireEvent.keyDown(document.body, { key: "Tab" });
    link.focus();
    expect(await screen.findByRole("tooltip")).toBeTruthy();
    expect(screen.getByRole("tooltip").textContent).toContain("我的 Team");
  });
});
