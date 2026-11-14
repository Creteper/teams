/* TeAms Service Worker：只处理 Web Push（docs/api.md §9.4），不做离线缓存。
 * 放在 public/ 下，构建后位于站点根目录 /sw.js，scope 为 "/"（覆盖 /teams/... 全部前端路由）。
 * 处理逻辑写成具名函数挂在 self.__teamsSw 上，便于单元测试直接调用。 */

/** 载荷 → showNotification 参数 */
function notificationFromPayload(p) {
  const sender = (p && p.sender && p.sender.display_name) || "有人";
  const channel = p && p.channel && p.channel.name ? `#${p.channel.name}` : "";
  const team = (p && p.team && p.team.name) || "TeAms";
  return {
    title: `${sender} 在 ${team} ${channel} @了你`.replace(/\s+/g, " ").trim(),
    options: {
      body: (p && p.message && p.message.excerpt) || "",
      tag: (p && p.tag) || undefined,
      icon: (p && p.sender && p.sender.avatar_url) || "/icons/icon-192.png",
      // badge：透明底单色白剪影（Android 状态栏只取 alpha），icon 继续用彩色的
      badge: "/icons/badge-72.png",
      data: { url: (p && p.url) || "/teams" },
    },
  };
}

async function handlePush(event) {
  let payload = null;
  try {
    payload = event.data ? event.data.json() : null;
  } catch {
    payload = null;
  }
  if (!payload || payload.type !== "mention") {
    // 规范要求 userVisibleOnly：收到推送必须显示点什么
    return self.registration.showNotification("TeAms", { body: "你有新的 @ 消息", data: { url: "/teams" } });
  }
  const n = notificationFromPayload(payload);
  return self.registration.showNotification(n.title, n.options);
}

/** 点击通知：已有本站标签页 → 聚焦并让页面内路由跳转；没有 → 打开新窗口 */
async function handleNotificationClick(event) {
  event.notification.close();
  const rel = (event.notification.data && event.notification.data.url) || "/teams";
  const url = new URL(rel, self.location.origin).href;
  const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const same = list.filter((c) => c.url && c.url.startsWith(self.location.origin));
  const target = same.find((c) => c.focused) || same[0];
  if (target) {
    // 只有真实的通知点击才带“用户激活”，focus() 在其它情况下会抛 InvalidAccessError；失败也照样让页面跳转
    try {
      await target.focus();
    } catch {
      /* ignore */
    }
    target.postMessage({ type: "teams:navigate", url: rel });
    return target;
  }
  return self.clients.openWindow(url);
}

self.__teamsSw = { notificationFromPayload, handlePush, handleNotificationClick };

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("push", (event) => event.waitUntil(handlePush(event)));
self.addEventListener("notificationclick", (event) => event.waitUntil(handleNotificationClick(event)));
