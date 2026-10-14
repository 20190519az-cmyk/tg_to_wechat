/**
 * Cloudflare Worker：每分钟抓取 Telegram 公开频道网页版 (t.me/s/<频道>)，
 * 把新消息推送到企业微信群机器人和/或飞书群机器人。已转发的最新消息 ID 存在 KV (STATE)。
 *
 * 绑定 / 变量（企微和飞书至少配一个，都是 wrangler secret）：
 *   STATE_DO           Durable Object：保存进度（强一致）并防止两轮同时运行
 *   STATE              KV 命名空间（旧版进度，只用于迁移）
 *   WECOM_WEBHOOK      企微群机器人 webhook
 *   FEISHU_APP_ID      飞书自建应用 App ID（应用机器人会发到它所在的所有群）
 *   FEISHU_APP_SECRET  飞书自建应用 App Secret
 *   FEISHU_CHAT_ID     可选，只发到指定的群（多个用逗号分隔）；不填则发到机器人所在的所有群
 *   TG_CHANNEL         频道用户名，不带 @
 */
import { DurableObject } from "cloudflare:workers";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

const TEXT_LIMIT = 2000;
const IMAGE_LIMIT = 2 * 1024 * 1024; // 企微图片上限
const FEISHU_IMAGE_LIMIT = 10 * 1024 * 1024; // 飞书图片上限
const FEISHU_TEXT_LIMIT = 30000; // 飞书富文本消息上限 150KB，正文留足余量
const FEISHU_API = "https://open.feishu.cn/open-apis";
const SEND_INTERVAL = 3200; // 企微限 20 条/分钟
const MAX_SENDS_PER_RUN = 18; // 每分钟跑一次，单次最多发 18 条，剩下的下一分钟继续
// 免费版每次运行只有 10ms CPU，图片编码/上传比较耗 CPU，所以每轮只处理少量帖子，剩下的下一分钟继续
const MAX_POSTS_PER_RUN = 3;
const MAX_IMAGES_PER_RUN = 4;
const LOCK_MS = 3 * 60 * 1000; // 上一轮被中断时，锁最多保留 3 分钟
const MAX_BACKFILL_PAGES = 5; // 网页版每页约 20 条；积压时最多往前翻 5 页补漏
const FEISHU_RETRY_MAX = 5; // 飞书单独失败的帖子最多补发 5 次
const FEISHU_QUEUE_MAX = 50;
const UA = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
};

