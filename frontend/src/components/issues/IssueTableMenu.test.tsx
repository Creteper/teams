import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it } from "vitest";
import { api } from "../../api";
import { IssueBoard } from "./IssueBoard";

afterEach(cleanup);

it("单元格菜单在点击内部时保持打开，点击表格外的空白处时关闭", async () => {
  const { user, token } = await api.login({ username: "alice", password: "test" });
  const { items: teams } = await api.listTeams(token);
  const team = teams[0];
  await api.createIssue(token, team.id, {
    id: crypto.randomUUID(), title: "菜单交互", description: "", priority: "none", status: "待处理",
    labels: [], assignee_id: null, start_date: null, end_date: null, attachment_ids: [],
  });
  render(<MemoryRouter><IssueBoard token={token} me={user} team={team} teams={teams} /></MemoryRouter>);
  const trigger = await screen.findByRole("button", { name: "修改优先级" });
  fireEvent.click(trigger);
  const menu = await screen.findByRole("dialog", { name: "优先级" });
  fireEvent.pointerDown(menu);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  fireEvent.pointerDown(screen.getByRole("main"));
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("dialog", { name: "优先级" })).toBeNull();
});
