# Q将水浒自动化 Worker

部署在 Cloudflare Workers 的定时任务 + 网页面板。

## 功能（均为北京时间）

| 时间 | 任务 |
|---|---|
| 每天 00:01 | 7日签到 + 月签到；启动矿山开采计划（10 次，~30s 间隔，冷却自动重试，当日未采完下个 tick 继续） |
| 每小时整点 | 兑换 12 银票（粮草不足则把现有粮草全部兑换，贪心 8+5+1 档）+ 征收市场 + 收取驻守城池租金 |
| 每 5 分钟 | 轮询公告，发现「酒馆出现紫将/橙将」→ 定位玩家 → 确认存活与保护期，进入监控列表 |
| 每 1 分钟 + 网页在线时每 10 秒 | 检查已预约的紫将，保护期结束立刻抢购 |

## 部署

```bash
# 1. 前置：Node.js 18+，Cloudflare 账号
npm install -g wrangler
wrangler login

# 2. 创建 KV namespace，把返回的 id 填进 wrangler.toml
wrangler kv namespace create QJSH_KV

# 3. 配置 secrets
wrangler secret put PHONE       # 游戏手机号
wrangler secret put PASSWORD    # 游戏密码
wrangler secret put PAGE_KEY    # 面板访问密码（自定一个）

# 4. 部署
wrangler deploy
```

部署后访问 `https://qjsh-bot.<你的子域>.workers.dev`，输入 PAGE_KEY 进入面板。

> ⚠️ `workers.dev` 域名在国内直连不稳定。手机要正常访问，建议在 CF 控制台给自己的域名（需托管在 Cloudflare）加一条自定义域名绑定到该 Worker。

## 面板

- 账号状态（等级/战力/货币）+ 今日任务进度（签到、开采 x/10、整点任务次数）
- 紫将监控表：武将/主人/成本/**保护期倒计时**/状态，每个一排「预约抢购」（到期自动抢）和「立即抢」按钮
- 日志时间线（最近 300 条）
- 手动按钮：立即签到 / 立即整点任务 / 开采一次 / 扫描紫将

## 已知的运行特性

- **单会话**：脚本登录会顶掉手机端会话（反之亦然）。Worker 用 KV 缓存 accessToken，只在过期（7 天）或被顶时重登，冲突最小化。手机每次重新进游戏后，Worker 的下一次任务会自动重登。
- **operationId 幂等**：所有写操作带 UUID，网络超时重发同一 ID 不会重复扣资源（本实现每次生成新 ID，因请求体已冻结语义）。
- **开采间隔**：矿山本身有冷却，tick 每分钟开采 1 次、遇冷却等 30s 重试 1 次，10 次约 5-10 分钟完成。00:01-00:30 窗口内未完成（游戏内已采/异常）则次日再试。
- **公告时效**：「酒馆出现紫将」公告只保留 30 分钟，5 分钟轮询零遗漏；但发现时武将可能已被抢（会标记 GONE）。
- **抢购费用**：抢别人的紫将花自己的铜钱+银票（面板有显示成本），失败（余额不足/已被抢）记入日志。

## 调试

```bash
wrangler tail                          # 实时日志
curl https://.../api/status -H "X-Page-Key: ..."   # 原始状态 JSON
# 手动触发一次 cron（本地）
wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
```
