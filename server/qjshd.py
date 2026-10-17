#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Q将水浒自动化 · 服务器版（自 Cloudflare Worker 完整迁移）

形态：单进程常驻（面板 HTTP 线程 + 每分钟调度线程），状态存本地 JSON（原子写）
部署：/opt/qjsh/qjshd.py + page.html；systemd: qjshd.service；端口 8787
依赖：仅 Python 3 标准库
"""
import json
import os
import threading
from concurrent.futures import ThreadPoolExecutor
import time
import uuid
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib import parse as urllib_parse
from urllib import request as urllib_request
from urllib import error as urllib_error

BASE = "https://service.qjsh.top"
PORT = 8787
STATE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "state")
PAGE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "page.html")
TZ = timezone(timedelta(hours=8))  # 北京时间

PURPLE_PLUS = ["PURPLE", "ORANGE"]
EXCHANGE_TIERS = [8, 5, 1]
DAILY_MINING = 10
LOG_MAX = 300
NO_TOKEN_WARN_MS = 3600_000
ACTIVITY_TIMEOUT_S = 10 * 60
SELF_ACTION_GRACE_S = 2 * 60
GONE_TTL_S = 5 * 60
GRABBED_TTL_S = 30 * 60
FP_NAMES = ["progress", "copper", "yuanbao", "ticket"]
SNAP_WRITE_THROTTLE_S = 5 * 60

PANEL_SECRET_FILE = os.path.join(STATE_DIR, "secret.json")

def get_secret():
    try:
        with open(PANEL_SECRET_FILE, encoding="utf-8") as f:
            s = json.load(f).get("secret")
            if s:
                return s
    except Exception:
        pass
    import secrets as _secrets
    s = _secrets.token_hex(8)
    os.makedirs(STATE_DIR, exist_ok=True)
    save("secret", {"secret": s})
    return s


NGINX_404 = b"<html><head><title>404 Not Found</title></head><body><center><h1>404 Not Found</h1></center><hr><center>nginx</center></body></html>"


LOCK = threading.RLock()
_warn_cache = {}  # 内存限频（warnOnce）


# ---------- 状态（JSON 文件，原子写） ----------

def _now_ms():
    return int(time.time() * 1000)


def spath(key):
    return os.path.join(STATE_DIR, f"{key}.json")


def load(key, fallback):
    try:
        with open(spath(key), encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return fallback


def save(key, value):
    os.makedirs(STATE_DIR, exist_ok=True)
    tmp = spath(key) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(value, f, ensure_ascii=False)
    os.replace(tmp, spath(key))


def add_log(msg, level="info"):
    with LOCK:
        log = load("log", [])
        _n = datetime.now(TZ)
        log.insert(0, {"t": _n.strftime("%Y-%m-%dT%H:%M:%S.") + f"{_n.microsecond // 1000:03d}+08:00", "msg": msg, "level": level})
        del log[LOG_MAX:]
        _cutoff = time.time() - 86400
        log[:] = [l for l in log if _parse_ts(l.get("t", "")) >= _cutoff]
        save("log", log)


def warn_once(cache_key, msg):
    with LOCK:
        now = _now_ms()
        if now - _warn_cache.get(cache_key, 0) < NO_TOKEN_WARN_MS:
            return
        _warn_cache[cache_key] = now
        add_log(msg, "warn")


# ---------- 游戏 API ----------

class ApiError(Exception):
    def __init__(self, code, message, status=0):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.status = status


_tls = threading.local()


def _get_conn():
    """线程局部 keep-alive 连接：TLS 握手一次复用（近期新连接握手常被卡 30s）"""
    import http.client
    from urllib.parse import urlparse
    c = getattr(_tls, "conn", None)
    if c is None:
        host = urlparse(BASE).hostname
        c = http.client.HTTPSConnection(host, timeout=20)
        _tls.conn = c
    return c


def api(method, path, token=None, body=None):
    import http.client
    headers = {"Accept": "application/json", "User-Agent": "Mozilla/5.0"}
    if token:
        headers["Authorization"] = "Bearer " + token
    payload = None
    data = json.dumps(body).encode() if body is not None else None
    if data is not None:
        headers["Content-Type"] = "application/json"
    last_err = None
    for attempt in (1, 2):
        c = _get_conn()
        try:
            c.request(method, path, body=data, headers=headers)
            r = c.getresponse()
            raw = r.read().decode()
            if r.status >= 300:
                try:
                    payload = json.loads(raw)
                except Exception:
                    raise ApiError("HTTP_ERROR", f"HTTP {r.status}", r.status)
                break
            payload = json.loads(raw)
            break
        except ApiError:
            raise
        except Exception as e:  # 连接坏/握手卡：丢弃重连重试一次
            last_err = e
            _tls.conn = None
            try:
                c.close()
            except Exception:
                pass
    if payload is None:
        raise ApiError("NETWORK", str(last_err))
    if payload.get("code") != "OK":
        raise ApiError(payload.get("code", "?"), payload.get("message", ""), payload.get("code") and 200 or 0)
    return payload.get("data")



_ERR_CN = {
    "MARKET_NOT_READY": "市场冷却中",
    "HOME_GARRISON_RENT_NOT_READY": "驻守租金未到时间",
    "HOME_GARRISON_RENT_VERSION_CONFLICT": "驻守状态已变化，稍后重试",
    "HERO_TRAINING_STATE_CONFLICT": "训练状态冲突",
    "TAVERN_CANDIDATE_PROTECTED": "保护期未开",
    "HOME_MINING_DAILY_LIMIT": "矿山次数已用完",
    "HOME_MINING_COOLDOWN": "矿山冷却中",
    "INVENTORY_FULL": "背包已满",
    "HERO_CAPACITY_FULL": "武将位已满",
    "HERO_BUSY": "武将正在执行其他任务",
    "ACCESS_DENIED": "无权执行",
    "SESSION_EXPIRED": "登录已过期",
    "SESSION_REPLACED": "会话被顶替",
    "NO_TOKEN": "缺少accessToken",
    "NETWORK": "网络异常",
    "HTTP_ERROR": "服务器异常",
}


def _cn(code):
    """错误码翻译为中文；未知码原样返回"""
    s = str(code or "")
    for k, v in _ERR_CN.items():
        if k in s:
            return v
    return s


def op_id():
    return str(uuid.uuid4())


# ---------- token ----------

def read_token():
    st = load("token", {})
    tok = st.get("token")
    if not tok or _now_ms() > st.get("expiresAt", 0):
        return None
    return tok


def report_token(token):
    save("token", {"token": token, "reportedAt": datetime.now(timezone.utc).isoformat(), "expiresAt": _now_ms() + 6 * 86400_000})


def with_session(fn):
    token = read_token()
    if not token:
        warn_once("noToken", "尚无 accessToken：请在手机游戏页面点一下书签上报（见面板顶部说明）")
        raise ApiError("NO_TOKEN", "尚无 accessToken")
    try:
        return fn(token)
    except ApiError as e:
        if e.code in ("SESSION_EXPIRED", "SESSION_REPLACED") or e.status == 401:
            save("token", {})
            act = load("activity", {})
            act["fingerprint"] = None
            save("activity", act)
            add_log("accessToken 已失效（手机端重新进过游戏？）——请重新点书签上报", "warn")
        raise


# ---------- 快照 ----------

_snap_last_write = 0.0


def _snap_fetch_all(token):
    """并行拉取快照全部子数据（原先串行 9 个请求需 5-20s，并行后约 2-3s）"""
    ex = ThreadPoolExecutor(max_workers=6)
    fut = {
        "tavern": ex.submit(lambda: api("GET", "/api/v1/tavern", token=token)),
        "tcities": ex.submit(lambda: api("GET", "/api/v1/territory/cities", token=token)),
        "mi": ex.submit(lambda: api("GET", "/api/v1/military-intelligence", token=token)),
        "heroes": ex.submit(lambda: api("GET", "/api/v1/heroes?limit=50", token=token)),
        "train": ex.submit(lambda: api("GET", "/api/v1/hero-training", token=token)),
    }
    ex.shutdown(wait=True)
    out = {}
    for k, f in fut.items():
        try:
            out[k] = f.result()
        except Exception:
            out[k] = None
    return out


def write_snapshot(token, home, force=False):
    global _snap_last_write
    D = _snap_fetch_all(token)

    hero_capacity = None
    t = D.get("tavern")
    if t:
        hero_capacity = {"capacity": t.get("heroCapacity"), "owned": t.get("ownedHeroCount"), "remaining": t.get("remainingHeroCapacity")}

    territory = None
    t = D.get("tcities")
    if t:
        territory = {"cities": len([c for c in (t.get("cities") or []) if c.get("controlledBySubject")]), "slots": t.get("territorySlots", 0)}

    resources = None
    mi = D.get("mi") or {}
    res_entries = [e for e in (mi.get("entries") or []) if e.get("targetKind") == "RESOURCE"]
    garrisoned = [e for e in res_entries if e.get("state") == "GARRISONED"]
    marching = [e for e in res_entries if e.get("state") != "GARRISONED"]
    # 按 state 分类（召回条目 action 仍是 OCCUPY，不能按 action 分）
    outbound = [e for e in marching if e.get("state") == "OUTBOUND"]
    returning = [e for e in marching if e.get("state") != "OUTBOUND"]
    slots = territory["slots"] if territory else 2
    nxt = min((_parse_ts(e.get("occurredAt")) + 8 * 3600 - time.time() for e in garrisoned), default=None)
    resources = {"occupied": len(garrisoned), "slots": slots,
                 "nextHarvestIn": (round(nxt) if nxt is not None else None),
                 "garrisons": [
                     {"hero": e.get("heroName"), "type": e.get("targetResourceType"),
                      "level": e.get("targetResourceLevel"), "nodeId": e.get("resourceNodeId"),
                      "heroId": e.get("heroInstanceId"),
                      "occupiedAt": e.get("occurredAt"),
                      "phase": ("占领中" if e.get("state") == "GARRISONED" else ("派遣中" if e.get("state") == "OUTBOUND" else "回城中")),
                      "endsAt": (datetime.fromtimestamp(_parse_ts(e.get("occurredAt")) + 8 * 3600, timezone.utc).isoformat() if e.get("state") == "GARRISONED" else e.get("arrivesAt"))}
                     for e in (garrisoned + outbound + returning)]}
    _tok = read_token()
    for _g in resources.get("garrisons", []):
        if _g.get("phase") == "占领中" and _g.get("nodeId"):
            _g["endsAt"] = (datetime.fromtimestamp(
                _parse_ts(_g["occupiedAt"]) + _node_hours(_tok, _g["nodeId"]) * 3600, timezone.utc).isoformat())

    snap = {
        "at": datetime.now(timezone.utc).isoformat(),
        "player": {k: home["player"].get(k) for k in ("displayName", "level", "combatPower", "provisionsCapacity")},
        "currencies": home["economy"]["currencies"],
        "mining": home.get("mining"),
        "heroCapacity": hero_capacity,
        "territory": territory,
        "resources": resources,
    }
    tr = D.get("train")
    if tr:
        hl = (D.get("heroes") or {}).get("heroes") or []
        lv = {h["heroInstanceId"]: h.get("level") for h in hl}
        snap["training"] = [
            {"hero": (s.get("session") or {}).get("heroName"),
             "level": lv.get((s.get("session") or {}).get("heroInstanceId")),
             "quality": next((h.get("quality") for h in hl if h["heroInstanceId"] == (s.get("session") or {}).get("heroInstanceId")), None),
             "plan": (s.get("session") or {}).get("planCode"),
             "endsAt": (s.get("session") or {}).get("endsAt")}
            for s in (tr.get("slots") or []) if s.get("session")]

    with LOCK:
        if not force and time.time() - _snap_last_write < SNAP_WRITE_THROTTLE_S:
            old = load("snapshot", {})
            changed = (json.dumps(old.get("resources"), sort_keys=True) != json.dumps(resources, sort_keys=True)
                       or json.dumps(old.get("training"), sort_keys=True) != json.dumps(snap.get("training"), sort_keys=True))
            if not changed:
                return
        _snap_last_write = time.time()
        save("snapshot", snap)


def refresh_snapshot(force=False):
    try:
        with_session(lambda tok: write_snapshot(tok, api("GET", "/api/v1/home", token=tok), force=force))
    except Exception:
        pass


# ---------- 活跃检测 ----------

def activity_fingerprint(home):
    def v(code):
        for c in home["economy"]["currencies"]:
            if c["code"] == code:
                return c.get("version", 0)
        return 0
    return "|".join(str(x) for x in [home["player"].get("progressVersion", 0), v("COPPER"), v("YUANBAO"), v("SILVER_TICKET")])


def track_activity(home):
    fp = activity_fingerprint(home)
    with LOCK:
        st = load("activity", {})
        prev = st.get("fingerprint")
        now = _now_ms()
        st["fingerprint"] = fp
        if prev is not None and prev != fp:
            if not st.get("lastSelfActionAt") or now - st["lastSelfActionAt"] > SELF_ACTION_GRACE_S * 1000:
                if not st.get("lastActiveAt") or now - st["lastActiveAt"] > ACTIVITY_TIMEOUT_S * 1000:
                    add_log("检测到玩家活跃，自动暂停消耗性任务", "warn")
                st["lastActiveAt"] = now
        st["active"] = bool(st.get("lastActiveAt")) and (now - st["lastActiveAt"] < ACTIVITY_TIMEOUT_S * 1000)
        save("activity", st)
        return st["active"]


def mark_self_action():
    with LOCK:
        st = load("activity", {})
        st["lastSelfActionAt"] = _now_ms()
        save("activity", st)


# ---------- 每日任务 ----------

def job_signin():
    results = []
    try:
        def do(token):
            s = api("GET", "/api/v1/login-rewards", token=token)
            day = next((d for d in s.get("days", []) if d["status"] in ("AVAILABLE", "CLAIMABLE")), None)
            if not day:
                results.append("7日签到: 今日已签")
            else:
                api("POST", "/api/v1/login-rewards/claims", token=token,
                    body={"operationId": op_id(), "day": day["day"], "cycleId": s["cycleId"], "expectedVersion": s["version"]})
                results.append(f"7日签到: 第{day['day']}天 ✓")
        with_session(do)
    except Exception as e:
        results.append(f"7日签到失败: {_cn(_cn(getattr(e, 'code', e)))}")
    try:
        def do2(token):
            s = api("GET", "/api/v1/monthly-login-rewards", token=token)
            if not any(d["status"] in ("AVAILABLE", "CLAIMABLE") for d in s.get("days", [])):
                results.append("月签到: 今日已签")
                return
            api("POST", "/api/v1/monthly-login-rewards/claims", token=token,
                body={"operationId": op_id(), "monthId": s["monthId"], "expectedVersion": s["version"], "mode": "ALL", "day": None})
            results.append("月签到: ✓")
        with_session(do2)
    except Exception as e:
        results.append(f"月签到失败: {_cn(_cn(getattr(e, 'code', e)))}")
    return results


def mine_once():
    try:
        with_session(lambda tok: api("POST", "/api/v1/home/mining-collections", token=tok, body={"operationId": op_id()}))
        return "OK"
    except ApiError as e:
        if e.code == "HOME_MINING_DAILY_LIMIT":
            return "DONE"
        if e.code == "HOME_MINING_COOLDOWN":
            return "COOLDOWN"
        raise


def _parse_ts(iso):
    try:
        return datetime.fromisoformat((iso or "").replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0.0


SOUL_COLORS = ["GREEN", "BLUE"]  # 直提魂品质（自家候选）


def _soul_daily():
    d = load("daily", {})
    if d.get("date") != datetime.now(TZ).strftime("%Y-%m-%d"):
        d = {"date": datetime.now(TZ).strftime("%Y-%m-%d"), "souls": {}}
    return d


def _add_souls(color, n):
    d = _soul_daily()
    souls = d.setdefault("souls", {})
    souls[color] = souls.get(color, 0) + n
    save("daily", d)


def _free_inv_slots(token, inv=None):
    if inv is None:
        try:
            inv = api("GET", "/api/v1/inventory", token=token)
        except Exception:
            return 99, {}
    iv = inv.get("inventory") or {}
    return int(iv.get("freeSlots") or 0), inv


def _do_synth(token, item_code, syn, inv_version):
    api("POST", "/api/v1/inventory/syntheses", token=token, body={
        "operationId": op_id(), "itemCode": item_code,
        "all": bool(syn.get("canSynthesizeAll")),
        "expectedRecipeVersion": str(syn.get("recipeVersion", "1")),
        "expectedInventoryVersion": str(inv_version)})


def ensure_inventory_space(token, need=1):
    """满包时按优先级释放格子：金刚石碎片/玄铁碎片合成(各10合1) > 绿魂10合1蓝。
    平时不动绿魂（保留是必要的）；返回释放的格子数。"""
    try:
        inv = api("GET", "/api/v1/inventory", token=token)
    except Exception:
        return 0
    iv = inv.get("inventory") or {}
    free = int(iv.get("freeSlots") or 0)
    if free >= need:
        return 0
    inv_version = str(iv.get("version", "0"))
    entries = inv.get("entries") or []
    released = 0
    # 优先级 1：碎片合成（金刚石/玄铁/绿将卡碎片，每种合成后叠并释放 1 格）
    frag_priority = ["ITEM_D711432EB8A94729B30F388CCEB56663",   # 玄铁碎片(描述确认)
                     "ITEM_725C7906C4BE474CA64355533CA6E95C"]    # 金刚石碎片(假设码,按synthesis.canSynthesize过滤)
    for e in entries:
        syn = e.get("synthesis") or {}
        if not (syn.get("canSynthesize") or syn.get("canSynthesizeAll")):
            continue
        code = e.get("code") or ""
        name = e.get("displayName") or ""
        is_frag = ("碎片" in name) and code != "ITEM_GREEN_HERO_SOUL"
        if not is_frag:
            continue
        try:
            _do_synth(token, code, syn, inv_version)
            released += 1
            add_log(f"背包满: 合成碎片 {name} 释放格子", "success")
            if free + released >= need:
                return released
        except Exception:
            continue
    # 优先级 2：绿魂 10 合 1 蓝（仅当碎片不够时）
    for e in entries:
        if e.get("code") != "ITEM_GREEN_HERO_SOUL":
            continue
        syn = e.get("synthesis") or {}
        if not (syn.get("canSynthesize") or syn.get("canSynthesizeAll")):
            continue
        try:
            _blue_before = sum(int(x.get("quantity", 0)) for x in entries if x.get("code") == "ITEM_BLUE_HERO_SOUL")
            _do_synth(token, "ITEM_GREEN_HERO_SOUL", syn, inv_version)
            inv2 = api("GET", "/api/v1/inventory", token=token)
            _blue_after = sum(int(x.get("quantity", 0)) for x in inv2.get("entries", []) if x.get("code") == "ITEM_BLUE_HERO_SOUL")
            made = max(0, _blue_after - _blue_before)
            if made:
                _add_souls("BLUE", made)
            released += 1
            add_log(f"背包满: 绿魂合成 +{made}蓝魂 释放格子（不得已）", "warn")
        except Exception:
            pass
        break
    return released


def job_soul_factory(token):
    """自家酒馆（不限时段）：蓝将直提魂；紫+有空位则招募保留；绿/白留给别人招赚分成。"""
    out = []
    if load("soulFactory", False) is not True:
        return out
    t = api("GET", "/api/v1/tavern", token=token)
    for c in t.get("candidates") or []:
        q = c.get("quality")
        if q == "BLUE":
            if not c.get("soulExtractionAvailable"):
                continue
            for _retry in range(2):
                try:
                    api("POST", "/api/v1/tavern/soul-extractions", token=token, body={
                        "operationId": op_id(), "candidateId": c["candidateId"],
                        "expectedCandidateVersion": c.get("version", 0)})
                    n = 0
                    for it in (c.get("soulOutcomes") or []):
                        try:
                            n += int(it.get("quantity", 1))
                        except Exception:
                            n += 1
                    n = n or 1
                    _add_souls("BLUE", n)
                    out.append(f"提魂: {c['name']}(蓝{c['star']}星) +{n}")
                    break
                except Exception as e:
                    code = getattr(e, "code", "")
                    if "INVENTORY_FULL" in str(code) and _retry == 0:
                        ensure_inventory_space(token, need=1)
                        continue
                    out.append(f"提魂失败({c['name']}): {code}")
                    break
        elif q in ("PURPLE", "ORANGE"):
            cap = (load("snapshot", {}) or {}).get("heroCapacity") or {}
            free = (cap.get("capacity", 0) - cap.get("owned", 0)) if cap else 0
            if free < 1:
                continue
            if not c.get("recruitmentAvailable"):
                continue
            try:
                api("POST", "/api/v1/tavern/recruitments", token=token, body={
                    "operationId": op_id(), "candidateId": c["candidateId"],
                    "expectedCandidateVersion": c.get("version", 0)})
                out.append(f"招募: {c['name']}({q}{c['star']}星)")
            except Exception as e:
                out.append(f"招募失败({c['name']}): {_cn(_cn(getattr(e, 'code', e)))}")
    return out


SOUL_SCAN_BATCH = 85          # 每段玩家数（~2 分钟）
SOUL_SCAN_MIN_LEVEL = 10      # 可被招募的最低玩家等级（用户确认）


def _player_by_sid(token, sid, pcache):
    if sid in pcache:
        return pcache[sid]
    try:
        s = api("GET", f"/api/v1/player-search?type=SHORT_ID&query={sid}", token=token)
        p0 = (s.get("players") or [None])[0]
        if p0:
            pcache[sid] = {"playerId": p0["playerId"], "shortId": sid, "level": p0.get("level")}
            return pcache[sid]
    except Exception:
        pass
    pcache[sid] = None
    return None


SOUL_DAILY_GREEN_CAP = 20      # 每日绿魂上限（魂数，非武将数）


def job_soul_scan():
    """一段遍历：仅1星绿将招+提魂；每日20绿魂上限（0点重置）；全天运行，游标续扫"""
    if load("soulFactory", False) is not True:
        return None
    souls_today = (_soul_daily().get("souls") or {}).get("GREEN", 0)
    if souls_today >= SOUL_DAILY_GREEN_CAP:
        # 只在「刚达到上限」（上次还不到）时提示一次，后续段直接静默跳过
        if load("soulCapNotified", False) is not True:
            add_log(f"今日绿魂已达上限 {SOUL_DAILY_GREEN_CAP}，遍历暂停（重置后恢复）", "warn")
            save("soulCapNotified", True)
        return None
    tok = read_token()
    if not tok:
        return None
    try:
        home = api("GET", "/api/v1/home", token=tok)
        cur = {c["code"]: c for c in home["economy"]["currencies"]}
        copper = cur.get("COPPER", {}).get("balance", 0)
        cap = (load("snapshot", {}) or {}).get("heroCapacity") or {}
        free = (cap.get("capacity", 0) - cap.get("owned", 0)) if cap else 0
    except Exception as e:
        add_log(f"提魂遍历前置失败: {_cn(_cn(getattr(e, 'code', e)))}", "error")
        return None
    if copper < 5000:
        return "铜钱不足5000，跳过"
    if free < 1 and False:
        pass  # 空位由招→提即时循环，不强制预检（招募满员会被服务器拒）
    st = load("soulScan", {"cursor": 100000, "max": 101100})
    cursor, mx = st.get("cursor", 100000), st.get("max", 101100)
    pcache = load("sidCache", {})
    visited, found, grabbed = 0, 0, 0
    results = []
    sid = cursor
    while sid <= mx and visited < SOUL_SCAN_BATCH:
        info = _player_by_sid(tok, str(sid), pcache)
        sid += 1
        if not info or (info.get("level") or 0) < SOUL_SCAN_MIN_LEVEL:
            continue
        visited += 1
        try:
            t = api("GET", f"/api/v1/friend-cities/{info['playerId']}/tavern", token=tok)
        except Exception:
            continue
        cand = next((c for c in (t.get("candidates") or []) if c.get("quality") == "GREEN" and c.get("star") == 1 and c.get("recruitmentAvailable")), None)
        if not cand:
            continue
        found += 1
        # 招募 → 提魂（满员则跳过该家）
        try:
            r = api("POST", f"/api/v1/friend-cities/{info['playerId']}/tavern/recruitments", token=tok, body={
                "operationId": op_id(), "candidateId": cand["candidateId"],
                "expectedCandidateVersion": cand.get("version", 0)})
            hid = r.get("heroInstanceId")
            if not hid:
                continue
            hl = api("GET", "/api/v1/heroes?limit=50", token=tok).get("heroes") or []
            h = next((x for x in hl if x["heroInstanceId"] == hid), None)
            if not h:
                continue
            sr = None
            for _retry in range(2):
                try:
                    sr = api("POST", f"/api/v1/heroes/{hid}/soul-extractions", token=tok, body={
                        "operationId": op_id(), "expectedHeroVersion": str(h.get("version", "0"))})
                    break
                except Exception as _ie:
                    if "INVENTORY_FULL" in str(getattr(_ie, "code", "")) and _retry == 0:
                        ensure_inventory_space(tok, need=1)
                        continue
                    raise
            grabbed += 1
            try:
                copper -= int(r.get("copperCost") or 1700)
            except Exception:
                copper -= 1700
            if copper < 5000:
                results.append("铜钱不足5000，停止本段")
                break
            n = 1
            try:
                n = int(sr.get("quantity") or 1)
            except Exception:
                pass
            _add_souls("GREEN", n)
            results.append(f"{cand['name']}({cand['star']}星)+{n}魂")
            if (_soul_daily().get("souls") or {}).get("GREEN", 0) >= SOUL_DAILY_GREEN_CAP:
                results.append(f"达上限{SOUL_DAILY_GREEN_CAP}，停止")
                save("soulCapNotified", True)
                add_log(f"今日绿魂已达上限 {SOUL_DAILY_GREEN_CAP}（段内触发），遍历暂停", "warn")
                break
        except Exception as e:
            code = getattr(e, "code", "")
            if code in ("HERO_CAPACITY_FULL", "CAPACITY_FULL"):
                results.append("空位不足，停止本段")
                break
            continue
    save("sidCache", pcache)
    # 游标推进（含空号）；发现更大的 shortId 自动扩界
    big = max([int(v["shortId"]) for v in pcache.values() if v] + [mx])
    st = {"cursor": (sid if sid <= mx else 100000), "max": max(mx, big + 20)}
    save("soulScan", st)
    msg = f"提魂遍历: 检查{visited}家, 绿将{found}, 招+提{grabbed}" + (f"({','.join(results)})" if results else "")
    if grabbed:
        add_log(msg, "success")
        threading.Thread(target=refresh_snapshot, kwargs={"force": True}, daemon=True).start()
    return msg


def check_tavern_refresh():
    """自家酒馆刷新到点触发将魂工厂（nextFreeRefreshAt 进入 90s 窗口）"""
    if load("soulFactory", False) is not True:
        return
    try:
        t = with_session(lambda tok: api("GET", "/api/v1/tavern", token=tok))
    except Exception:
        return
    key = "tavern-refresh"
    th = _res_timers.get(key)
    if th and th.is_alive():
        return
    wait = _parse_ts(t.get("nextFreeRefreshAt")) + 3 - time.time()
    if wait > 90 or wait < -60:
        return

    def fire(w=wait):
        time.sleep(max(0, w))
        try:
            tok = read_token()
            r = job_soul_factory(tok)
            if r:
                add_log("酒馆刷新触发: " + "; ".join(r), "success")
                threading.Thread(target=refresh_snapshot, kwargs={"force": True}, daemon=True).start()
        except Exception as e:
            add_log("酒馆刷新触发失败: " + str(getattr(e, "code", e)), "error")
    th = threading.Thread(target=fire, daemon=True)
    _res_timers[key] = th
    th.start()


QUALITY_RANK = {"ORANGE": 5, "PURPLE": 4, "BLUE": 3, "GREEN": 2, "WHITE": 1}


TRAIN_LOCK = threading.Lock()  # 整点任务与到点触发线程互斥：领取+重排必须串行，否则并发 start 撞 HERO_TRAINING_STATE_CONFLICT


def job_training(token):
    """领取完成训练；空闲槽选稀有度最高可用武将；时长=不溢出(discarded=0)的最长档，
    全溢出选浪费最小档；铜钱不足再降档。经验在开始时即入账。（全局锁串行）"""
    with TRAIN_LOCK:
        _r = _job_training_locked(token)
    threading.Thread(target=refresh_snapshot, kwargs={"force": True}, daemon=True).start()
    return _r


def _job_training_locked(token):
    out = []
    d = api("GET", "/api/v1/hero-training", token=token)
    claimed = False
    for s in d.get("slots") or []:
        sess = s.get("session")
        if not sess or _parse_ts(sess.get("endsAt")) > time.time():
            continue
        try:
            api("POST", "/api/v1/hero-training/slots/" + str(s["slotNumber"]) + "/claims", token=token,
                body={"operationId": op_id(), "expectedSlotVersion": str(s.get("version"))})
            claimed = True
            out.append("领取训练: " + str(sess.get("heroName")) + " (" + str(sess.get("planCode")) + ")")
        except Exception as e:
            out.append("领取训练失败(slot" + str(s["slotNumber"]) + "): " + str(getattr(e, "code", e)))
    if claimed:
        d = api("GET", "/api/v1/hero-training", token=token)

    plans = {p["planCode"]: p for p in (d.get("plans") or []) if p.get("available")}
    cands = sorted(
        [c for c in (d.get("candidates") or [])
         if c.get("available") and c.get("level", 0) < c.get("maximumLevel", 999)
         and c.get("quality") in ("PURPLE", "ORANGE")],
        key=lambda c: (-QUALITY_RANK.get(c.get("quality"), 0), -(c.get("star") or 0), c.get("level", 0)))
    # 为每个武将计算最优档位（含溢出预览），构建有序队列
    _cand_plans = []
    for c in cands:
        previews = {pv.get("planCode"): int(pv.get("discardedExperience", 0)) for pv in (c.get("experiencePreviews") or [])}
        order = sorted(plans.values(), key=lambda x: -x.get("durationSeconds", 0))
        zero = [pl for pl in order if previews.get(pl["planCode"], 0) == 0]
        pool = zero if zero else sorted(order, key=lambda pl: previews.get(pl["planCode"], 0))
        best = pool[0] if pool else None
        _cand_plans.append({"hero": c, "best": best, "bestCode": best["planCode"] if best else None})
    # 优先选择最优档不是 4h 的武将；全是 4h 时按排序依次选
    if not cands:
        if not out:
            out.append("训练: 无可训武将(全部训练中或满级)")
        return out
    copper = None
    try:
        cur = api("GET", "/api/v1/home", token=token)["economy"]["currencies"]
        copper = next(c["balance"] for c in cur if c["code"] == "COPPER")
    except Exception:
        pass
    _used = set()
    for s in d.get("slots") or []:
        if s.get("session") or not s.get("unlocked"):
            continue
        # 优先取非 4h 最优的；全 4h 时按原排序取
        h_entry = next((x for x in _cand_plans if id(x) not in _used and x["bestCode"] != "BASIC_4H"), None)
        if h_entry is None:
            h_entry = next((x for x in _cand_plans if id(x) not in _used), None)
        if h_entry is None:
            break
        _used.add(id(h_entry))
        h = h_entry["hero"]
        # 服务器 discardedExperience 已按"经验沿等级结转、满级截断浪费"算好：
        # 选零浪费的最长档（22h→8h→4h）；全溢出(近满级)取浪费最小；铜钱不够再降档
        previews = {pv.get("planCode"): int(pv.get("discardedExperience", 0)) for pv in (h.get("experiencePreviews") or [])}
        order = sorted(plans.values(), key=lambda x: -x.get("durationSeconds", 0))
        zero = [pl for pl in order if previews.get(pl["planCode"], 0) == 0]
        pool = zero if zero else sorted(order, key=lambda pl: previews.get(pl["planCode"], 0))
        affordable = [pl for pl in pool if copper is None or copper >= pl["copperCost"]]
        if affordable:
            pool = affordable
        if not pool:
            continue
        pl = pool[0]
        try:
            api("POST", "/api/v1/hero-training/starts", token=token, body={
                "operationId": op_id(), "slotNumber": s["slotNumber"],
                "expectedSlotVersion": str(s.get("version")),
                "heroInstanceId": h["heroInstanceId"], "expectedHeroVersion": str(h.get("version", "0")),
                "planCode": pl["planCode"], "useExperienceBonus": False})
            if copper is not None:
                copper -= pl["copperCost"]
            note = ""
            waste = previews.get(pl["planCode"], 0)
            if waste > 0:
                note = " (溢出浪费" + str(waste) + ")"
            out.append("开始训练: " + h["name"] + "(" + h["quality"] + str(h["star"]) + "星 Lv" + str(h.get("level")) + ") "
                       + pl.get("displayName", pl["planCode"]) + note)
        except Exception as e:
            out.append("开始训练失败(" + h["name"] + "): " + str(getattr(e, "code", e)))
    if not out:
        out.append("训练: 全部进行中")
    return out


def job_territory_income(token):
    """领地城市收益：驻守铜钱 + 市场税款（挖矿）分别领取"""
    out = []
    try:
        t = api("GET", "/api/v1/territory/cities", token=token)
        got = tax = 0
        for c in (t.get("cities") or []):
            if not c.get("controlledBySubject"):
                continue
            try:
                detail = api("GET", "/api/v1/cities/" + c["ownerPlayerId"], token=token)
                oid = detail.get("occupationId")
                if not oid:
                    continue
                inc = api("GET", "/api/v1/city-occupations/" + oid + "/income", token=token)
                # 驻守铜钱（正确子路径 garrison-income/collections）
                g = inc.get("garrison") or {}
                if g.get("availableCopper", 0) > 0 and (g.get("status") == "READY" or _parse_ts(g.get("readyAt")) <= time.time()):
                    api("POST", "/api/v1/city-occupations/" + oid + "/garrison-income/collections", token=token,
                        body={"operationId": op_id(), "expectedIncomeVersion": inc.get("incomeVersion", "0")})
                    got += 1
                # 市场税款（占领城市的挖矿收益）
                mt = inc.get("marketTax") or {}
                if mt.get("status") == "READY" and mt.get("availableCopper", 0) > 0:
                    api("POST", "/api/v1/city-occupations/" + oid + "/market-tax/collections", token=token,
                        body={"operationId": op_id(), "expectedIncomeVersion": inc.get("incomeVersion", "0")})
                    tax += 1
            except Exception:
                pass
        # 挖矿（占领城市的 mine-visits，每日限次）
        mine_rewards = []
        for c in (t.get("cities") or []):
            if not c.get("controlledBySubject"):
                continue
            try:
                r = api("POST", "/api/v1/friend-interactions/mine-visits", token=token,
                        body={"operationId": op_id(), "targetPlayerId": c["ownerPlayerId"]})
                qty = r.get("rewardQuantity") or 0
                if qty:
                    mine_rewards.append(f"{r.get('rewardCode','?')}×{qty}")
            except Exception:
                pass  # 次数用完静默
        parts = []
        if got: parts.append("驻守" + str(got) + "座")
        if tax: parts.append("税款" + str(tax) + "座")
        if mine_rewards:
            parts.append("挖矿(" + ",".join(mine_rewards) + ")")
        out.insert(0, "领地: " + " ".join(parts) if parts else "领地: 全部未到时间")
    except Exception as e:
        out.append("领地铜钱失败: " + str(getattr(e, "code", e)))
    return out


def job_resource_harvest(token):
    """占领资源点：占领超 8h 收获"""
    out = []
    try:
        d = api("GET", "/api/v1/resource-occupations", token=token)
        got, waiting = 0, 0
        for o in (d.get("occupations") or []):
            if time.time() - _parse_ts(o.get("occupiedAt")) < 8 * 3600:
                waiting += 1
                continue
            try:
                api("POST", "/api/v1/resource-occupations/" + o["occupationId"] + "/harvests", token=token,
                    body={"operationId": op_id(), "expectedVersion": str(o.get("occupationVersion", "0")), "heroInstanceId": None})
                got += 1
            except Exception:
                pass
        out.append(("资源点收获: " + str(got) + "个") if got else ("资源点收获: 未到8h (" + str(waiting) + "个占领中)"))
    except Exception as e:
        out.append("资源点收获失败: " + str(getattr(e, "code", e)))
    return out


def job_hourly(active=False):
    out = []
    try:
        def do(token):
            home = api("GET", "/api/v1/home", token=token)
            cur = {c["code"]: c for c in home["economy"]["currencies"]}
            prov = cur.get("PROVISIONS", {}).get("balance", 0)
            copper = cur.get("COPPER", {}).get("balance", 0)
            prov_cap = home["player"].get("provisionsCapacity", 22)
            # 防溢出最小兑换 y = max(x+13-m, 0)（玩家活跃不再暂停，保留余粮充足）
            budget = max(prov + 13 - prov_cap, 0)
            plan = {}
            for t in EXCHANGE_TIERS:
                while budget >= t:
                    plan[t] = plan.get(t, 0) + 1
                    budget -= t
            tickets = sum(t * n for t, n in plan.items())
            copper_need = tickets * 100
            if tickets > 0 and copper >= copper_need:
                for t, n in plan.items():
                    api("POST", "/api/v1/home/market/exchanges", token=token,
                        body={"operationId": op_id(), "offerId": f"MARKET_EXCHANGE_{t}", "quantity": n})
                out.append(f"兑换 {tickets} 银票 (-{copper_need}铜 -{tickets}粮草)")
            elif tickets > 0:
                out.append(f"兑换跳过: 需{copper_need}铜 仅有{copper}")
            else:
                out.append(f"兑换跳过: 粮草 {prov}/{prov_cap} 下一小时不会溢出")

            market = api("GET", "/api/v1/home/market", token=token)
            if market.get("collectionStatus") == "READY":
                r = api("POST", "/api/v1/home/market/collections", token=token,
                        body={"operationId": op_id(), "expectedVersion": market["version"]})
                out.append(f"征收 +{r.get('collectedCopper')} 铜")
            else:
                out.append("征收: " + ("冷却中" if market.get("collectionStatus") == "COOLDOWN" else str(market.get("collectionStatus"))))

            occ = home.get("occupation") or {}
            if occ.get("status") == "GARRISONED" or (occ.get("rent") or {}).get("availableCopper", 0) > 0:
                api("POST", "/api/v1/home/garrison/rent-collections", token=token,
                    body={"operationId": op_id(), "expectedVersion": occ["version"]})
                out.append("收租 ✓")
            else:
                out.append("收租: 未驻守或无可收")

            out.extend(job_territory_income(token))
            try:
                out.extend(job_training(token))
            except Exception as e:
                out.append(f"训练检查失败: {_cn(getattr(e, 'code', e))}")
            try:
                out.extend(job_soul_factory(token))
            except Exception as e:
                out.append(f"提魂异常: {_cn(_cn(getattr(e, 'code', e)))}")
            # 资源点收获与训练已由独立到点计时器处理（check_resource_timers/check_training_timers），
            # 进程重启后下一分钟 tick 也会补收，不再放整点任务（避免与触发线程并发冲突）

            write_snapshot(token, home, force=True)
        with_session(do)
        mark_self_action()
    except Exception as e:
        out.append(f"失败: {_cn(_cn(getattr(e, 'code', e)))}")
    return out


# ---------- 紫将监控与抢购 ----------

def parse_appearance(text):
    """解析公告，支持一条公告包含多个武将（如'出现了4星橙将【林冲】、4星紫将【扈三娘】'）
    返回 owner 固定 + 第一个武将信息（向后兼容单武将调用方）
    多武将场景用 parse_appearance_all"""
    results = parse_appearance_all(text)
    return results[0] if results else None


def parse_appearance_all(text):
    import re
    results = []
    m = re.search(r"【酒馆消息】(.+?)的酒馆出现了", text or "")
    if not m:
        return results
    owner = m.group(1)
    for hm in re.finditer(r"(\d+)星(紫|橙)将【(.+?)】", text or ""):
        results.append({"owner": owner, "star": int(hm.group(1)), "qualityName": hm.group(2), "hero": hm.group(3)})
    return results


_notices = []
_notice_seq = [0]


def notify(msg):
    """面板 toast 通知（status 轮询携带，前端弹提示；60 秒时效自动消失）"""
    _notice_seq[0] += 1
    _notices.append({"id": _notice_seq[0], "msg": msg, "at": time.time()})
    del _notices[:-10]


def _live_notices():
    return [n for n in _notices if time.time() - n["at"] < 60]


def _note_known_hero(name, quality, star=0):
    """酒馆监控见到紫/橙将时记入名单（记录见过的最高星级）"""
    if quality not in ("PURPLE", "ORANGE") or not name:
        return
    with LOCK:
        kn = load("knownHeroes", {})
        if isinstance(kn.get(quality), list):  # 旧数组格式 → 转对象
            kn[quality] = {n: 0 for n in kn[quality]}
        grp = kn.setdefault(quality, {})
        if name not in grp:
            grp[name] = int(star or 0)
            add_log(f"关注名单+{'橙' if quality == 'ORANGE' else '紫'}将 {name}({star or '?'}星)", "info")
        elif int(star or 0) > int(grp[name] or 0):
            grp[name] = int(star)
        save("knownHeroes", kn)


def _known_purple_orange():
    """名单唯一来源：knownHeroes.json（_note_known_hero 见到即写入，记录最高星级）"""
    kn = load("knownHeroes", {})
    out = {}
    for q in ("PURPLE", "ORANGE"):
        grp = kn.get(q)
        if isinstance(grp, list):  # 旧数组格式兼容
            items = [{"name": n, "star": 0} for n in grp if isinstance(n, str)]
        else:
            items = [{"name": n, "star": int(s or 0)} for n, s in (grp or {}).items() if isinstance(n, str)]
        items.sort(key=lambda x: x["name"])
        out[q] = items
    return out


def _cap_full():
    cap = (load("snapshot", {}) or {}).get("heroCapacity") or {}
    return bool(cap) and cap.get("capacity", 0) > 0 and cap.get("owned", 0) >= cap.get("capacity", 0)


def job_purple_scan():
    found = []
    auto_reserve = load("autoReserve", True) is not False

    def do(token):
        ann = api("GET", "/api/v1/home-announcements", token=token)
        appearances = []
        for e in ann.get("entries") or []:
            for pp in parse_appearance_all(e.get("content", "")):
                pp["at"] = e.get("startsAt")
                _note_known_hero(pp["hero"], "ORANGE" if pp.get("qualityName") == "橙" else "PURPLE", pp.get("star") or 0)
                appearances.append(pp)
        with LOCK:
            pcache = load("playerCache", {})
            heroes = load("purpleHeroes", {})

        # --- 阶段1：并行补齐缺失的玩家搜索 ---
        missing = [a["owner"] for a in appearances if a["owner"] not in pcache or not pcache[a["owner"]].get("shortId")]
        missing = list(dict.fromkeys(missing))
        if missing:
            ex = ThreadPoolExecutor(max_workers=6)
            futs = {o: ex.submit(lambda o=o: api("GET", "/api/v1/player-search?type=NAME&query=" + urllib_parse.quote(o), token=token)) for o in missing}
            ex.shutdown(wait=True)
            for o, f in futs.items():
                try:
                    p0 = (f.result().get("players") or [None])[0]
                    if p0:
                        pcache[o] = {"playerId": p0["playerId"], "shortId": p0.get("shortId"), "level": p0.get("level")}
                except Exception:
                    pass

        # --- 阶段2：并行拉公告涉及 + 需复核的酒馆 ---
        want = {}  # pid -> list of ctx
        gm = load("graveyard", {})
        gm_fresh = {k: v for k, v in gm.items() if time.time() - _parse_ts(v) < 35 * 60}
        if gm != gm_fresh:
            save("graveyard", gm_fresh)
        for a in appearances:
            info = pcache.get(a["owner"])
            if not info:
                continue
            pid = info["playerId"]
            key = f"{pid}:{a['hero']}"
            want.setdefault(pid, []).append({"kind": "announce", "key": key, "a": a, "info": info})
        now = time.time()
        for key in list(heroes.keys()):
            h = heroes[key]
            if h.get("status") == "GONE" and now - _parse_ts(h.get("goneAt")) > GONE_TTL_S:
                gm_fresh[key] = h.get("foundAt") or h.get("goneAt")
                del heroes[key]
                continue
            if h.get("status") == "GRABBED" and now - _parse_ts(h.get("grabbedAt")) > GRABBED_TTL_S:
                del heroes[key]
                continue
            if h.get("status") != "ALIVE":
                continue
            # 复核范围：保护期临近结束（<15min）或较久未见（>10min）
            pe_left = _parse_ts(h.get("protectionEndsAt")) - now
            if pe_left > 15 * 60 and now - _parse_ts(h.get("lastSeenAt")) < 10 * 60:
                continue
            want.setdefault(h["playerId"], []).append({"kind": "recheck", "key": key})
        save("graveyard", gm_fresh)

        pids = list(want.keys())
        taverns = {}
        if pids:
            ex = ThreadPoolExecutor(max_workers=6)
            futs = {pid: ex.submit(lambda pid=pid: api("GET", f"/api/v1/friend-cities/{pid}/tavern", token=token)) for pid in pids}
            ex.shutdown(wait=True)
            for pid, f in futs.items():
                try:
                    taverns[pid] = f.result()
                except Exception:
                    taverns[pid] = None

        # --- 阶段3：串行应用结果 ---
        for pid, ctxs in want.items():
            t = taverns.get(pid)
            if t is None:
                continue
            for ctx in ctxs:
                key = ctx["key"]
                if ctx["kind"] == "announce":
                    a = ctx["a"]
                    info = ctx["info"]
                    if heroes.get(key, {}).get("status") == "GRABBED":
                        continue
                    cand = next((c for c in (t.get("candidates") or []) if c["name"] == a["hero"] and c.get("quality") in PURPLE_PLUS), None)
                    if not cand and key not in heroes and key not in gm_fresh:
                        heroes[key] = {
                            "key": key, "playerId": pid, "owner": a["owner"],
                            "ownerLevel": info.get("level"), "shortId": info.get("shortId"),
                            "hero": a["hero"], "quality": ("ORANGE" if a.get("qualityName") == "橙" else "PURPLE"),
                            "star": a.get("star", 0), "troopType": None,
                            "copperCost": None, "silverTicketCost": None,
                            "foundAt": a["at"], "protectionEndsAt": None,
                            "lastSeenAt": datetime.now(TZ).isoformat(),
                            "status": "GONE", "goneAt": datetime.now(TZ).isoformat()}
                    elif cand:
                        is_new = key not in heroes or heroes[key].get("status") != "ALIVE"
                        heroes[key] = {
                            **heroes.get(key, {}),
                            "key": key, "playerId": pid, "owner": a["owner"],
                            "ownerLevel": info.get("level"), "shortId": info.get("shortId"),
                            "hero": a["hero"], "quality": cand["quality"], "star": cand["star"],
                            "troopType": cand.get("troopType"),
                            "copperCost": cand.get("copperCost"), "silverTicketCost": cand.get("silverTicketCost", 0),
                            "candidateId": cand["candidateId"], "candidateVersion": cand.get("version", 0),
                            "foundAt": a["at"], "protectionEndsAt": t.get("protectionEndsAt"),
                            "lastSeenAt": datetime.now(TZ).isoformat(), "status": "ALIVE"}
                        if is_new:
                            label = f"@{a['owner']} {a['hero']}({cand['quality']}{cand['star']}星)"
                            found.append(label)
                            if _cap_full():
                                warn_once("capFull", "自动预约时武将位已满，照常预约（到期前需腾位）")
                                notify("武将位已满，自动预约的目标到期前需腾位")
                            _sc_set = {(p["star"], p["hero"]) for p in load("reserveScope", {"pairs": []}).get("pairs", [])}
                            if auto_reserve and ((cand["star"] or 0), cand["name"]) in _sc_set:
                                heroes[key]["reserved"] = True
                                heroes[key]["reservedAt"] = datetime.now(TZ).isoformat()
                                add_log(f"⭐ 高价值目标自动预约: {label}", "success")
                    elif heroes.get(key, {}).get("status") == "ALIVE":
                        heroes[key]["status"] = "GONE"
                        heroes[key]["goneAt"] = datetime.now(TZ).isoformat()
                else:  # recheck
                    h = heroes.get(key)
                    if not h or h.get("status") != "ALIVE":
                        continue
                    cand = next((c for c in (t.get("candidates") or []) if c.get("candidateId") == h.get("candidateId")), None)
                    if not cand:
                        h["status"] = "GONE"
                        h["goneAt"] = datetime.now(TZ).isoformat()
                    else:
                        h["candidateVersion"] = cand.get("version", 0)
                        h["protectionEndsAt"] = t.get("protectionEndsAt")
                        h["lastSeenAt"] = datetime.now(TZ).isoformat()

        save("playerCache", pcache)
        save("purpleHeroes", heroes)

    try:
        with_session(do)
    except ApiError as e:
        if e.code != "NO_TOKEN":
            add_log(f"紫将扫描失败: {e.code}", "error")
    except Exception as e:
        add_log(f"紫将扫描异常: {e}", "error")
    return found


def grab_hero(key, manual=False):
    with LOCK:
        heroes = load("purpleHeroes", {})
    h = heroes.get(key)
    if not h:
        return {"ok": False, "msg": "目标不存在"}
    if h.get("status") == "GRABBED":
        return {"ok": False, "msg": "已抢购成功"}

    # 快照粗筛 + 实时校验容量
    snap_cap = (load("snapshot", {}) or {}).get("heroCapacity") or {}
    clearly_open = snap_cap and snap_cap.get("capacity", 0) > 0 and snap_cap.get("owned", 0) < snap_cap.get("capacity", 0)
    if not clearly_open:
        try:
            def capcheck(token):
                t = api("GET", "/api/v1/tavern", token=token)
                return t.get("ownedHeroCount", 0) >= t.get("heroCapacity", 0)
            if with_session(capcheck):
                msg = "武将位已满，请先解雇或提取武魂腾出位置"
                if not manual:
                    warn_once("capFull", "抢购跳过: " + msg)
                return {"ok": False, "msg": msg}
        except Exception:
            pass

    def do(token):
        # 快路径：直接 POST；失败回退刷新
        try:
            r0 = api("POST", f"/api/v1/friend-cities/{h['playerId']}/tavern/recruitments", token=token,
                body={"operationId": op_id(), "candidateId": h["candidateId"], "expectedCandidateVersion": h.get("candidateVersion", 0)})
            if isinstance(r0, dict):
                h["_paidCopper"] = r0.get("copperCost")
                h["_paidTicket"] = r0.get("silverTicketCost")
        except ApiError:
            t = api("GET", f"/api/v1/friend-cities/{h['playerId']}/tavern", token=token)
            cand = next((c for c in t.get("candidates", []) if c["name"] == h["hero"] and c["quality"] == h.get("quality")), None)
            if not cand:
                # 网络掩盖检查：近 5 分钟获得的同名武将 = 实际成功
                try:
                    mine = api("GET", "/api/v1/heroes?limit=50", token=token)
                    got = next((x for x in mine.get("heroes", [])
                                if x["name"] == h["hero"] and x.get("obtainedAt")
                                and time.time() - _parse_ts(x["obtainedAt"]) < 300), None)
                    if got:
                        h["status"] = "GRABBED"
                        h["grabbedAt"] = got["obtainedAt"]
                        raise _Grabbed()
                except _Grabbed:
                    raise
                except Exception:
                    pass
                raise ApiError("GONE", "武将已不在卡池")
            h["candidateId"] = cand["candidateId"]
            h["candidateVersion"] = cand.get("version", 0)
            api("POST", f"/api/v1/friend-cities/{h['playerId']}/tavern/recruitments", token=token,
                body={"operationId": op_id(), "candidateId": h["candidateId"], "expectedCandidateVersion": h["candidateVersion"]})
        h["status"] = "GRABBED"
        h["grabbedAt"] = datetime.now(timezone.utc).isoformat()
        raise _Grabbed()

    class _Grabbed(Exception):
        pass

    try:
        with_session(do)
    except _Grabbed:
        with LOCK:
            heroes = load("purpleHeroes", {})
            if key in heroes:
                upd = {"status": "GRABBED", "grabbedAt": h.get("grabbedAt") or datetime.now(timezone.utc).isoformat()}
                if h.get("_paidCopper") is not None:
                    upd["paidCopper"] = h["_paidCopper"]
                    upd["paidTicket"] = h.get("_paidTicket") or 0
                heroes[key].update(upd)
                save("purpleHeroes", heroes)
        mark_self_action()
        # 日志由调用方统一记录
        threading.Thread(target=refresh_snapshot, kwargs={"force": True}, daemon=True).start()
        return {"ok": True, "msg": f"已抢到 {h['hero']}"}
    except ApiError as e:
        if e.code == "GONE":
            with LOCK:
                heroes = load("purpleHeroes", {})
                if key in heroes:
                    heroes[key]["status"] = "GONE"
                    heroes[key]["goneAt"] = datetime.now(timezone.utc).isoformat()
                    save("purpleHeroes", heroes)
            add_log(f"售罄: {h['hero']} 已被别人抢先", "warn")
            return {"ok": False, "msg": "武将已不在卡池（售罄）", "gone": True}
        if "PROTECT" in (e.code or "").upper():
            # 拉最新保护期：>5s 重排，<=5s 连发
            try:
                def getpe(token):
                    return api("GET", f"/api/v1/friend-cities/{h['playerId']}/tavern", token=token).get("protectionEndsAt")
                pe = with_session(getpe)
                if pe and _parse_ts(pe) - time.time() > 5:
                    changed = pe != h.get("protectionEndsAt")
                    with LOCK:
                        heroes = load("purpleHeroes", {})
                        if key in heroes:
                            heroes[key]["protectionEndsAt"] = pe
                            save("purpleHeroes", heroes)
                    _pe_bj = datetime.fromisoformat((pe or "").replace("Z", "+00:00")).astimezone(TZ).strftime("%H:%M:%S")
                    add_log(f"{h['hero']} " + (f"卡池已刷新，保护期更新至 {_pe_bj}，自动重新蹲点" if changed
                                              else f"保护期尚未结束（{_pe_bj} 开闸），继续按计划蹲点"), "warn")
                    return {"ok": False, "msg": "保护期已更新，重新排队" if changed else "保护期未到，继续蹲点"}
            except Exception:
                pass
        add_log(f"抢购失败({h['hero']}): {e.code}", "error")
        return {"ok": False, "msg": e.code}
    except Exception as e:
        add_log(f"抢购失败({h['hero']}): {e}", "error")
        return {"ok": False, "msg": str(e)}


GRAB_LEAD_MS = 1500       # 提前 2 秒开抢
GRAB_INTERVAL_MS = 120    # 连发间隔
GRAB_MAX_ATTEMPTS = 18    # -1.5s ~ +0.5s 覆盖（18 × 120ms = 2.16s）


def grab_burst(key):
    """覆盖式抢购：提前 1s 开始，每 120ms 一次直到成功/终态；每次结果记日志"""
    heroes = load("purpleHeroes", {})
    h = heroes.get(key) or {}
    if h.get("status") != "ALIVE":
        return {"ok": False, "msg": f"状态{h.get('status')}，跳过"}
    label = f"{h.get('hero', '?')}({h.get('quality', '?')}{h.get('star', '?')}星 @{h.get('owner', '?')})"
    r = {"ok": False, "msg": "未知"}
    for i in range(GRAB_MAX_ATTEMPTS):
        r = grab_hero(key)
        msg = r.get("msg", "")
        if r["ok"]:
            add_log(f"抢购成功: {label}（第{i+1}次尝试）", "success")
            return r
        add_log(f"抢购第{i+1}次失败: {label} -> {msg}", "warn")
        if r.get("gone") or "武将位已满" in msg or "武将已不在" in msg:
            return r
        if "保护期" in msg and "更新" in msg:
            add_log(f"抢购中止: {label} 保护期已更新（卡池刷新）", "warn")
            return r
        time.sleep(GRAB_INTERVAL_MS / 1000)
    add_log(f"抢购失败: {label} {GRAB_MAX_ATTEMPTS}次均未命中", "error")
    return r


_grab_threads = {}


_train_timers = {}


def check_training_timers():
    """训练到点精确触发：endsAt 进入 90s 窗口的 session 安排独立线程，
    到点(结束+3s)自动领取并立即重排（不等整点）。整点任务保留作兜底。"""
    try:
        d = with_session(lambda tok: api("GET", "/api/v1/hero-training", token=tok))
    except Exception:
        return
    for s in d.get("slots") or []:
        sess = s.get("session")
        if not sess:
            continue
        slot = s["slotNumber"]
        th = _train_timers.get(slot)
        if th and th.is_alive():
            continue
        wait = _parse_ts(sess.get("endsAt")) + 3 - time.time()
        if wait > 90:
            continue
        def fire(w=wait, name=sess.get("heroName")):
            time.sleep(max(0, w))
            if load("paused", False) is True:
                add_log("训练到期但自动化已暂停(" + str(name) + ")，恢复后自动重试", "warn")
                return
            try:
                tok = read_token()
                r = job_training(tok)
                add_log("训练到点触发(" + str(name) + "): " + "; ".join(r))
            except Exception as e:
                add_log("训练触发失败: " + str(getattr(e, "code", e)), "error")
        th = threading.Thread(target=fire, daemon=True)
        _train_timers[slot] = th
        th.start()


_res_timers = {}


def _hero_level_map(token):
    try:
        hl = api("GET", "/api/v1/heroes?limit=50", token=token).get("heroes") or []
        return {h["heroInstanceId"]: h for h in hl}
    except Exception:
        return {}


def _pick_resource_slot(token, hero_level):
    """检索空资源槽：守卫等级(npcLevel)<=武将等级 可打；在可打的里面选资源等级(收益)最高的。
    守卫等级需逐点查详情（空槽列表只有资源等级），按资源等级降序逐个查，命中即停。"""
    try:
        r = api("GET", "/api/v1/territory/resources", token=token)
        empties = [s for s in (r.get("slots") or []) if not s.get("occupationId")]
        empties.sort(key=lambda s: -(s.get("level") or 0))  # 资源等级降序（收益优先）
        for s in empties:
            try:
                det = api("GET", "/api/v1/resource-nodes/" + s["resourceNodeId"], token=token)
                g = det.get("garrison") or {}
                guard_lv = g.get("npcLevel") or g.get("level") or s.get("level") or 0
                if g.get("kind") == "PLAYER":
                    guard_lv = 999  # 玩家驻守的点不自动挑战
                if guard_lv <= hero_level:
                    s["guardLevel"] = guard_lv
                    return s
            except Exception:
                continue
        return None
    except Exception:
        return None


def _resource_flow(occ, hero_id, hero_name, hero_level):
    """单点全流程：到点收获 -> 等5分钟返程 -> 检索重派同一武将"""
    try:
        tok = read_token()
        if not tok:
            return
        for _retry in range(2):
            try:
                api("POST", "/api/v1/resource-occupations/" + occ["occupationId"] + "/harvests", token=tok,
                    body={"operationId": op_id(), "expectedVersion": str(occ.get("occupationVersion", "0")), "heroInstanceId": None})
                break
            except Exception as _he:
                if "INVENTORY_FULL" in str(getattr(_he, "code", "")) and _retry == 0:
                    ensure_inventory_space(tok, need=1)
                    continue
                raise
        add_log("资源点收获: " + str(hero_name) + " @" + str(occ.get("type", "")) + "Lv" + str(occ.get("level")), "success")
        threading.Thread(target=refresh_snapshot, kwargs={"force": True}, daemon=True).start()
        _reg_redispatch(hero_id, hero_name, occ.get("resourceNodeId"), occ.get("type"), occ.get("level"), delay=310)
        time.sleep(310)  # 返程 5 分钟到家，再重派原点
        _claim_and_redispatch(hero_id, hero_name, occ.get("resourceNodeId"), occ.get("type"), occ.get("level"))
    except Exception as e:
        add_log("资源点收获失败(" + str(hero_name) + "): " + str(getattr(e, "code", e)), "error")
        return
        # 收获后武将返程；返程到家由行军到点 timer 触发重派原点


def _node_hours(token, node_id, default=8):
    """资源点产出周期(node.completeHours)，缓存于 nodeCache"""
    try:
        cache = load("nodeCache", {})
        if node_id in cache:
            return cache[node_id]
        det = api("GET", "/api/v1/resource-nodes/" + node_id, token=token)
        hp = (det.get("harvestPreview") or {})
        h = hp.get("completeHours") or default
        cache[node_id] = h
        save("nodeCache", cache)
        return h
    except Exception:
        return default


def _reg_redispatch(hero_id, hero_name, node_id, node_type, node_level, delay=310):
    """登记待重派任务（落盘），进程重启后由 tick 兜底执行"""
    with LOCK:
        pd = load("pendingRedispatch", [])
        pd = [x for x in pd if x.get("heroId") != hero_id]
        pd.append({"heroId": hero_id, "heroName": hero_name, "nodeId": node_id,
                   "type": node_type, "level": node_level,
                   "dueAt": time.time() + delay})
        save("pendingRedispatch", pd)


def _claim_and_redispatch(hero_id, hero_name, node_id, node_type, node_level):
    """认领（从 pending 移除成功才执行，防双路径重复）；暂停中不认领（任务积压，恢复后由 tick 重试）"""
    if load("paused", False) is True:
        return
    with LOCK:
        pd = load("pendingRedispatch", [])
        mine = [x for x in pd if x.get("heroId") == hero_id and x.get("nodeId") == node_id]
        if not mine:
            return  # 已被其他路径（tick 恢复）认领
        save("pendingRedispatch", [x for x in pd if x is not mine[0]])
    _redispatch(hero_id, hero_name, node_id, node_type, node_level)


def check_pending_redispatch():
    """每分钟：到期未执行的待重派任务（重启恢复路径）"""
    pd = load("pendingRedispatch", [])
    now = time.time()
    for x in list(pd):
        if now < x.get("dueAt", 0):
            continue
        threading.Thread(target=_claim_and_redispatch, args=(
            x.get("heroId"), x.get("heroName"), x.get("nodeId"), x.get("type"), x.get("level")), daemon=True).start()


def _redispatch(hero_id, hero_name, node_id, node_type, node_level):
    """回城后重派至原资源点"""
    try:
        tok = read_token()
        if not tok:
            return
        time.sleep(5)  # 等武将落位到家
        for attempt in range(3):
            try:
                det = api("GET", "/api/v1/resource-nodes/" + node_id, token=tok)
                if "OCCUPY" not in (det.get("availableActions") or []):
                    add_log(f"重派取消({hero_name}): 原点不可占领(被占/失效)")
                    return
                api("POST", "/api/v1/resource-nodes/" + node_id + "/marches", token=tok, body={
                    "operationId": op_id(), "action": "OCCUPY",
                    "heroInstanceId": hero_id, "resourceNodeId": node_id,
                    "expectedVersion": str(det.get("version", "0")), "forcePaymentMethod": None})
                add_log(f"重派: {hero_name} -> {node_type}Lv{node_level}(原点, 第{attempt+1}次尝试)", "success")
                with LOCK:
                    save("pendingRedispatch", [x for x in load("pendingRedispatch", []) if x.get("heroId") != hero_id])
                return
                threading.Thread(target=refresh_snapshot, kwargs={"force": True}, daemon=True).start()
                return
            except Exception as e:
                code = getattr(e, 'code', '')
                last = f"{code}: {e}"
                if attempt < 2:
                    time.sleep(20)  # 到家落位可能延迟，20s 后重试
        add_log(f"重派失败({hero_name}): {last}", "error")
    except Exception as e:
        add_log(f"重派异常({hero_name}): {e}", "error")


def check_resource_timers():
    """每分钟：满8h占领安排收获触发；行军(派遣/回程)到点安排状态刷新触发"""
    try:
        mi = with_session(lambda tok: api("GET", "/api/v1/military-intelligence", token=tok))
        d = with_session(lambda tok: api("GET", "/api/v1/resource-occupations", token=tok))
    except Exception:
        return
    # 行军到点（派遣到达/回城到家）：仅刷新快照让面板状态即时切换
    for e in (mi.get("entries") or []):
        if e.get("targetKind") != "RESOURCE" or e.get("state") == "GARRISONED":
            continue
        tkey = "march-" + str(e.get("entryId"))
        th = _res_timers.get(tkey)
        if th and th.is_alive():
            continue
        wait = _parse_ts(e.get("arrivesAt")) + 2 - time.time()
        if wait > 90 or wait < -120:
            continue
        def ffire(w=wait):
            time.sleep(max(0, w))
            refresh_snapshot(force=True)
        th = threading.Thread(target=ffire, daemon=True)
        _res_timers[tkey] = th
        th.start()
    hero_by_node = {}
    for e in (mi.get("entries") or []):
        if e.get("resourceNodeId") and e.get("heroInstanceId"):
            hero_by_node[e["resourceNodeId"]] = e
    for occ in d.get("occupations") or []:
        oid = occ["occupationId"]
        th = _res_timers.get(oid)
        if th and th.is_alive():
            continue
        _tok = read_token()
        _hours = _node_hours(_tok, occ.get("resourceNodeId")) if _tok else 8
        wait = _parse_ts(occ.get("occupiedAt")) + _hours * 3600 - time.time()
        if wait > 90:
            continue
        ent = hero_by_node.get(occ.get("resourceNodeId")) or {}
        hero_id = ent.get("heroInstanceId")
        hero_name = ent.get("heroName") or occ.get("occupierDisplayName")
        if not hero_id:
            continue
        hl = _hero_level_map(read_token()).get(hero_id, {})
        hero_level = hl.get("level") or 30
        def fire(w=wait, o=occ, hid=hero_id, hn=hero_name, hlv=hero_level):
            time.sleep(max(0, w))
            _resource_flow(o, hid, hn, hlv)
        th = threading.Thread(target=fire, daemon=True)
        _res_timers[oid] = th
        th.start()


def _grab_once(key):
    """单目标一次性抢购（含 0.3s 前置等待+burst）；成功或终态后线程表自清"""
    try:
        grab_burst(key)
    except Exception as e:
        add_log(f"抢购异常({key}): {e}", "error")
    finally:
        _grab_threads.pop(key, None)


def check_reservations():
    with LOCK:
        heroes = load("purpleHeroes", {})
    now = time.time()
    for key, h in heroes.items():
        if h.get("status") != "ALIVE" or not h.get("reserved"):
            continue
        dt = _parse_ts(h.get("protectionEndsAt")) - now
        if dt <= 0:
            th = _grab_threads.get(key)
            if th and th.is_alive():
                continue
            _grab_threads[key] = threading.Thread(target=_grab_once, args=(key,), daemon=True)
            _grab_threads[key].start()
        elif dt <= 90:
            if key not in _grab_threads or not _grab_threads[key].is_alive():
                def waiter(k=key, wait=dt):
                    time.sleep(max(0, wait - 0.15))
                    grab_burst(k)
                th = threading.Thread(target=waiter, daemon=True)
                _grab_threads[key] = th
                th.start()


# ---------- 调度 ----------

def tick():
    now = datetime.now(TZ)
    date, hour, minute = now.strftime("%Y-%m-%d"), now.hour, now.minute
    daily = load("daily", {})
    if daily.get("date") != date:
        daily = {"date": date, "signin": False, "mining": 0, "hourly": {}}
        save("daily", daily)

    token = read_token()
    if not token:
        warn_once("noToken", "尚无 accessToken：请在手机游戏页面点一下书签上报（见面板顶部说明）")
        return

    # 采样
    try:
        home = with_session(lambda tok: api("GET", "/api/v1/home", token=tok))
        write_snapshot(read_token(), home)
    except Exception:
        pass

    # 暂停 = 拦截一切自动操作（训练/收获/重派/提魂/遍历/签到/整点/抢购），仅保留采样与紫将扫描记录
    if load("paused", False) is True:
        if minute % 5 == 2:
            for f in job_purple_scan():
                add_log(f"发现(暂停中): {f}", "success")
        return
    check_training_timers()
    check_resource_timers()
    check_tavern_refresh()
    check_pending_redispatch()
    if minute % 10 == 4:
        threading.Thread(target=job_soul_scan, daemon=True).start()

    try:
        if hour == 0 and minute == 1 and not daily.get("signin"):
            r = job_signin()
            add_log("签到: " + "; ".join(r))
            daily["signin"] = True
            save("daily", daily)

        if hour == 0 and 1 <= minute <= 30 and daily.get("mining", 0) < DAILY_MINING:
            r = mine_once()
            if r == "OK":
                mark_self_action()
                daily["mining"] = daily.get("mining", 0) + 1
                save("daily", daily)
                if daily["mining"] == DAILY_MINING:
                    add_log("矿山: 今日 10 次开采完成")
            elif r == "DONE":
                daily["mining"] = DAILY_MINING
                save("daily", daily)
                add_log("矿山: 次数已用完（可能在游戏内已采）")
            elif r == "COOLDOWN":
                time.sleep(30)
                r2 = mine_once()
                if r2 == "OK":
                    mark_self_action()
                    daily["mining"] = daily.get("mining", 0) + 1
                    save("daily", daily)
                elif r2 == "DONE":
                    daily["mining"] = DAILY_MINING
                    save("daily", daily)

        if minute == 0 and str(hour) not in (daily.get("hourly") or {}):
            r = job_hourly()
            daily = load("daily", {})
            daily.setdefault("hourly", {})[str(hour)] = True
            save("daily", daily)
            add_log(f"[{hour:02d}:00] " + "; ".join(r))

        if minute % 5 == 2:
            for f in job_purple_scan():
                add_log(f"发现: {f}", "success")

        check_reservations()
    except Exception as e:
        add_log(f"调度异常: {e}", "error")


def scheduler_loop():
    while True:
        try:
            tick()
        except Exception as e:
            add_log(f"调度线程异常: {e}", "error")
        now = time.time()
        time.sleep(60 - (now % 60) + 1)


# ---------- HTTP ----------

_page_cache = {"mtime": None, "html": "<h1>page.html missing</h1>"}


def _load_page():
    """page.html 变更自动重读（按 mtime），部署后无需重启"""
    try:
        mtime = os.path.getmtime(PAGE_FILE)
        if _page_cache["mtime"] != mtime:
            with open(PAGE_FILE, encoding="utf-8") as f:
                _page_cache["html"] = f.read()
            _page_cache["mtime"] = mtime
    except Exception:
        pass
    return _page_cache["html"]


def jresp(obj, status=200, extra=None):
    import io
    body = json.dumps(obj, ensure_ascii=False).encode()
    head = {"Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*"}
    if extra:
        head.update(extra)
    return status, head, body


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, status, headers, body):
        self.send_response(status)
        for k, v in headers.items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urllib_parse.urlparse(self.path)
        sec = get_secret()
        base = "/" + sec
        # 混淆路径：/SECRET -> 301 /SECRET/；/SECRET/ -> 面板；/SECRET/api/* -> 面板API；其余一律 404（仿 nginx）
        if u.path == base:
            self.send_response(301)
            self.send_header("Location", base + "/")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if u.path == base + "/":
            self._send(200, {"Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store"}, _load_page().encode())
            return
        if u.path == base + "/api/status":
            with LOCK:
                data = {
                    "token": {k: v for k, v in load("token", {}).items() if k != "token"},
                    "daily": load("daily", {}),
                    "heroes": load("purpleHeroes", {}),
                    "log": load("log", []),
                    "snapshot": load("snapshot", {}),
                    "paused": load("paused", False) is True,
                    "autoReserve": load("autoReserve", True) is not False,
                    "serverTime": datetime.now(timezone.utc).isoformat(),
                    "notices": _live_notices(),
                    "soulFactory": load("soulFactory", False) is True,
                    "reserveScope": load("reserveScope", {"pairs": []}),
                    "knownHeroes": _known_purple_orange(),
                    "souls": (_soul_daily().get("souls") or {}),
                }
            t = data["token"]
            t["hasToken"] = bool(read_token())
            st, hd, bd = jresp(data)
            self._send(st, hd, bd)
            return
        self._send(404, {"Content-Type": "text/html"}, NGINX_404)

    def do_POST(self):
        u = urllib_parse.urlparse(self.path)
        sec = get_secret()
        base = "/" + sec
        # 上报接口：原路径但必须带中继密钥头；面板 API：混淆路径下
        via_url = u.path == f"/r/{sec}"
        if via_url:
            add_log("[诊断] 上报到达(URL密钥路径)", "info")
            pass  # route 归一化见下
        elif u.path == "/api/report-token":
            origin = self.headers.get("Origin") or self.headers.get("Referer") or ""
            if self.headers.get("X-Relay-Key") != sec and "qjsh.top" not in origin:
                self._send(404, {"Content-Type": "text/html"}, NGINX_404)
                return
        elif not u.path.startswith(base + "/api/"):
            self._send(404, {"Content-Type": "text/html"}, NGINX_404)
            return
        route = "/api/report-token" if via_url else (u.path[len(base):] if u.path.startswith(base) else u.path)
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length).decode()) if length else {}
        except Exception:
            body = {}
        if route == "/api/report-token":
            tok = body.get("token")
            if not tok or not isinstance(tok, str) or len(tok) < 20:
                st, hd, bd = jresp({"error": "invalid token"}, 400)
                self._send(st, hd, bd)
                return
            report_token(tok)
            try:
                home = api("GET", "/api/v1/home", token=tok)
                write_snapshot(tok, home, force=True)
                add_log(f"accessToken 已上报 ✓ {home['player']['displayName']} Lv{home['player']['level']}（书签）", "success")
                st, hd, bd = jresp({"ok": True})
            except Exception as e:
                code = getattr(e, "code", "")
                if code in ("SESSION_EXPIRED", "SESSION_REPLACED"):
                    save("token", {})
                    add_log("上报的 token 无效——请确认游戏已进入（过了登录页）再点书签", "error")
                    st, hd, bd = jresp({"ok": False, "error": "invalid token"}, 400)
                else:
                    add_log("accessToken 已上报 ✓（验证请求延迟，不影响使用）（书签）", "success")
                    st, hd, bd = jresp({"ok": True})
            self._send(st, hd, bd)
            return
        if route == "/api/reset-souls":
            save("soulCapNotified", False)
            d = _soul_daily()
            d["souls"] = {}
            save("daily", d)
            add_log("每日将魂上限已重置", "success")
            notify("将魂计数已清零（上限恢复）")
            st, hd, bd = jresp({"ok": True})
            self._send(st, hd, bd)
            return
        if route == "/api/soul-factory":
            val = bool(body.get("enabled"))
            save("soulFactory", val)
            add_log("将魂工厂已" + ("开启" if val else "关闭"), "success" if val else "warn")
            notify("将魂工厂已" + ("开启" if val else "关闭"))
            if val:
                threading.Thread(target=lambda: [add_log("提魂(手动): " + "; ".join(r) if r else "提魂(手动): 无可提候选", "success") for r in [job_soul_factory(read_token())]], daemon=True).start()
            st, hd, bd = jresp({"ok": True, "soulFactory": val})
            self._send(st, hd, bd)
            return
        if route == "/api/save-scope":
            scope = body if isinstance(body, dict) else {}
            clean_pairs = []
            for pr in (scope.get("pairs") or []):
                if (isinstance(pr, dict) and isinstance(pr.get("star"), int) and 1 <= pr.get("star") <= 5
                        and isinstance(pr.get("hero"), str) and len(pr.get("hero")) <= 20):
                    clean_pairs.append({"star": pr["star"], "hero": pr["hero"]})
            save("reserveScope", {"pairs": clean_pairs[:200]})
            st, hd, bd = jresp({"ok": True})
            self._send(st, hd, bd)
            return
        if route == "/api/auto-reserve":
            val = bool(body.get("enabled"))
            if val:
                _sc0 = load("reserveScope", {"pairs": []})
                if not _sc0.get("pairs"):
                    notify("自动预约范围为空，请先点击「范围」设置")
                    st, hd, bd = jresp({"ok": False, "autoReserve": False, "error": "SCOPE_EMPTY", "msg": "自动预约范围为空，请先设置范围"})
                    self._send(st, hd, bd)
                    return
            save("autoReserve", val)
            with LOCK:
                heroes = load("purpleHeroes", {})
                changed = []
                if val:
                    _full_note = ""
                    _full_note = ""
                    if _cap_full():
                        cap = (load("snapshot", {}) or {}).get("heroCapacity") or {}
                        _full_note = f"（注意: 武将位已满 {cap.get('owned')}/{cap.get('capacity')}，到期前需腾位）"
                        notify(f"武将位已满 {cap.get('owned')}/{cap.get('capacity')}，已预约目标到期前需腾位")
                    # 开启：范围匹配的在售/保留武将全部预约（已过期的由蹲点循环立即抢）
                    _sc_set = {(p["star"], p["hero"]) for p in load("reserveScope", {"pairs": []}).get("pairs", [])}
                    for k, h in heroes.items():
                        if h.get("status") == "ALIVE" and not h.get("reserved"):
                            if ((h.get("star") or 0), h.get("hero")) in _sc_set:
                                h["reserved"] = True
                                h["reservedAt"] = datetime.now(timezone.utc).isoformat()
                                changed.append(f"@{h['owner']} {h['hero']}({h['quality']}{h['star']}星)")
                    save("purpleHeroes", heroes)
                    _detail = (f"，批量预约 {len(changed)} 个: " + "、".join(changed)) if changed else ""
                    add_log("自动预约已开启" + _detail + _full_note, "success" if not _full_note else "warn")
                    threading.Thread(target=check_reservations, daemon=True).start()
                else:
                    for k, h in heroes.items():
                        if h.get("reserved"):
                            h["reserved"] = False
                            changed.append(h["hero"])
                    save("purpleHeroes", heroes)
                    add_log("自动预约已暂停，取消全部预约" + (f"({len(changed)} 个)" if changed else ""), "warn")
            st, hd, bd = jresp({"ok": True, "autoReserve": val})
            self._send(st, hd, bd)
            return
        if route == "/api/pause":
            val = bool(body.get("paused"))
            save("paused", val)
            if val:
                # 暂停时取消所有预约（同暂停收购逻辑）
                heroes = load("purpleHeroes", {})
                cancelled = [h["hero"] for h in heroes.values() if h.get("reserved")]
                for h in heroes.values():
                    if h.get("reserved"):
                        h["reserved"] = False
                save("purpleHeroes", heroes)
                add_log("自动化已暂停，取消全部预约" + (f"({len(cancelled)} 个)" if cancelled else ""), "warn")
            else:
                add_log("自动化已恢复", "success")
            if val:
                threading.Thread(target=refresh_snapshot, kwargs={"force": True}, daemon=True).start()
            st, hd, bd = jresp({"ok": True, "paused": val})
            self._send(st, hd, bd)
            return
        if route == "/api/reserve":
            if load("paused", False) is True:
                st, hd, bd = jresp({"ok": False, "error": "PAUSED", "msg": "自动化已暂停，预约不可用（点▶恢复后再试）"}, 403)
                self._send(st, hd, bd)
                return
            key = body.get("key")
            with LOCK:
                heroes = load("purpleHeroes", {})
            if key not in heroes:
                st, hd, bd = jresp({"error": "not found"}, 404)
                self._send(st, hd, bd)
                return
            heroes[key]["reserved"] = not heroes[key].get("reserved")
            if heroes[key]["reserved"]:
                heroes[key]["reservedAt"] = datetime.now(timezone.utc).isoformat()
            with LOCK:
                save("purpleHeroes", heroes)
            add_log(("预约" if heroes[key]["reserved"] else "取消预约") + f": @{heroes[key]['owner']} {heroes[key]['hero']}")
            cap = (load("snapshot", {}) or {}).get("heroCapacity") or {}
            warn = None
            if heroes[key]["reserved"] and cap and cap.get("owned", 0) >= cap.get("capacity", 0) > 0:
                warn = f"武将位已满 {cap.get('owned')}/{cap.get('capacity')}，到期前请腾位"
            st, hd, bd = jresp({"ok": True, "reserved": heroes[key]["reserved"], "warn": warn})
            self._send(st, hd, bd)
            return
        if route == "/api/grab":
            if load("paused", False) is True:
                st, hd, bd = jresp({"ok": False, "error": "PAUSED", "msg": "自动化已暂停，抢购不可用（点▶恢复后再试）"}, 403)
                self._send(st, hd, bd)
                return
            r = grab_hero(body.get("key"), manual=True)
            if r.get("ok"):
                _h = (load("purpleHeroes", {}).get(body.get("key")) or {})
                add_log(f"🎉 抢购成功(手动): {_h.get('hero','?')}({_h.get('quality','?')}{_h.get('star','?')}星 @{_h.get('owner','?')})", "success")
                threading.Thread(target=refresh_snapshot, kwargs={"force": True}, daemon=True).start()
            st, hd, bd = jresp(r)
            self._send(st, hd, bd)
            return
        if route == "/api/job":
            name = body.get("name")
            if name == "signin":
                r = job_signin()
                daily = load("daily", {})
                daily["signin"] = True
                daily["date"] = datetime.now(TZ).strftime("%Y-%m-%d")
                save("daily", daily)
                add_log("手动签到: " + "; ".join(r))
                resp = {"ok": True, "result": r}
            elif name == "hourly":
                r = job_hourly()
                add_log("手动整点任务: " + "; ".join(r))
                resp = {"ok": True, "result": r}
            elif name == "mine":
                r = mine_once()
                if r == "OK":
                    daily = load("daily", {})
                    daily["mining"] = daily.get("mining", 0) + 1
                    save("daily", daily)
                add_log(f"手动开采: {r}")
                resp = {"ok": True, "result": r}
            elif name == "refresh":
                threading.Thread(target=refresh_snapshot, kwargs={"force": True}, daemon=True).start()
                resp = {"ok": True, "result": ["已刷新"]}
            elif name == "scan":
                fs = job_purple_scan()
                for f in fs:
                    add_log("发现: " + f, "success")
                resp = {"ok": True, "result": [f"发现 {len(fs)} 个: " + "; ".join(fs) if fs else "无新发现"], "found": fs}
            else:
                st, hd, bd = jresp({"error": "unknown job"}, 400)
                self._send(st, hd, bd)
                return
            if name != "refresh":
                threading.Timer(1.5, refresh_snapshot, kwargs={"force": True}).start()
            st, hd, bd = jresp(resp)
            self._send(st, hd, bd)
            return
        st, hd, bd = jresp({"error": "not found"}, 404)
        self._send(st, hd, bd)


def main():
    os.makedirs(STATE_DIR, exist_ok=True)
    threading.Thread(target=scheduler_loop, daemon=True).start()
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    add_log("qjshd 服务已启动（服务器版）", "success")
    print(f"qjshd listening on 0.0.0.0:{PORT}")
    srv.serve_forever()


if __name__ == "__main__":
    main()
