import { describe, expect, it } from "vitest";
import { ApiError } from "../api/errors";
import type { Member, Team } from "../api/types";
import { applyRole, optimisticRoleChange, roleActionFor, roleChangeErrorText, syncMyRole, upsertMember } from "./memberRoles";

const mk = (id: string, role: Member["role"], type: Member["type"] = "user") =>
  ({ id, team_id: "t", type, user_id: type === "user" ? `u${id}` : null, bot_id: null, display_name: id, username: id, avatar_url: null, avatar_shape: null, avatar_color: null, role, joined_at: "" }) as Member;

describe("成员角色入口", () => {
  const owner = mk("o", "owner");
  const admin = mk("a", "admin");
  const member = mk("m", "member");
  const bot = mk("b", "bot", "bot");
  it("owner：成员→设为管理员，管理员→取消管理员；owner/bot/自己不显示", () => {
    expect(roleActionFor("owner", "o", member)).toBe("promote");
    expect(roleActionFor("owner", "o", admin)).toBe("demote");
    expect(roleActionFor("owner", "o", owner)).toBeNull();
    expect(roleActionFor("owner", "o", bot)).toBeNull();
  });
  it("admin：文档权限 owner/admin，同样显示；但不能对自己和 owner", () => {
    expect(roleActionFor("admin", "a", member)).toBe("promote");
    expect(roleActionFor("admin", "a", admin)).toBeNull(); // 自己
    expect(roleActionFor("admin", "a", owner)).toBeNull();
  });
  it("普通成员看不到入口", () => {
    expect(roleActionFor("member", "m", mk("x", "member"))).toBeNull();
    expect(roleActionFor("member", "m", admin)).toBeNull();
    expect(roleActionFor(undefined, "", member)).toBeNull();
  });
});

describe("列表更新 / 回滚", () => {
  it("applyRole 原位改角色，可用同样方式回滚", () => {
    const list = [mk("o", "owner"), mk("m", "member"), mk("x", "member")];
    const next = applyRole(list, "m", "admin");
    expect(next.map((m) => m.role)).toEqual(["owner", "admin", "member"]);
    expect(list[1].role).toBe("member"); // 不改原数组
    expect(applyRole(next, "m", "member")).toEqual(list);
  });
  it("upsertMember：member.updated 原位替换，不打乱顺序；新成员追加", () => {
    const list = [mk("o", "owner"), mk("m", "member"), mk("x", "member")];
    expect(upsertMember(list, mk("m", "admin")).map((m) => `${m.id}:${m.role}`)).toEqual(["o:owner", "m:admin", "x:member"]);
    expect(upsertMember(list, mk("n", "member")).map((m) => m.id)).toEqual(["o", "m", "x", "n"]);
  });
  it("syncMyRole：推送的是我自己时同步 my_role", () => {
    const team = { id: "t", my_member_id: "a", my_role: "admin" } as Team;
    expect(syncMyRole(team, mk("a", "member"))?.my_role).toBe("member");
    expect(syncMyRole(team, mk("x", "member"))).toBe(team);
    expect(syncMyRole(team, mk("a", "admin"))).toBe(team);
  });
  it("失败提示为中文", () => {
    expect(roleChangeErrorText(ApiError.fromBody(403, { error: { code: "forbidden", message: "forbidden" } }, ""), "promote", "Carol")).toBe(
      "设为管理员失败（Carol）：你没有权限修改这个成员的角色",
    );
    expect(roleChangeErrorText(new TypeError("Failed to fetch"), "demote", "Bob")).toBe("取消管理员失败（Bob）：网络异常，请稍后再试");
  });
});

describe("乐观更新 + 失败回滚", () => {
  function store(init: Member[]) {
    let state = init;
    const seen: string[][] = [];
    return {
      get: () => state,
      seen,
      update: (fn: (p: Member[]) => Member[]) => {
        state = fn(state);
        seen.push(state.map((m) => `${m.id}:${m.role}`));
      },
    };
  }
  it("成功：先乐观改成 admin，再用接口返回覆盖", async () => {
    const s = store([mk("o", "owner"), mk("c", "member")]);
    const res = await optimisticRoleChange(s.get()[1], "promote", s.update, async (role) => ({ ...mk("c", role), display_name: "Carol" }));
    expect(res).toBeNull();
    expect(s.seen[0]).toEqual(["o:owner", "c:admin"]); // 乐观
    expect(s.get()[1]).toMatchObject({ role: "admin", display_name: "Carol" });
  });
  it("接口没返回 Member：保留乐观值", async () => {
    const s = store([mk("c", "admin")]);
    expect(await optimisticRoleChange(s.get()[0], "demote", s.update, async () => null)).toBeNull();
    expect(s.get()[0].role).toBe("member");
  });
  it("失败：回滚到原角色并给出中文提示", async () => {
    const s = store([mk("o", "owner"), mk("c", "member")]);
    const res = await optimisticRoleChange(s.get()[1], "promote", s.update, async () => {
      throw ApiError.fromBody(403, { error: { code: "forbidden", message: "forbidden" } }, "");
    });
    expect(s.seen[0]).toEqual(["o:owner", "c:admin"]);
    expect(s.get()[1].role).toBe("member");
    expect(res).toBe("设为管理员失败（c）：你没有权限修改这个成员的角色");
  });
});
