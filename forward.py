"""
抓取 Telegram 公开频道网页版 (t.me/s/<频道>)，把新消息推送到企业微信群机器人。
由 GitHub Actions 定时运行，已转发的最新消息 ID 保存在 state.json。

环境变量：
  WECOM_WEBHOOK  企微群机器人 webhook（放在仓库 Secrets 里）
  TG_CHANNEL     频道用户名，不带 @，默认 jdbroo
"""
import base64
import hashlib
import io
import json
import os
import re
import sys
import time

import requests
from bs4 import BeautifulSoup
from PIL import Image

WEBHOOK = os.environ["WECOM_WEBHOOK"]
CHANNEL = os.environ.get("TG_CHANNEL", "jdbroo").lstrip("@")
STATE_FILE = "state.json"
TEXT_LIMIT = 2000
IMAGE_LIMIT = 2 * 1024 * 1024
SEND_INTERVAL = 3.2  # 企微限 20 条/分钟
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"}

_last_send = 0.0


# ---------------- 抓取与解析 ----------------
def fetch_posts():
    r = requests.get(f"https://t.me/s/{CHANNEL}", headers=UA, timeout=30)
    r.raise_for_status()
    return parse_posts(r.text)


def parse_posts(html):
    soup = BeautifulSoup(html, "html.parser")
    title_el = soup.select_one(".tgme_channel_info_header_title")
    title = title_el.get_text(strip=True) if title_el else CHANNEL
    posts = []
    for msg in soup.select(".tgme_widget_message[data-post]"):
        try:
            pid = int(msg["data-post"].split("/")[-1])
        except ValueError:
            continue
        text_el = msg.select_one(".tgme_widget_message_text.js-message_text")
        text = html_to_text(text_el) if text_el else ""
        photos = []
        for p in msg.select(".tgme_widget_message_photo_wrap"):
            m = re.search(r"url\(['\"]?(.*?)['\"]?\)", p.get("style", ""))
            if m:
                photos.append(m.group(1))
        has_other = bool(msg.select(".tgme_widget_message_video_player, "
                                    ".tgme_widget_message_document, "
                                    ".message_media_not_supported"))
        posts.append({"id": pid, "text": text, "photos": photos, "other": has_other})
    posts.sort(key=lambda p: p["id"])
    return title, posts


def html_to_text(el):
    for br in el.find_all("br"):
        br.replace_with("\n")
    for a in el.find_all("a"):
        href, label = a.get("href", ""), a.get_text()
        # 文字链接(显示文字 ≠ 网址)时把网址补在后面；话题标签之类的站内链接只保留文字
        if href.startswith("http") and "t.me/s/" not in href and label.strip() and label.strip() != href:
            if not label.strip().startswith("http"):
                a.replace_with(f"{label}（{href}）")
    return el.get_text().strip()


# ---------------- 企业微信 ----------------
def wecom_send(payload):
    global _last_send
    for attempt in range(5):
        wait = SEND_INTERVAL - (time.time() - _last_send)
        if wait > 0:
            time.sleep(wait)
        _last_send = time.time()
        try:
            data = requests.post(WEBHOOK, json=payload, timeout=30).json()
        except Exception as e:
            print(f"发送异常: {e}，重试")
            time.sleep(2 ** attempt)
            continue
        if data.get("errcode") == 0:
            return True
        if data.get("errcode") == 45009:
            print("企微限流，等待 60 秒")
            time.sleep(60)
            continue
        print(f"企微返回错误: {data}")
        return False
    return False


def send_text(content):
    ok = True
    for chunk in split_bytes(content, TEXT_LIMIT):
        ok &= wecom_send({"msgtype": "text", "text": {"content": chunk}})
    return ok


def send_image(url):
    try:
        data = requests.get(url, headers=UA, timeout=30).content
        data = fit_image(data)
    except Exception as e:
        print(f"图片下载失败 {url}: {e}")
        return
    wecom_send({"msgtype": "image", "image": {
        "base64": base64.b64encode(data).decode(),
        "md5": hashlib.md5(data).hexdigest(),
    }})


def split_bytes(s, limit):
    chunks, cur, size = [], [], 0
    for ch in s:
        n = len(ch.encode("utf-8"))
        if size + n > limit:
            chunks.append("".join(cur))
            cur, size = [], 0
        cur.append(ch)
        size += n
    if cur:
        chunks.append("".join(cur))
    return chunks or [""]


def fit_image(data):
    if len(data) <= IMAGE_LIMIT:
        return data
    img = Image.open(io.BytesIO(data)).convert("RGB")
    side, quality = 2560, 85
    while True:
        img.thumbnail((side, side))
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=quality)
        if buf.tell() <= IMAGE_LIMIT or side < 400:
            return buf.getvalue()
        side, quality = int(side * 0.8), max(50, quality - 10)


# ---------------- 主流程 ----------------
def load_state():
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def save_state(state):
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)


def main():
    state = load_state()
    last_id = state.get(CHANNEL)
    title, posts = fetch_posts()
    if not posts:
        print("没有抓到任何消息，跳过")
        return

    if last_id is None:  # 首次运行：不刷屏，只记录位置并发一条测试消息
        newest = posts[-1]["id"]
        send_text(f"✅ 已开始监听【{title}】，之后的新消息会自动转发到本群。")
        state[CHANNEL] = newest
        save_state(state)
        print(f"初始化完成，从 #{newest} 之后开始转发")
        return

    new_posts = [p for p in posts if p["id"] > last_id]
    print(f"发现 {len(new_posts)} 条新消息")
    for p in new_posts:
        body = f"【{title}】\n{p['text'] or '（无文字）'}"
        if p["other"]:
            body += "\n\n[含视频/文件等内容，请点链接查看]"
        body += f"\nhttps://t.me/{CHANNEL}/{p['id']}"
        send_text(body)
        for url in p["photos"]:
            send_image(url)
        state[CHANNEL] = p["id"]
        save_state(state)  # 每条成功后立即记录，中途失败也不会重复转发


if __name__ == "__main__":
    try:
        main()
    except requests.HTTPError as e:
        print(f"抓取失败: {e}")
        sys.exit(1)