export default {
  async scheduled(event, env, ctx) {
    await run(env);
  },

  // 诊断用接口，请求头 x-run-key 必须等于 RUN_KEY：
  //   POST /run     手动运行一次
  //   GET  /state   查看进度
  //   POST /rewind  进度回退到频道最新一条之前（下一轮会重发最新一条，用于测试）
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!env.RUN_KEY || request.headers.get("x-run-key") !== env.RUN_KEY) {
      return new Response("not found", { status: 404 });
    }
    const channel = channelOf(env);
    const text = (body, status = 200) =>
      new Response(body + "\n", { status, headers: { "content-type": "text/plain; charset=utf-8" } });
    if (request.method === "GET" && url.pathname === "/state") {
      return text(`进度: #${await loadProgress(env, channel) ?? "未初始化"}`);
    }
    if (request.method === "POST" && url.pathname === "/rewind") {
      const { posts } = await fetchPosts(channel);
      if (!posts.length) return text("抓不到频道消息", 500);
      const newest = posts[posts.length - 1].id;
      await stateOf(env).put(channel, String(newest - 1));
      return text(`进度已回退到 #${newest - 1}，下一轮会重发 #${newest}`);
    }
    if (request.method !== "POST" || url.pathname !== "/run") return text("not found", 404);
    const logs = [];
    const log = console.log;
    console.log = (...a) => { logs.push(a.join(" ")); log(...a); };
    let status = 200;
    try {
      await run(env);
    } catch (e) {
      logs.push(`错误: ${e.message}`);
      status = 500;
    } finally {
      console.log = log;
    }
    return new Response(logs.join("\n") + "\n", {
      status, headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};

function channelOf(env) {
  return (env.TG_CHANNEL || "jdbroo").replace(/^@/, "");
}

// ---------------- 进度（Durable Object） ----------------
export class State extends DurableObject {
  async get(key) {
    return (await this.ctx.storage.get(key)) ?? null;
  }

  async put(key, value) {
    await this.ctx.storage.put(key, value);
    await this.ctx.storage.delete("__attempt"); // 进度推进说明上一条已成功，失败计数清零
  }

  // 防止两轮同时运行导致重复发送；被中断的一轮留下的锁过期后自动失效
  async lock(ms) {
    const now = Date.now();
    if ((await this.ctx.storage.get("__lock")) > now) return false;
    await this.ctx.storage.put("__lock", now + ms);
    return true;
  }

  async unlock() {
    await this.ctx.storage.delete("__lock");
  }

  async getQueue() {
    return (await this.ctx.storage.get("__feishu_queue")) ?? [];
  }

  async setQueue(q) {
    await this.ctx.storage.put("__feishu_queue", q.slice(-FEISHU_QUEUE_MAX));
  }

  // 记录某条帖子第几次尝试：反复中途失败（如图片太大超出 CPU 限制）时改为只发文字，避免卡死、反复重发
  async attempt(id) {
    const a = await this.ctx.storage.get("__attempt");
    const n = a?.id === id ? a.n + 1 : 1;
    await this.ctx.storage.put("__attempt", { id, n });
    return n;
  }
}

function stateOf(env) {
  return env.STATE_DO.get(env.STATE_DO.idFromName("main"));
}

// 读进度；Durable Object 里还没有时从旧的 KV 迁移过来
async function loadProgress(env, channel) {
  const state = stateOf(env);
  let stored = await state.get(channel);
  if (stored === null && env.STATE) {
    stored = await env.STATE.get(channel);
    if (stored !== null) await state.put(channel, stored);
  }
  return stored;
}

async function fetchPage(channel, before) {
  const url = `https://t.me/s/${channel}` + (before ? `?before=${before}` : "");
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`抓取失败: HTTP ${res.status}`);
  return splitPosts(await res.text(), channel);
}

// 抓最新一页；如果最早一条和已转发进度之间有缺口（积压超过一页），往前翻页补齐
async function fetchPosts(channel, lastId = null) {
  const first = await fetchPage(channel);
  let posts = first.posts;
  for (let page = 0; lastId !== null && posts.length && posts[0].id > lastId + 1 &&
       page < MAX_BACKFILL_PAGES; page++) {
    const older = (await fetchPage(channel, posts[0].id)).posts.filter((p) => p.id < posts[0].id);
    if (!older.length) break;
    console.log(`往前翻页补漏：#${older[0].id}～#${older[older.length - 1].id}`);
    posts = older.concat(posts);
  }
  return { title: first.title, posts };
}

export async function run(env) {
  const channel = channelOf(env);
  const sender = new Sender(env.WECOM_WEBHOOK || null);
  // 只配了飞书时，飞书出错要中止并补发；同时配了企微时飞书只是尽力而为，不影响企微（也避免企微重复发送）
  const feishu = env.FEISHU_APP_ID && env.FEISHU_APP_SECRET ? new Feishu(env, !env.WECOM_WEBHOOK) : null;
  if (!env.WECOM_WEBHOOK && !feishu) throw new Error("WECOM_WEBHOOK 和 FEISHU_APP_ID/FEISHU_APP_SECRET 至少要配一个");

  const state = stateOf(env);
  if (!(await state.lock(LOCK_MS))) {
    console.log("上一轮还没结束，跳过");
    return;
  }
  try {
    await runLocked(env, channel, state, sender, feishu);
  } finally {
    await state.unlock();
  }
}

