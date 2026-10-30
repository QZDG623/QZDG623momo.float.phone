// v13：本次升版是为了强制作废旧缓存。
// 折叠逻辑的修复已进 main，但客户端仍在跑旧 JS —— /_next/static/ 走 cache-first，
// 旧包会被一直留在 RUNTIME_CACHE 里。升 CACHE_VERSION 会在 activate 时整批清空。
// v14：同上，为语音朗读清洗（只念台词、不再把 CSS/旁白当台词念）清一次旧缓存。
// v15：显示层清洗——灰色旁白气泡与 (breath) 标签不再进聊天正文；同样需要强制作废旧 JS。
// v16：线下模式渲染路径也接入清洗（它不走 MessageBubble，以前会漏），并处理转义成
//      `&lt;span&gt;` 的旁白 HTML；语音条时长按真实台词重算。再清一次旧缓存。
// v17：v16 那次 Netlify 构建失败、线上一直停在 v15，设备侧仍跑着旧 JS。
//      本次连同 APK 1.0.16 一起重发，再次清空旧缓存，确保灰色旁白与
//      (breath) 清洗真正生效。
// v18：线上实际停留在 commit 6b4ab91 的旧构建（t2a_v2 请求里仍带 (breath)，
//      于是模型把 breath 念成英文）。本次把 Sound Tag 全换成 <#x#> 停顿、
//      中文台词里的英文一律抹掉，连同 APK 1.0.17 重发，再清一次旧 JS。
// v19：v18 的 <#x#> 停顿标记在用户 MiniMax 账号上被忽略，breath 仍被念成英文。
//      本次彻底放弃括号 Sound Tag 和 <#x#>，所有括号整块删掉、官方标签换成
//      中文标点（breath→逗号、sighs→省略号），连同 APK 1.0.20 重发。
// 注意：这么大范围的清空会让字体/模型重新下载一轮，是刻意为之——只在
// 修复客户端"跑旧 JS"时才升版，日常改动不要动这个数字。
// v20：收回「中文台词里的英文一律抹掉」，只删括号内容；台词正文里的英文照常念。
// v22：v20 只跑到「网页 PWA」层，Vercel 生产构建仍停在 cab86e2（那边英文照旧被抹掉）。
//      本次清一次缓存，让设备重新拉取只删括号的新 JS。
// v23：新增 MiniMax 语音识别支持 + 通话免提连续语音输入，清缓存让设备拉取新 JS。
// v24：修复免提录音听不到声音（AudioContext 被挂起 → 电平恒 0 → VAD 不触发），
//      并修复自动搭话面板被拖出屏幕/高度溢出导致改不了参数。
// v25：麦克风申请改回 audio:true 并带自动重试；AI 说话期间只静音不再反复释放麦克风。
// v26：WebView 音频采集在部分机型直接 NotReadableError，免提语音改走壳的原生
//      AudioRecord（window.FloatMic），网页侧只轮询电平 + 取 WAV 段送识别。
// v27：新增 Fish Audio 语音服务商（TTS + 音色同步 + 识别）。
// v28：识别方案可与合成方案分开；Fish 识别额度不足时报可操作的中文提示。
// v29：视频通话支持自定义角色形象（闭嘴/张嘴/闭眼差分图），说话张嘴 + 随机眨眼。
// v30：张嘴节奏放慢到正常语速，且只在真正播放语音时才切换。
const CACHE_VERSION = "ai-phone-pwa-v31";
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

const PRECACHE_URLS = [
  "/",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => !key.startsWith(CACHE_VERSION))
          .map((key) => caches.delete(key))
      ))
      // 刷新预缓存的 "/" 快照：它是离线导航的最终兜底，若停留在旧部署版本，
      // 引用的旧 hash CSS/JS 已 404，会渲染出无样式页面（文字堆在左上角）。
      .then(() => caches.open(STATIC_CACHE))
      .then((cache) => cache.add(new Request("/", { cache: "reload" })).catch(() => {}))
      .then(() => self.clients.claim())
  );
});

function isCacheableRequest(request) {
  if (request.method !== "GET") return false;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith("/api/")) return false;
  if (url.pathname.startsWith("/_next/static/")) return true;
  return ["font", "image", "script", "style", "worker"].includes(request.destination);
}

