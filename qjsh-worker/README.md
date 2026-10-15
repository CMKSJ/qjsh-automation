# Q将水浒自动化 Worker（accessToken 模式）

Cloudflare Worker 定时日常 + 紫将监控抢购 + 网页面板。

**认证设计**：Worker 不保存游戏账号密码、不做登录——accessToken 由「书签」在手机游戏页面里捕获后上报（`POST /api/report-token`），之后所有任务复用该 token。这不会顶掉手机会话；反之手机重新进游戏会换新 token，面板会提示重新点一次书签。

## 功能（均为北京时间）

| 时间 | 任务 |
|---|---|
| 每天 00:01 | 7日签到 + 月签到；启动矿山开采计划（10 次，~30s 间隔，冷却自动重试） |
| 每小时整点 | 兑换 12 银票（粮草不足则全部兑换，贪心 8+5+1 档）+ 征收市场 + 收取驻守城池租金 |
| 每 5 分钟 | 轮询公告，发现「酒馆出现紫将/橙将」→ 定位玩家 → 确认存活与保护期 |
| 每 1 分钟 + 面板在线时 | 检查已预约的紫将，保护期结束立刻抢购 |

## 部署

```bash
npm install -g wrangler && wrangler login
wrangler secret put PAGE_KEY    # 面板访问密码（同时是书签上报密钥）
wrangler deploy
```

或 dashboard「Import repository」连接本仓库直接构建（wrangler.toml 已无需任何占位替换）。

> `workers.dev` 域名国内直连不稳定，手机访问建议绑定自定义域名。

## 首次使用（上报 accessToken）

1. 打开面板 `https://<worker域名>`，输入 PAGE_KEY
2. 面板顶部会显示**书签代码**（已自动嵌入你的域名和密钥），复制它
3. 手机浏览器把这段代码存为书签（名称随意）
4. 打开游戏 qjsh.top 进入后，**点一下该书签**，再在游戏里随便点一下操作（或等几秒心跳）
5. 书签会临时接管 `fetch`/`XHR`，捕获请求头里的 `Authorization: Bearer <accessToken>` 并上报，面板状态变绿即成功

书签原理：游戏客户端不把 accessToken 落盘（内存持有，请求头携带；accountToken 虽在 IndexedDB 但为 AES-GCM 加密，且用它换新 token 会顶掉手机会话），所以在页面上下文拦截一次请求头是唯一的不顶号获取方式。

## 存储

- **默认（无 KV）**：内存降级，Worker 实例重启后 token/监控列表清空，需重新点书签。每分钟 cron 会保活实例���实际丢失频率不高。
- **绑定 KV（推荐）**：dashboard 或 `wrangler kv namespace create QJSH_KV` 后在 wrangler.toml 取消注释并填 id，token 与状态持久化。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/status` | 全部状态（token 已脱敏） |
| POST | `/api/report-token` | 书签上报 `{token, key}`（sendBeacon 兼容，密钥在 body） |
| POST | `/api/reserve` `{key}` | 预约/取消抢购 |
| POST | `/api/grab` `{key}` | 立即抢购 |
| POST | `/api/job` `{name}` | 手动触发 signin / hourly / mine / scan |

## 测试

```bash
node test/integration.test.mjs   # 16 项：无 token 保护/书签上报/签到开采/整点任务/紫将扫描/抢购/脱敏/失效清理
```

## 已知特性

- 手机每次重新进游戏后旧 accessToken 失效 → 面板红点提示 → 再点一次书签
- operationId 幂等；expectedVersion 乐观锁（请求前先 GET 当前值）
- 矿山 tick 内冷却等 30s 重试，10 次约 5-10 分钟完成
- 紫将公告 30 分钟时效，5 分钟轮询零遗漏；发现时可能已被抢（标记 GONE）
- 抢购费用花自己的铜钱+银票（面板显示成本）
