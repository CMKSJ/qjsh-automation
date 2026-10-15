# qjsh-automation

「Q将水浒」(qjsh.top) 的自动化工具：Cloudflare Worker 定时日常 + 网面监控面板 + 本地 Python 脚本。

所有接口格式逆向自官方 Web 客户端，纯 REST API（无加密/签名），详见下文接口清单。

## 组成

### `qjsh-worker/` — Cloudflare Worker（主力）

部署后全自动执行（北京时间）：

| 时间 | 任务 |
|---|---|
| 每天 00:01 | 7日签到 + 月签到；启动矿山开采计划（10 次，~30s 间隔，冷却自动重试） |
| 每小时整点 | 兑换 12 银票（粮草不足则全部兑换）+ 征收市场 + 收取驻守城池租金 |
| 每 5 分钟 | 轮询公告，发现「酒馆出现紫将/橙将」→ 定位玩家 → 确认存活与保护期 |
| 每 1 分钟 + 面板在线时 | 检查已预约的紫将，保护期结束立刻抢购（双保险，秒级精度） |

配套网页面板：账号状态、今日任务进度、紫将监控表（保护期倒计时、预约抢购/立即抢按钮）、日志时间线、手动触发按钮。访问密码保护。

部署：见 [qjsh-worker/README.md](qjsh-worker/README.md)。

### `scripts/` — 本地 Python 脚本（零依赖）

```bash
export QJSH_PHONE=手机号 QJSH_PASSWORD=密码

python scripts/qjsh_api.py --dump      # 登录 + 拉取全部游戏数据摘要
python scripts/qjsh_actions.py mine    # 矿山开采
python scripts/qjsh_actions.py collect # 市场征收
python scripts/qjsh_actions.py trade1  # 市场交易（trade1/trade5/trade8/trade15）
```

## 核心接口清单

```
POST /api/v1/auth/password/login          {releaseId, clientVersion, deviceFingerprint, phoneNumber, password}
GET  /api/v1/auth/servers
POST /api/v1/auth/servers/enter           {serverId}                → accessToken（单会话，重登顶掉旧会话）
POST /api/v1/login-rewards/claims         {operationId, day, cycleId, expectedVersion}
POST /api/v1/monthly-login-rewards/claims {operationId, monthId, expectedVersion, mode:"ALL"}
POST /api/v1/home/mining-collections      {operationId}
POST /api/v1/home/market/collections      {operationId, expectedVersion}
POST /api/v1/home/market/exchanges        {operationId, offerId: MARKET_EXCHANGE_1|5|8|15, quantity}
POST /api/v1/home/garrison/rent-collections {operationId, expectedVersion}
GET  /api/v1/home-announcements           30 分钟窗口的紫将出现/招募公告
GET  /api/v1/home-announcements/recruitments?cursor=   全量翻页
GET  /api/v1/player-search?type=NAME|SHORT_ID&query=
GET  /api/v1/friend-cities/{playerId}/tavern           任何人可见
POST /api/v1/friend-cities/{playerId}/tavern/recruitments {operationId, candidateId, expectedCandidateVersion}
```

- 响应统一 `{code:"OK", data, requestId}`；业务错误 `code` 如 `HOME_MINING_DAILY_LIMIT`、`MARKET_NOT_READY`
- `operationId` 为 UUID 幂等键；`expectedVersion` 为乐观锁版本（请求前先 GET 取当前值）
- 游戏数值：粮草 5 分钟恢复 1 点（容量随等级）；酒馆紫将公告保留 30 分钟（保护期）

## 已知特性

- **单会话**：脚本登录会顶掉手机端（反之亦然）。Worker 的 token 有 7 天 KV 缓存，只在过期/被顶时重登。
- **海外出口**：Worker 出口为 Cloudflare IP，部署前建议先实测 `service.qjsh.top` 可达性。
- 本项目仅供个人账号日常自动化学习研究，请自行评估游戏服务条款风险。
