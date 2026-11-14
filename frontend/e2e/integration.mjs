/**
 * 真实后端端到端联调脚本（不进 vitest，不进构建）。
 *
 * 前置：后端在 127.0.0.1:8090 运行；前端以 VITE_USE_MOCK=false 在 E2E_BASE（默认 http://localhost:5190）运行。
 * 运行：在装有 playwright 的目录执行 `node path/to/integration.mjs`（或 `pnpm dlx playwright` 环境）。
 * 账号：E2E_USER_A/E2E_PASS_A、E2E_USER_B/E2E_PASS_B 可覆盖；默认随机生成，密码不打印。
 * 截图：E2E_SHOTS 目录（默认 ./e2e-shots，不要提交）。
 */
import { chromium } from "playwright";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const BASE = process.env.E2E_BASE ?? "http://localhost:5190";
const SHOTS = process.env.E2E_SHOTS ?? "./e2e-shots";
const VIDEO = process.env.E2E_VIDEO ?? join(dirname(fileURLToPath(import.meta.url)), "../public/media/demo-standup.mp4");
mkdirSync(SHOTS, { recursive: true });

const rnd = (n) => randomBytes(n).toString("base64url").slice(0, n);
const tag = rnd(5).toLowerCase().replace(/[^a-z0-9]/g, "x");
const A = { username: process.env.E2E_USER_A ?? `e2e_a_${tag}`, password: process.env.E2E_PASS_A ?? rnd(20), name: "联调A" };
const B = { username: process.env.E2E_USER_B ?? `e2e_b_${tag}`, password: process.env.E2E_PASS_B ?? rnd(20), name: "联调B" };

const results = [];
const apiErrors = [];
const consoleErrors = [];
const step = async (name, fn) => {
  const t = Date.now();
  try {
    await fn();
    results.push({ step: name, ok: true, ms: Date.now() - t });
    console.log(`✓ ${name}`);
  } catch (e) {
    results.push({ step: name, ok: false, error: String(e).split("\n")[0] });
    console.log(`✗ ${name}: ${String(e).split("\n")[0]}`);
    throw e;
  }
};