async function runLocked(env, channel, state, sender, feishu) {
  const stored = await loadProgress(env, channel);
  const { title, posts } = await fetchPosts(channel, stored === null ? null : Number(stored));
  if (!posts.length) {
    console.log("没有抓到任何消息，跳过");
    return;
  }

  if (stored === null) { // 首次运行：不刷屏，只记录位置并发一条测试消息
    const newest = posts[posts.length - 1].id;
    const hello = `✅ 已开始监听【${title}】，之后的新消息会自动转发过来。`;
    await sender.text(hello);
    if (feishu) await feishu.post(title, hello);
    await state.put(channel, String(newest));
    console.log(`初始化完成，从 #${newest} 之后开始转发`);
    return;
  }

  let handled = 0;
  let imageCount = 0;

  // 先补发一条之前飞书单独失败的帖子（企微当时已发过，这里只补飞书）
  const queue = feishu ? await state.getQueue() : [];
  if (queue.length) {
    const item = queue[0];
    item.tries = (item.tries || 0) + 1;
    await state.setQueue(queue); // 先记次数：本轮被中断也不会无限重试
    const images = [];
    for (const url of item.post.photos) {
      const data = await downloadImage(url);
      if (data) images.push(data);
    }
    const link = `https://t.me/${channel}/${item.post.id}`;
    if (await feishu.post(item.title, formatBody(item.post), link, images)) {
      console.log(`飞书补发成功 #${item.post.id}`);
      queue.shift();
    } else if (item.tries >= FEISHU_RETRY_MAX) {
      console.log(`飞书补发 #${item.post.id} 已失败 ${item.tries} 次，放弃`);
      queue.shift();
    } else {
      queue.push(queue.shift()); // 排到队尾，下次先试别的
    }
    await state.setQueue(queue);
    handled++;
    imageCount += item.post.photos.length;
  }

  const lastId = Number(stored);
  const newPosts = posts.filter((p) => p.id > lastId);
  console.log(`发现 ${newPosts.length} 条新消息`);
  let newHandled = 0;
  for (const raw of newPosts) {
    const p = await parsePost(raw);
    // 每轮的帖子数、图片数、企微条数有上限，超了留到下一分钟（每轮至少处理一条新帖子，避免卡死）
    if (newHandled > 0) {
      const parts = splitBytes(formatPost(p, title, channel), TEXT_LIMIT).length + p.photos.length;
      if (handled >= MAX_POSTS_PER_RUN || imageCount + p.photos.length > MAX_IMAGES_PER_RUN ||
          sender.count + parts > MAX_SENDS_PER_RUN) {
        console.log("本轮先处理到这里，剩下的下一分钟继续");
        break;
      }
    }
    const images = [];
    if ((await state.attempt(p.id)) <= 2) {
      for (const url of p.photos) {
        const data = await downloadImage(url);
        if (data) images.push(data);
      }
    } else if (p.photos.length) {
      console.log(`#${p.id} 已失败多次，这次不带图片`);
      p.text += `\n\n[${p.photos.length} 张图片请点链接查看]`;
    }
    await sender.text(formatPost(p, title, channel));
    for (const data of images) await sender.image(data);
    if (feishu && !(await feishu.post(title, formatBody(p), `https://t.me/${channel}/${p.id}`, images))) {
      const q = await state.getQueue();
      q.push({ title, post: p, tries: 0 });
      await state.setQueue(q);
      console.log(`#${p.id} 飞书发送失败，已加入补发队列`);
    }
    handled++;
    newHandled++;
    imageCount += p.photos.length;
    // 每条发完立刻记进度：本轮之后被中断（如超出 CPU 限制）也不会重复发已发过的
    await state.put(channel, String(p.id));
  }
}

function formatBody(p) {
  let body = p.text || "（无文字）";
  if (p.other) body += "\n\n[含视频/文件等内容，请点链接查看]";
  return body;
}

function formatPost(p, title, channel) {
  return `【${title}】\n${formatBody(p)}\nhttps://t.me/${channel}/${p.id}`;
}

async function downloadImage(url) {
  try {
    const r = await fetch(url, { headers: UA });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  } catch (e) {
    console.log(`图片下载失败 ${url}: ${e}`);
    return null;
  }
}

// ---------------- 解析 ----------------
// 先用正则把整页切成一条条消息（很省 CPU），只对新消息再细致解析
export function splitPosts(html, channel) {
  const t = /class="tgme_channel_info_header_title"[^>]*>([\s\S]*?)<\/div>/.exec(html);
  const title = t ? decodeEntities(t[1].replace(/<[^>]*>/g, "")).trim() || channel : channel;
  const re = /<div class="tgme_widget_message[ "][^>]*?data-post="[^"\/]+\/(\d+)"/g;
  const starts = [];
  let m;
  while ((m = re.exec(html))) starts.push({ id: Number(m[1]), at: m.index });
  const posts = starts.map((x, i) => ({ id: x.id, html: html.slice(x.at, starts[i + 1]?.at ?? html.length) }));
  posts.sort((a, b) => a.id - b.id);
  return { title, posts };
}

