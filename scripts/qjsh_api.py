# -*- coding: utf-8 -*-
"""
Q将水浒 (qjsh.top) 直接登录 + 游戏数据获取脚本

流程（逆向自 Web 客户端 https://qjsh.top/releases/20261015-001/）：
  1. POST /api/v1/auth/password/login   -> accountToken（账号级）
  2. GET  /api/v1/auth/servers          -> 服务器列表
  3. POST /api/v1/auth/servers/enter    -> accessToken（角色级会话）
  4. GET  /api/v1/bootstrap 及各模块接口 -> 游戏数据

用法：
  python qjsh_api.py                     # 登录并输出摘要
  python qjsh_api.py --dump heroes.json  # 把各模块原始 JSON 存到文件
"""
import json
import os
import sys
import urllib.error
import urllib.request

API_BASE = "https://service.qjsh.top"
RELEASE_ID = "dy-recharge-prod-water-v1-0.1.0"
CLIENT_VERSION = "0.1.0"
DEVICE_FINGERPRINT = "dev-script-0001-qjsh"  # 客户端本地生成并持久化，服务器仅记录

# 凭据从环境变量读取，避免明文入库：
#   export QJSH_PHONE=...  export QJSH_PASSWORD=...
PHONE = os.environ.get("QJSH_PHONE", "")
PASSWORD = os.environ.get("QJSH_PASSWORD", "")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")


def call(method, path, token=None, body=None):
    """调用 REST API，返回 data 字段（code != OK 时抛异常）。"""
    req = urllib.request.Request(API_BASE + path, method=method)
    req.add_header("Accept", "application/json")
    req.add_header("User-Agent", UA)
    if token:
        req.add_header("Authorization", "Bearer " + token)
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, data=data, timeout=30) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as ex:
        # 4xx/5xx 时服务器仍返回 {code, message}，业务错误码在这里（如 HOME_MINING_DAILY_LIMIT）
        try:
            payload = json.loads(ex.read().decode("utf-8"))
            raise RuntimeError(f"{method} {path} -> {payload.get('code')}: {payload.get('message')}") from None
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise
    if payload.get("code") != "OK":
        raise RuntimeError(f"{method} {path} -> {payload.get('code')}: {payload.get('message')}")
    return payload["data"]


def login(phone, password):
    """账号密码登录 -> (accountToken, accessToken, playerId)"""
    acct = call("POST", "/api/v1/auth/password/login", body={
        "releaseId": RELEASE_ID,
        "clientVersion": CLIENT_VERSION,
        "deviceFingerprint": DEVICE_FINGERPRINT,
        "phoneNumber": phone,
        "password": password,
    })
    account_token = acct["accountToken"]

    servers = call("GET", "/api/v1/auth/servers", token=account_token)
    server_id = servers["defaultServerId"]  # 或从 servers["servers"] 里选

    session = call("POST", "/api/v1/auth/servers/enter",
                   token=account_token, body={"serverId": server_id})
    return account_token, session["accessToken"], session["playerId"], server_id


def main():
    dump = "--dump" in sys.argv
    out = {}

    account_token, access_token, player_id, server_id = login(PHONE, PASSWORD)
    print(f"登录成功: player={player_id} server={server_id}")

    bootstrap = call("GET", "/api/v1/bootstrap", token=access_token)
    p = bootstrap["player"]
    print(f"角色: {p['displayName']}  等级 {p['level']}  经验 {p['experience']}  繁荣 {p['prosperity']}")
    print("货币: " + ", ".join(f"{c['code']}={c['balance']}" for c in bootstrap["economy"]["currencies"]))
    j = bootstrap["juyi"]
    print(f"聚义: Lv{j['level']}  连续登录 {j['loginDays']} 天")

    # 各模块数据（158 个端点中的常用只读接口，均为 GET）
    modules = {
        "heroes": "/api/v1/heroes",                      # 武将列表
        "formation": "/api/v1/formation",                # 阵容
        "stages_overview": "/api/v1/stages/overview",    # 关卡进度
        "economy_assets": "/api/v1/economy/assets",      # 背包物品
        "shop": "/api/v1/shop",                          # 商店
        "arena": "/api/v1/arena",                        # 竞技场
        "friends": "/api/v1/friends",                    # 好友
        "tavern": "/api/v1/tavern",                      # 酒馆
        "activities": "/api/v1/activities",              # 活动
        "seats": "/api/v1/seats",                        # 排位
        "blacksmith_equipment": "/api/v1/blacksmith/equipment",  # 装备
    }
    results = {"bootstrap": bootstrap}
    for name, path in modules.items():
        try:
            results[name] = call("GET", path, token=access_token)
            print(f"[OK] {name}")
        except Exception as ex:
            print(f"[FAIL] {name}: {ex}")

    heroes = results.get("heroes", {}).get("heroes", [])
    print(f"\n武将 ({len(heroes)}):")
    for h in heroes:
        s = h["effectiveStats"]
        print(f"  {h['name']:<6} {h['troopType']:<8} {h['quality']:<6} "
              f"{h['star']}星 Lv{h['level']:<3} 攻{s['attack']} 防{s['defense']} "
              f"体{s['vitality']} 敏{s['agility']} HP{h['effectiveMaxHp']}")

    formation = results.get("formation", {})
    print(f"阵容: {len(formation.get('heroInstanceIds', []))}/{formation.get('maxMembers')} 上阵")
    stage = results.get("stages_overview", {})
    if "chapter" in stage:
        print(f"关卡: 第{stage['chapter']['ordinal']}章 {stage['chapter']['code']}")
    items = results.get("economy_assets", {}).get("items", [])
    print(f"背包: {len(items)} 种物品")

    if dump:
        with open("qjsh_data.json", "w", encoding="utf-8") as f:
            json.dump(results, f, ensure_ascii=False, indent=2)
        print("\n全部数据已保存到 qjsh_data.json")


if __name__ == "__main__":
    main()