async function networkFirst(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    const fallback = await caches.match("/");
    if (fallback) return fallback;
    throw error;
  }
}

// 静态资源（字体/图片/脚本/样式/模型）用 cache-first：命中缓存直接返回，
// 不再每次都在后台把整份文件重新拉一遍校验。字体动辄 7~24MB，旧的
// stale-while-revalidate 会持续重下，是带宽爆掉的主因之一。
// 需要更新缓存内容时，升 CACHE_VERSION 即可让旧缓存在 activate 时清空。
async function cacheFirst(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

// 离线推送：App 被杀后由系统唤起 SW 弹通知。payload 由服务端 JSON 编码。
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (error) {
    data = { body: event.data ? event.data.text() : "" };
  }
  const declarative = data.web_push === 8030 && data.notification && typeof data.notification === "object"
    ? data.notification
    : null;
  const notificationData = declarative && declarative.data && typeof declarative.data === "object"
    ? declarative.data
    : data;
  const title = (declarative && declarative.title) || data.title || "小手机";
  event.waitUntil((async () => {
    if (notificationData.type === "chat_outbox") {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const visible = windows.filter((client) => client.visibilityState === "visible");
      if (visible.length > 0) {
        visible.forEach((client) => client.postMessage({ type: "push_outbox_ready" }));
        return;
      }
    }
    // 来电推送：页面可见时直接进页面振铃（来电横幅），不弹系统通知
    if (notificationData.type === "incoming_call") {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const visible = windows.filter((client) => client.visibilityState === "visible");
      if (visible.length > 0) {
        visible.forEach((client) => client.postMessage({
          type: "incoming_call_push",
          sessionId: notificationData.sessionId || "",
          callTs: notificationData.callTs || 0,
        }));
        visible.forEach((client) => client.postMessage({ type: "push_outbox_ready" }));
        return;
      }
    }
    await self.registration.showNotification(title, {
      body: (declarative && declarative.body) || data.body || "",
      icon: (declarative && declarative.icon) || data.icon || "/icon-192.png",
      badge: (declarative && declarative.badge) || "/icon-192.png",
      tag: (declarative && declarative.tag) || data.tag || `push-${Date.now()}`,
      data: {
        url: (declarative && declarative.navigate) || notificationData.url || "/",
        type: notificationData.type || "",
        commandId: notificationData.commandId || "",
        sessionId: notificationData.sessionId || "",
        callTs: notificationData.callTs || 0,
      },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const notificationData = event.notification.data || {};
  const targetUrl = notificationData.url || "/";
  if (notificationData.type === "shortcut_command") {
    // iOS silently ignores custom URL schemes passed to clients.openWindow().
    event.waitUntil((async () => {
      const absoluteUrl = new URL(targetUrl, self.location.origin).href;
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // 有活窗口：不导航（navigate 会杀掉 SPA，回来一片空白、进行中的生成全断）。
      // 交给页面自己 location 到 /shortcut-run——302 到 shortcuts:// 属于外部 App
      // 启动，WebKit 不会卸载当前页面，聊天界面与本地生成原地保留。
      for (const client of windows) {
        if ("focus" in client) {
          client.postMessage({ type: "run_shortcut", url: absoluteUrl });
          return client.focus();
        }
      }
      // App 已被杀：没有页面可保，开新窗口走 /shortcut-run 跳转
      return self.clients.openWindow(absoluteUrl);
    })());
    return;
  }
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) {
          if (notificationData.type === "chat_outbox") {
            client.postMessage({ type: "push_outbox_ready" });
          }
          if (notificationData.type === "incoming_call") {
            // 有活窗口：不导航（会杀掉 SPA），交给页面弹来电横幅 + 合并 outbox
            client.postMessage({
              type: "incoming_call_push",
              sessionId: notificationData.sessionId || "",
              callTs: notificationData.callTs || 0,
            });
            client.postMessage({ type: "push_outbox_ready" });
          }
          return client.focus();
        }
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request));
    return;
  }
  if (isCacheableRequest(request)) {
    event.respondWith(cacheFirst(request));
  }
});
