// Run against the frontend's mock dev server with Playwright installed.
// E2E_BASE and CHROME_PATH can override the dev URL and Chromium executable.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
page.setDefaultTimeout(6000);
const errors = [];
page.on("pageerror", e => errors.push(e.message));
const field = name => page.getByRole("textbox", { name, exact: true });
const button = name => page.getByRole("button", { name, exact: true });
const mod = process.platform === "darwin" ? "Meta" : "Control";
const base = process.env.E2E_BASE ?? "http://localhost:5190";
async function clear(input) {
  await input.focus();
  await input.press(mod + "+a");
  await input.press("Backspace");
}
async function lastLine(input, text) {
  await page.waitForFunction(({ name, text }) => {
    const input = [...document.querySelectorAll('[role="textbox"]')].find(e => e.getAttribute("aria-label") === name);
    return input?.querySelector(".cm-line:last-child")?.textContent === text;
  }, { name: await input.getAttribute("aria-label"), text }).catch(async () => {
    assert.equal(await input.locator(".cm-line").last().textContent(), text);
  });
}
async function inlineCases(input) {
  for (const [source, rendered] of [
    ["**bold**", "bold"], ["_italics_", "italics"], ["**bold and _italic_**", "bold and italic"],
    ["`badge`", "badge"], ["``a ` b``", "a ` b"], ["[label](https://example.org)", "label"],
  ]) {
    await clear(input);
    await input.pressSequentially(source);
    await lastLine(input, source);
    await input.press("Space");
    await lastLine(input, rendered + " ");
    await input.press("ArrowLeft");
    await lastLine(input, source + " ");
  }
}
try {
  await page.goto(base + "/login");
  await page.locator("#login-username").fill("alice");
  await page.locator("#login-password").fill("test");
  await button("登录").click();
  await page.locator("main a[href^='/teams/']").first().click();
  const chat = field("消息输入框");
  await inlineCases(chat);

  await clear(chat);
  await chat.pressSequentially("**bold**");
  // Move the caret to start a separate undo group for this deletion.
  await chat.press("ArrowLeft");
  await chat.press("ArrowRight");
  await chat.press("Backspace");
  await lastLine(chat, "**bold*");
  await chat.press(mod + "+z");
  await lastLine(chat, "**bold**");
  await chat.press("Shift+ArrowLeft");
  await chat.pressSequentially("x");
  await chat.press(mod + "+a");
  await lastLine(chat, "**bold*x");

  const cdp = await page.context().newCDPSession(page);
  await clear(chat);
  await chat.pressSequentially("**");
  await cdp.send("Input.imeSetComposition", { text: "zhong", selectionStart: 5, selectionEnd: 5 });
  await cdp.send("Input.imeSetComposition", { text: "中文", selectionStart: 2, selectionEnd: 2 });
  await cdp.send("Input.insertText", { text: "中文" });
  await chat.pressSequentially("**");
  await lastLine(chat, "**中文**");

  await clear(chat);
  await chat.pressSequentially("```js");
  await chat.press("Enter");
  await chat.pressSequentially('const value = "@bob";');
  await chat.locator(".md-block .md-token-keyword").first().waitFor();
  await chat.locator(".md-block .md-token-string").first().waitFor();
  assert.equal(await page.getByRole("listbox", { name: "@ 成员候选" }).count(), 0);
  await chat.press("Enter");
  await chat.press("Enter");
  await chat.press("Enter");
  await chat.pressSequentially("// more");
  await button("展开编辑器").click();
  await chat.press("Enter");
  await chat.pressSequentially("```");
  assert.equal(await chat.locator(".md-block").count(), 6);
  await button("收起编辑器").click();
  await chat.press("Enter");
  const posted = page.getByTestId("message-content").filter({ hasText: "const value" }).last();
  assert.equal(await posted.locator("pre code").innerText(), 'const value = "@bob";\n\n\n// more\n');
  await chat.pressSequentially("@");
  await page.getByRole("listbox", { name: "@ 成员候选" }).waitFor();
  await clear(chat);

  await page.locator("a[href$='/issues']").last().click();
  await button("新建 Issue").click();
  const title = field("Issue 标题"), description = field("描述");
  await inlineCases(title);
  await clear(title);
  await title.pressSequentially("Live `md`");
  await inlineCases(description);
  for (const [language, code, token] of [
    ["ts", "const num: number = 2;", "keyword"], ["json", '{"num":2}', "number"],
    ["css", "a { color: red; }", "name"], ["html", "<b>text</b>", "name"],
  ]) {
    await clear(description);
    await page.keyboard.insertText("~~~" + language + "\n" + code + "\n~~~");
    await description.locator(".md-block .md-token-" + token).first().waitFor();
  }
  await clear(description);
  const body = '# Heading\n\n> quote\n\n- first\n- second\n\n1. ordered\n\n~~~python\nvalue = "text"\n\n~~~\n\nend';
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(base).origin });
  await page.evaluate(s => navigator.clipboard.writeText(s), body);
  await description.press(mod + "+v");
  await lastLine(description, "end");
  await description.locator(".md-block .md-token-string").first().waitFor();
  assert.equal(await description.locator(".md-block").count(), 4);
  assert.equal(await description.locator(".md-quote-line").count(), 1);
  assert.equal(await description.locator(".md-heading").innerText(), " Heading");
  await description.press(mod + "+a");
  await description.press(mod + "+c");
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), body);
  await button("最大化").click();
  await button("创建 Issue").click();
  await page.locator("button.issue-row-title").filter({ hasText: "Live md" }).click();
  const saved = page.locator(".issue-description-panel");
  assert.equal(await saved.locator("blockquote").innerText(), "quote");
  assert.equal(await saved.locator("ul li").count(), 2);
  assert.equal(await saved.locator("ol li").innerText(), "ordered");
  assert.equal(await saved.locator("pre code").innerText(), 'value = "text"\n\n');
  const comment = field("评论内容");
  await comment.pressSequentially("`comment`");
  await lastLine(comment, "`comment`");
  await button("发送评论").click();
  const reply = field("回复内容");
  await reply.pressSequentially("**reply**");
  await lastLine(reply, "**reply**");
  await button("发送回复").click();
  await page.locator(".comment-content strong").getByText("reply", { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log("Passed channel and Issue live preview, caret editing, undo, IME, clipboard, fences, and persistence.");
} finally {
  await browser.close();
}