export async function parsePost({ id, html }) {
  const post = { id, text: "", photos: [], other: false };
  let inText = false;
  let buf = "";

  const rewriter = new HTMLRewriter()
    .on(".tgme_widget_message_text.js-message_text", {
      element(el) {
        inText = true;
        buf = "";
        el.onEndTag(() => {
          inText = false;
          post.text = decodeEntities(buf).trim();
        });
      },
      // 文字处理只挂在正文元素上（包括里面嵌套的标签），不扫描整页
      text(t) {
        if (inText) buf += t.text;
      },
    })
    .on(".tgme_widget_message_text.js-message_text br", {
      element() { if (inText) buf += "\n"; },
    })
    .on(".tgme_widget_message_text.js-message_text a", {
      element(el) {
        if (!inText) return;
        const href = decodeEntities(el.getAttribute("href") || "");
        const start = buf.length;
        el.onEndTag(() => {
          const label = decodeEntities(buf.slice(start)).trim();
          // 文字链接(显示文字 ≠ 网址)时把网址补在后面；话题标签之类的站内链接只保留文字
          if (href.startsWith("http") && !href.includes("t.me/s/") && label &&
              label !== href && !label.startsWith("http")) {
            buf += `（${escapeForBuf(href)}）`;
          }
        });
      },
    })
    .on(".tgme_widget_message_photo_wrap", {
      element(el) {
        const m = /url\(['"]?(.*?)['"]?\)/.exec(el.getAttribute("style") || "");
        if (m) post.photos.push(decodeEntities(m[1]));
      },
    })
    .on(".tgme_widget_message_video_player, .tgme_widget_message_document, .message_media_not_supported", {
      element() { post.other = true; },
    });

  await rewriter.transform(new Response(html)).arrayBuffer();
  return post;
}

// buf 里存的是未解码的 HTML 文本，补进去的网址要转义，避免被二次解码
function escapeForBuf(s) {
  return s.replace(/&/g, "&amp;");
}

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|#39);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k.startsWith("#x")) return String.fromCodePoint(parseInt(k.slice(2), 16));
    if (k.startsWith("#")) return String.fromCodePoint(parseInt(k.slice(1), 10));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }[k] ?? m;
  });
}

// ---------------- 企业微信 ----------------
class Sender {
  constructor(webhook) {
    this.webhook = webhook; // 为空时不发企微
    this.last = 0;
    this.count = 0;
  }

  async post(payload) {
    if (!this.webhook) return;
    for (let attempt = 0; attempt < 5; attempt++) {
      const wait = SEND_INTERVAL - (Date.now() - this.last);
      if (this.last && wait > 0) await sleep(wait);
      this.last = Date.now();
      let data;
      try {
        const r = await fetch(this.webhook, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        data = await r.json();
      } catch (e) {
        console.log(`发送异常: ${e}，重试`);
        await sleep(2 ** attempt * 1000);
        continue;
      }
      if (data.errcode === 0) {
        this.count++;
        return;
      }
      if (data.errcode === 45009) {
        // 限流：中止本轮，进度已保存，下一分钟继续
        throw new Error("企微限流 (45009)，下一分钟继续");
      }
      // 其他错误（webhook 失效等）：中止，不推进进度，避免漏消息
      throw new Error(`企微返回错误: ${JSON.stringify(data)}`);
    }
    throw new Error("企微发送多次失败");
  }

  async text(content) {
    for (const chunk of splitBytes(content, TEXT_LIMIT)) {
      await this.post({ msgtype: "text", text: { content: chunk } });
    }
  }

  async image(data) {
    if (!this.webhook) return;
    if (data.length > IMAGE_LIMIT) { // Worker 里不方便压缩，超限的图片靠原帖链接查看
      console.log("图片超过 2MB，企微跳过");
      return;
    }
    await this.post({
      msgtype: "image",
      image: { base64: data.toString("base64"), md5: createHash("md5").update(data).digest("hex") },
    });
  }
}

// ---------------- 飞书（自建应用机器人） ----------------
class Feishu {
  constructor(env, strict) {
    this.appId = env.FEISHU_APP_ID;
    this.appSecret = env.FEISHU_APP_SECRET;
    this.chatIds = (env.FEISHU_CHAT_ID || "").split(",").map((x) => x.trim()).filter(Boolean);
    this.strict = strict;
    this.token = null; // tenant_access_token，本次运行内复用
  }

