import { EditorView } from "@codemirror/view";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../../api";
import { IssueDialog } from "./IssueDialog";

afterEach(cleanup);

it("管理入口和表单浮层创建的选项可在同一团队的 Issue 中使用", async () => {
  const { user, token } = await api.login({ username: "alice", password: "test" });
  const { items: teams } = await api.listTeams(token);
  const team = teams[0];
  const props = { token, teams: [team], me: user, onClose: vi.fn(), onCreated: vi.fn() };
  const manager = render(<IssueDialog {...props} manage />);
  const name = await screen.findByRole("textbox", { name: "标签名称" });
  fireEvent.change(name, { target: { value: "视觉验收" } });
  fireEvent.keyDown(name, { key: "Enter" });
  await screen.findByText("视觉验收");
  manager.unmount();
  render(<IssueDialog {...props} manage={false} />);
  const title = await screen.findByRole("textbox", { name: "Issue 标题" });
  act(() => EditorView.findFromDOM(title)!.dispatch({ changes: { from: 0, insert: "检查布局" } }));
  fireEvent.click(screen.getByRole("button", { name: "最大化" }));
  expect(title.textContent).toBe("检查布局");
  fireEvent.click(screen.getByRole("button", { name: "状态" }));
  fireEvent.click(await screen.findByRole("button", { name: "创建状态" }));
  const input = await screen.findByRole("textbox", { name: "状态名称" });
  fireEvent.change(input, { target: { value: "待验收" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await screen.findByText("待验收");
  fireEvent.click(screen.getByRole("button", { name: "标签" }));
  fireEvent.click(await screen.findByRole("button", { name: "视觉验收" }));
  const pop = screen.getByRole("dialog", { name: "标签" });
  expect(within(pop).getByRole("button", { name: /视觉验收/ }).getAttribute("aria-pressed")).toBe("true");
});
