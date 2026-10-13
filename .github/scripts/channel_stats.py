"""统计频道最近几天每天的消息数和图片数。"""
import collections, re, sys, time, urllib.request
from datetime import datetime, timedelta, timezone

channel, days = sys.argv[1], int(sys.argv[2])
cutoff = datetime.now(timezone.utc) - timedelta(days=days)
UA = {"User-Agent": "Mozilla/5.0"}
stats = collections.defaultdict(lambda: [0, 0])  # 日期 -> [消息数, 图片数]
before, seen = None, set()
for _ in range(200):
    url = f"https://t.me/s/{channel}" + (f"?before={before}" if before else "")
    html = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30).read().decode()
    parts = re.split(r'(?=<div class="tgme_widget_message_wrap)', html)[1:]
    ids = []
    oldest = None
    for p in parts:
        m = re.search(rf'data-post="{channel}/(\d+)"', p)
        t = re.search(r'<time datetime="([^"]+)"', p)
        if not m or not t:
            continue
        pid = int(m.group(1)); ids.append(pid)
        if pid in seen:
            continue
        seen.add(pid)
        dt = datetime.fromisoformat(t.group(1))
        oldest = dt if oldest is None or dt < oldest else oldest
        if dt < cutoff:
            continue
        day = dt.astimezone(timezone(timedelta(hours=8))).strftime("%m-%d")  # 北京时间
        stats[day][0] += 1
        stats[day][1] += p.count("tgme_widget_message_photo_wrap")
    if not ids or (oldest and oldest < cutoff):
        break
    before = min(ids)
    time.sleep(1)

print(f"频道 {channel} 最近 {days} 天（北京时间）：")
print("日期    消息  图片")
tot = [0, 0]
for d in sorted(stats):
    m, i = stats[d]; tot[0] += m; tot[1] += i
    print(f"{d}   {m:4d}  {i:4d}")
n = len(stats) or 1
print(f"日均: 消息 {tot[0]/n:.0f}，图片 {tot[1]/n:.0f}")