  // 一条帖子发成一条富文本消息：正文 + 原帖链接 + 图片，发到每个目标群。
  // 和企微一起用时出错只返回 false（由调用方放进补发队列）；只用飞书时直接抛错，进度不推进
  async post(title, text, link, images = []) {
    try {
      const body = splitBytes(text, FEISHU_TEXT_LIMIT);
      const content = (body.length > 1 ? body[0] + "…" : body[0]).split("\n")
        .map((line) => [{ tag: "text", text: line }]);
      if (link) content.push([{ tag: "a", text: "查看原帖", href: link }]);
      let missing = 0;
      for (const data of images) {
        const key = await this.uploadImage(data);
        if (key) content.push([{ tag: "img", image_key: key }]);
        else missing++;
      }
      if (missing) content.push([{ tag: "text", text: `[${missing} 张图片未能上传，请点原帖查看]` }]);
      const msg = JSON.stringify({ zh_cn: { title, content } });
      const chats = await this.chats();
      if (!chats.length) throw new Error("机器人还没有加入任何群，请先把应用机器人拉进群");
      for (const chatId of chats) {
        await this.api("/im/v1/messages?receive_id_type=chat_id", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ receive_id: chatId, msg_type: "post", content: msg }),
        });
      }
      return true;
    } catch (e) {
      if (this.strict) throw new Error(`飞书发送失败: ${e.message}`);
      console.log(`飞书发送失败: ${e.message}`);
      return false;
    }
  }

  async api(path, init) {
    if (!this.token) {
      const r = await fetch(`${FEISHU_API}/auth/v3/tenant_access_token/internal`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
      });
      const t = await r.json();
      if (t.code !== 0) throw new Error(`获取 token 失败（检查 App ID/Secret）: ${JSON.stringify(t)}`);
      this.token = t.tenant_access_token;
    }
    const r = await fetch(`${FEISHU_API}${path}`, {
      ...init,
      headers: { ...(init?.headers || {}), Authorization: `Bearer ${this.token}` },
    });
    const res = await r.json().catch(() => ({}));
    if (res.code !== 0) throw new Error(`${path.split("?")[0]} → HTTP ${r.status} ${JSON.stringify(res).slice(0, 300)}`);
    return res.data;
  }

  // 没指定 FEISHU_CHAT_ID 时，发到机器人所在的所有群
  async chats() {
    if (this.chatIds.length) return this.chatIds;
    const ids = [];
    let pageToken = "";
    do {
      const q = new URLSearchParams({ page_size: "100" });
      if (pageToken) q.set("page_token", pageToken);
      const data = await this.api(`/im/v1/chats?${q}`, { method: "GET" });
      for (const c of data.items || []) ids.push(c.chat_id);
      pageToken = data.has_more ? data.page_token : "";
    } while (pageToken);
    this.chatIds = ids;
    return ids;
  }

  async uploadImage(data) {
    if (data.length > FEISHU_IMAGE_LIMIT) {
      console.log("图片超过 10MB，飞书跳过");
      return null;
    }
    try {
      const form = new FormData();
      form.append("image_type", "message");
      form.append("image", new Blob([data]), "image.jpg");
      const res = await this.api("/im/v1/images", { method: "POST", body: form });
      return res.image_key;
    } catch (e) {
      console.log(`飞书图片上传失败: ${e.message}`);
      return null;
    }
  }
}

export function splitBytes(s, limit) {
  const chunks = [];
  let cur = "";
  let size = 0;
  for (const ch of s) {
    const n = Buffer.byteLength(ch, "utf8");
    if (size + n > limit) {
      chunks.push(cur);
      cur = "";
      size = 0;
    }
    cur += ch;
    size += n;
  }
  if (cur) chunks.push(cur);
  return chunks.length ? chunks : [""];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
