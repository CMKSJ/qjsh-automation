# -*- coding: utf-8 -*-
"""
Q将水浒 日常操作脚本：矿山开采 / 市场征税征收 / 市场交易

注意：accessToken 为单会话——每次登录会使旧 token 失效（游戏内重新进入也会踢掉本脚本），
因此本脚本每次运行都重新登录。

操作清单：
  矿山-开采      POST /api/v1/home/mining-collections     {operationId}
  征税-征收      POST /api/v1/home/market/collections     {operationId, expectedVersion}
  征税-强征      POST /api/v1/home/market/forced-collections {operationId, expectedVersion}  (元宝)
  市场-交易      POST /api/v1/home/market/exchanges       {operationId, offerId, quantity}
                  offerId: MARKET_EXCHANGE_1 / _5 / _8 / _15
                  (100/500/800/1500 铜 + 等量粮草 -> 1/5/8/15 银票)
"""
import json
import sys
import uuid

from qjsh_api import login, call, PHONE, PASSWORD


def op_id():
    """operationId：客户端用 UUID，服务器按此幂等去重"""
    return str(uuid.uuid4())


def mining_collect(token):
    """矿山-开采（每日 totalCount 次，有冷却）"""
    return call("POST", "/api/v1/home/mining-collections",
                token=token, body={"operationId": op_id()})


def market_collect(token):
    """征税-征收（免费收铜钱；expectedVersion 取 GET market 的 version）"""
    market = call("GET", "/api/v1/home/market", token=token)
    return call("POST", "/api/v1/home/market/collections", token=token,
                body={"operationId": op_id(), "expectedVersion": market["version"]})


def market_forced_collect(token):
    """征税-强征（花元宝直接收满仓，每日 5 次）"""
    market = call("GET", "/api/v1/home/market", token=token)
    return call("POST", "/api/v1/home/market/forced-collections", token=token,
                body={"operationId": op_id(), "expectedVersion": market["version"]})


def market_exchange(token, tickets=1, quantity=1):
    """市场-交易：铜钱+粮草换银票。tickets in {1,5,8,15}"""
    offer = f"MARKET_EXCHANGE_{tickets}"
    return call("POST", "/api/v1/home/market/exchanges", token=token,
                body={"operationId": op_id(), "offerId": offer, "quantity": quantity})


def main():
    _, token, player_id, _ = login(PHONE, PASSWORD)
    print(f"登录成功: {player_id}\n")

    # 状态总览
    home = call("GET", "/api/v1/home", token=token)
    mining = home["mining"]
    print(f"矿山: 今日 {mining['usedCount']}/{mining['totalCount']}, "
          f"可用={mining['available']}, 冷却至 {mining['cooldownEndsAt']}")
    mc = home["marketCollection"]
    print(f"市场: {mc['collectionStatus']}, 可收 {mc['availableCopper']} 铜 (version {mc['version']})")

    jobs = sys.argv[1:] or ["mine", "collect", "trade1"]
    for job in jobs:
        print(f"\n--- {job} ---")
        try:
            if job == "mine":                       # 矿山-开采
                r = mining_collect(token)
                print(f"开采成功: +{r.get('harvest', {}).get('rewards', r)}")
            elif job == "collect":                  # 征税-征收
                r = market_collect(token)
                print(f"征收成功: +{r['collectedCopper']} 铜")
            elif job == "force":                    # 征税-强征
                r = market_forced_collect(token)
                print(f"强征成功: {json.dumps(r, ensure_ascii=False)[:200]}")
            elif job.startswith("trade"):           # 市场-交易 trade1/trade5/trade8/trade15
                n = int(job[5:] or 1)
                r = market_exchange(token, tickets=n)
                print(f"交易成功: -{r['copperCost']}铜 -{r['provisionsCost']}粮草 "
                      f"+{r['silverTicketReward']}银票")
            else:
                print(f"未知操作: {job}")
        except Exception as ex:
            print(f"失败: {ex}")


if __name__ == "__main__":
    main()