const browser = await chromium.launch();
async function newUser(label) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(`[${label}] ${m.text()}`));
  page.on("pageerror", (e) => consoleErrors.push(`[${label}] pageerror ${e}`));
  page.on("response", async (r) => {
    if (!r.url().includes("/api/") || r.status() < 400) return;
    let body = "";
    try {
      body = (await r.text()).slice(0, 300);
    } catch {}
    apiErrors.push({ who: label, method: r.request().method(), url: r.url().replace(BASE, ""), status: r.status(), request_id: r.headers()["x-request-id"], body });
  });
  return { ctx, page };
}
const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${name}.png` });
const log = (page) => page.locator("[role=log][aria-live=polite].flex-1");
const box = (page) => page.locator("textarea[aria-label=消息输入框]");

async function register(page, u) {
  await page.goto(`${BASE}/register`);
  await page.fill("#reg-username", u.username);
  await page.fill("#reg-display", u.name);
  await page.fill("#reg-password", u.password);
  await page.fill("#reg-confirm", u.password);
  await page.click("button[type=submit]");
  await page.waitForURL(/\/teams$/, { timeout: 15000 });
}
async function mention(page, name, text) {
  await box(page).click();
  await box(page).pressSequentially(`@${name}`);
  await page.waitForSelector("[role=option]");
  await page.keyboard.press("Enter");
  await box(page).pressSequentially(` ${text}`);
  await page.keyboard.press("Enter");
}
async function send(page, text) {
  await box(page).click();
  await box(page).fill(text);
  await page.keyboard.press("Enter");
}

const a = await newUser("A");
const b = await newUser("B");
let teamUrl = "";
let inviteLink = "";
const teamName = `联调 Team ${tag}`;

try {
  await step("A、B 注册（真实后端）", async () => {
    await register(a.page, A);
    await register(b.page, B);
    await shot(a.page, "i01-teams-empty");
  });

  await step("A 登出再登录", async () => {
    await a.page.evaluate(() => localStorage.clear());
    await a.page.goto(`${BASE}/login`);
    await a.page.fill("#login-username", A.username);
    await a.page.fill("#login-password", A.password);
    await a.page.click("button[type=submit]");
    await a.page.waitForURL(/\/teams$/);
  });

  await step("A 创建 team（自动 #general）", async () => {
    await a.page.fill("#team-name", teamName);
    await a.page.fill("#team-desc", "前后端联调用的临时 team");
    await a.page.click("button:has-text('创建 Team')");
    await a.page.waitForURL(/\/channels\//, { timeout: 15000 });
    teamUrl = a.page.url().replace(/\/channels\/.*/, "");
    await a.page.waitForSelector("[data-testid=channel-welcome]");
  });

  await step("A 新建频道 #e2e", async () => {
    await a.page.click("button[aria-label=新建频道]");
    await a.page.fill("input[aria-label=频道名]", "e2e");
    await a.page.keyboard.press("Enter");
    await a.page.waitForSelector("header h1:has-text('e2e')");
    await a.page.click("aside a:has-text('general')");
    await a.page.waitForSelector("header h1:has-text('general')");
  });

  await step("A 发文字", async () => {
    await send(a.page, "你好，这是联调的第一条消息");
    await log(a.page).locator("text=你好，这是联调的第一条消息").waitFor();
  });

  await step("A 上传并发送图片和视频（multipart → attachment_ids）", async () => {
    const png = await a.page.screenshot({ type: "png", clip: { x: 0, y: 0, width: 480, height: 270 } });
    await a.page.setInputFiles("input[type=file]", [
      { name: "e2e-shot.png", mimeType: "image/png", buffer: png },
      { name: "demo.mp4", mimeType: "video/mp4", buffer: readFileSync(VIDEO) },
    ]);
    await a.page.waitForFunction(() => !document.querySelector("[role=progressbar]") && document.querySelectorAll("button[aria-label^='移除 ']").length === 2, null, { timeout: 30000 });
    await box(a.page).click();
    await box(a.page).fill("截图和录屏");
    await a.page.keyboard.press("Enter");
    await log(a.page).locator("img[alt='e2e-shot.png']").waitFor({ timeout: 15000 });
    await log(a.page).locator("video[title='demo.mp4']").waitFor();
    // 媒体真的能加载（签名 URL 有效）
    await a.page.waitForFunction(() => {
      const img = document.querySelector("img[alt='e2e-shot.png']");
      return img && img.complete && img.naturalWidth > 0;
    }, null, { timeout: 15000 });
    await a.page.waitForTimeout(800);
    await shot(a.page, "i02-media");
  });

  await step("A 生成邀请链接", async () => {
    await a.page.click("aside button[aria-haspopup=menu] >> nth=0");
    await a.page.click("[role=menuitem]:has-text('邀请成员')");
    await a.page.click("button:has-text('生成链接')");
    const input = a.page.locator("[aria-label=邀请链接]");
    await input.waitFor();
    inviteLink = await input.inputValue();
    if (!/\/invite\/[A-Za-z0-9_-]+$/.test(inviteLink)) throw new Error(`邀请链接格式不对：${inviteLink}`);
    await a.page.waitForTimeout(400);
    await shot(a.page, "i03-invite-dialog");
    await a.page.keyboard.press("Escape");
  });

  await step("B 打开邀请链接并加入（team.joined 去重）", async () => {
    await b.page.goto(inviteLink);
    await b.page.waitForSelector(`text=${teamName}`);
    await shot(b.page, "i04-invite-landing");
    await b.page.click(`button:has-text('加入 ${teamName}')`);
    await b.page.waitForURL(/\/channels\//, { timeout: 15000 });
    await log(b.page).locator("text=截图和录屏").waitFor();
    const railCount = await b.page.locator(`nav a[aria-label='${teamName}']`).count();
    if (railCount !== 1) throw new Error(`team 图标栏出现 ${railCount} 个同名 team`);
    // A 端通过 member.joined 实时看到 B
    await a.page.locator(`aside[aria-label=成员列表] >> text=${B.name}`).waitFor({ timeout: 10000 });
  });

  await step("A @B，B 通过 WS 实时收到并高亮", async () => {
    await mention(a.page, B.name, "看下这条消息");
    const row = log(b.page).locator("[data-mentions-me]").filter({ hasText: "看下这条消息" });
    await row.waitFor({ timeout: 10000 });
    await b.page.waitForTimeout(300);
    await shot(b.page, "i05-b-mentioned");
  });

  await step("B @A，A 实时收到并高亮", async () => {
    await mention(b.page, A.name, "收到，已看");
    await log(a.page).locator("[data-mentions-me]").filter({ hasText: "收到，已看" }).waitFor({ timeout: 10000 });
    await a.page.waitForTimeout(300);
    await shot(a.page, "i06-a-mentioned");
  });

  await step("B 断网（WS 断开）→ A 连发 3 条 → B 恢复后 after= 补拉", async () => {
    await b.ctx.setOffline(true);
    await b.page.waitForTimeout(1500);
    for (const t of ["断线期间 1", "断线期间 2", "断线期间 3"]) await send(a.page, t);
    await log(a.page).locator("text=断线期间 3").waitFor();
    await b.page.waitForTimeout(500);
    if (await log(b.page).locator("text=断线期间 1").count()) throw new Error("离线时不应收到");
    await b.ctx.setOffline(false);
    for (const t of ["断线期间 1", "断线期间 2", "断线期间 3"]) await log(b.page).locator(`text=${t}`).waitFor({ timeout: 40000 });
    const order = await log(b.page).evaluate((el) => el.innerText.indexOf("断线期间 1") < el.innerText.indexOf("断线期间 3"));
    if (!order) throw new Error("补拉后顺序不对");
    await shot(b.page, "i07-b-backfilled");
  });

  await step("A 修改 team 设置，B 收到 team.updated", async () => {
    await a.page.click("aside button[aria-haspopup=menu] >> nth=0");
    await a.page.click("[role=menuitem]:has-text('Team 设置')");
    await a.page.fill("input[aria-label='Team 名称']", `${teamName} ✓`);
    await a.page.fill("textarea[aria-label='Team 简介']", "联调：改名成功");
    await shot(a.page, "i08-team-settings");
    await a.page.click("[role=dialog] button:has-text('保存')");
    await a.page.waitForSelector("[role=dialog][aria-label='Team 设置']", { state: "detached" });
    await b.page.locator(`aside button[aria-haspopup=menu] >> text=${teamName} ✓`).waitFor({ timeout: 10000 });
  });

  await step("A 编辑个人资料（PATCH /me），B 看到 member.updated", async () => {
    await a.page.click("button[aria-label=用户设置]");
    await a.page.click("[role=menuitem]:has-text('编辑个人资料')");
    await a.page.fill("#profile-name", "联调A2");
    await a.page.click("[role=dialog] button:has-text('保存')");
    await a.page.waitForSelector("#profile-name", { state: "detached" });
    await b.page.locator("aside[aria-label=成员列表] >> text=联调A2").waitFor({ timeout: 10000 });
  });

  await step("所有者看到“退出 Team”置灰", async () => {
    await a.page.click("aside button[aria-haspopup=menu] >> nth=0");
    const disabled = await a.page.locator("[role=menuitem]:has-text('退出 Team')").isDisabled();
    if (!disabled) throw new Error("所有者的退出项应置灰");
    await shot(a.page, "i09-owner-menu");
    await a.page.keyboard.press("Escape");
  });

  await step("B 退出 team：B 回到列表（team.removed），A 看到成员减少（member.left）", async () => {
    await b.page.click("aside button[aria-haspopup=menu] >> nth=0");
    await b.page.click("[role=menuitem]:has-text('退出 Team')");
    await b.page.click("[role=dialog] button:has-text('退出 Team')");
    await b.page.waitForURL(/\/teams$/, { timeout: 10000 });
    await a.page.locator(`aside[aria-label=成员列表] >> text=${B.name}`).waitFor({ state: "detached", timeout: 10000 });
    await shot(b.page, "i10-b-left");
  });
} catch {
  /* 已记录 */
} finally {
  await browser.close();
  console.log(JSON.stringify({ base: BASE, users: [A.username, B.username], results, apiErrors, consoleErrors }, null, 1));
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}
if (!existsSync(SHOTS)) process.exitCode = 1;
