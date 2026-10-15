// worker.js 集成测试：mock KV + mock 游戏 API，验证调度主流程
// 运行: node test/integration.test.mjs
import { readFileSync } from "fs";

// ---- 加载 worker.js 文本并注入（避免 ESM 路径问题，用 data URL import）----
const src = readFileSync(new URL("../src/worker.js", import.meta.url), "utf8");
const mod = await import("data:text/javascript;base64," + Buffer.from(src).toString("base64"));
const worker = mod.default;

// ---- mock KV ----
const kvStore = new Map();
const env = {
  QJSH_KV: {
    async get(k) { return kvStore.get(k) ?? null; },
    async put(k, v) { kvStore.set(k, v); },
  },
  PHONE: "13800000000", PASSWORD: "test-password", PAGE_KEY: "test123",
};

// ---- mock 游戏 API ----
const calls = [];
let mineCount = 0;
function apiResp(data, code = "OK") {
  return { code, message: "success", data };
}
const routes = {
  "POST /api/v1/auth/password/login": () => apiResp({ accountToken: "AT1", expiresAt: new Date(Date.now() + 7 * 86400e3).toISOString(), accountId: "a1" }),
  "GET /api/v1/auth/servers": () => apiResp({ defaultServerId: "recharge-s1", servers: [] }),
  "POST /api/v1/auth/servers/enter": () => apiResp({ accessToken: "RT1", expiresAt: new Date(Date.now() + 7 * 86400e3).toISOString(), playerId: "p1", serverId: "recharge-s1" }),
  "GET /api/v1/login-rewards": () => apiResp({ cycleId: "c1", version: "7", days: [{ day: 5, status: "AVAILABLE" }] }),
  "POST /api/v1/login-rewards/claims": () => apiResp({}),
  "GET /api/v1/monthly-login-rewards": () => apiResp({ monthId: "m1", version: "7", days: [{ day: 15, status: "AVAILABLE" }] }),
  "POST /api/v1/monthly-login-rewards/claims": () => apiResp({}),
  "POST /api/v1/home/mining-collections": () => (++mineCount <= 10 ? apiResp({}) : { code: "HOME_MINING_DAILY_LIMIT", message: "今日矿山开采次数已用完", data: null }),
  "GET /api/v1/home": () => apiResp({
    economy: { currencies: [
      { code: "PROVISIONS", balance: 12, version: 1 },
      { code: "COPPER", balance: 500000, version: 1 },
    ]},
    player: { displayName: "测试玩家", level: 21, combatPower: 3393, provisionsCapacity: 22 },
    mining: { usedCount: mineCount, totalCount: 10, remainingCount: 10 - mineCount },
    occupation: { status: "GARRISONED", version: "98", rent: { availableCopper: 450 } },
  }),
  "GET /api/v1/home/market": () => apiResp({ collectionStatus: "READY", version: 33, availableCopper: 3888 }),
  "POST /api/v1/home/market/collections": () => apiResp({ collectedCopper: 3924 }),
  "POST /api/v1/home/market/exchanges": (body) => apiResp({ offerId: body.offerId, quantity: String(body.quantity), copperCost: "100", provisionsCost: "1", silverTicketReward: "1" }),
  "POST /api/v1/home/garrison/rent-collections": () => apiResp({ occupation: { status: "GARRISONED", version: "99", rent: { availableCopper: 0 } } }),
  "GET /api/v1/home-announcements": () => apiResp({ entries: [
    { sourceType: "TAVERN_APPEARANCE", content: "【酒馆消息】飞天龙的酒馆出现了4星紫将【时迁】，快去参观吧！", startsAt: new Date().toISOString() },
  ]}),
  "GET /api/v1/player-search": () => apiResp({ players: [{ playerId: "pid1", shortId: "100023", level: 46 }] }),
  "GET /api/v1/friend-cities/pid1/tavern": () => apiResp({
    protectionEndsAt: new Date(Date.now() + 30 * 60e3).toISOString(),
    candidates: [{ candidateId: "cand1", version: 0, name: "时迁", quality: "PURPLE", star: 4, troopType: "BOW", copperCost: 6000, silverTicketCost: 60 }],
  }),
};

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const key = `${opts.method || "GET"} ${u.pathname}`;
  calls.push(key);
  const handler = routes[key] ?? routes[`${opts.method || "GET"} ${u.pathname}`];
  if (!handler) return new Response(JSON.stringify({ code: "NOT_FOUND", message: key, data: null }), { status: 404, headers: { "Content-Type": "application/json" } });
  const body = opts.body ? JSON.parse(opts.body) : null;
  const data = handler(body);
  return new Response(JSON.stringify(data), {
    status: data.code === "OK" ? 200 : (/DAILY_LIMIT/.test(data.code) ? 409 : 400),
    headers: { "Content-Type": "application/json" },
  });
};

const ctx = { waitUntil: (p) => p.catch(e => { console.error("waitUntil:", e); process.exitCode = 1; }) };
let passed = 0, failed = 0;
const assert = (cond, msg) => { if (cond) { passed++; console.log("  PASS:", msg); } else { failed++; console.log("  FAIL:", msg); } };

// ==== T1: 北京 00:01 tick（签到 + 首次开采）====
console.log("T1: 北京 00:01 签到+开采");
const bj0001 = Date.UTC(2026, 9, 15, 16, 1, 0); // UTC 16:01 = 北京 00:01
await worker.scheduled({ scheduledTime: bj0001, cron: "* * * * *" }, env, ctx);
await new Promise(r => setTimeout(r, 50));

let log = JSON.parse(kvStore.get("log") || "[]");
assert(log.some(l => l.msg.includes("签到")), "签到日志已写");
let daily = JSON.parse(kvStore.get("daily"));
assert(daily.signin === true, "daily.signin=true");
assert(daily.mining >= 1, `开采至少 1 次 (实际 ${daily.mining})`);

// ==== T2: 整点 tick（兑换+征收+收租）====
console.log("T2: 北京 01:00 整点任务");
await worker.scheduled({ scheduledTime: Date.UTC(2026, 9, 15, 17, 0, 0), cron: "* * * * *" }, env, ctx);
await new Promise(r => setTimeout(r, 50));
log = JSON.parse(kvStore.get("log"));
const hourlyLog = log.find(l => l.msg.includes("[01:00]"));
assert(!!hourlyLog, "整点日志存在");
assert(/兑换 12 银票/.test(hourlyLog?.msg || ""), "兑换 12 银票: " + hourlyLog?.msg);
assert(/征收 \+3924/.test(hourlyLog?.msg || ""), "征收铜钱");
assert(/收租/.test(hourlyLog?.msg || ""), "收取租金");

// ==== T3: 5 分钟扫描发现紫将 ====
console.log("T3: 公告扫描发现紫将");
await worker.scheduled({ scheduledTime: Date.UTC(2026, 9, 15, 17, 2, 0), cron: "* * * * *" }, env, ctx); // minute%5==2
await new Promise(r => setTimeout(r, 100));
const heroes = JSON.parse(kvStore.get("purpleHeroes") || "{}");
const h = Object.values(heroes)[0];
assert(h && h.hero === "时迁" && h.quality === "PURPLE", "紫将时迁入监控列表");
assert(h.owner === "飞天龙" && h.copperCost === 6000, "归属与成本正确");

// ==== T4: 预约抢购（保护期已过 → 自动抢）====
console.log("T4: 预约到期自动抢购");
h.reserved = true;
h.protectionEndsAt = new Date(Date.now() - 1000).toISOString();
kvStore.set("purpleHeroes", JSON.stringify(heroes));
routes["POST /api/v1/friend-cities/pid1/tavern/recruitments"] = () => apiResp({ operationId: "x", candidateId: "cand1" });
await worker.scheduled({ scheduledTime: Date.UTC(2026, 9, 15, 17, 3, 0), cron: "* * * * *" }, env, ctx);
await new Promise(r => setTimeout(r, 100));
const heroes2 = JSON.parse(kvStore.get("purpleHeroes"));
assert(heroes2["pid1:时迁"].status === "GRABBED", "状态变为 GRABBED");
assert(calls.includes("POST /api/v1/friend-cities/pid1/tavern/recruitments"), "抢购请求已发出");

// ==== T5: Web /api/status 与鉴权 ====
console.log("T5: Web API");
let resp = await worker.fetch(new Request("https://x/api/status"), env);
assert(resp.status === 401, "无密码 401");
resp = await worker.fetch(new Request("https://x/api/status", { headers: { "X-Page-Key": "test123" } }), env);
const st = await resp.json();
assert(st.state && !st.state.token, "status 不泄露 token");
assert(st.heroes && st.log, "返回 heroes/log");
resp = await worker.fetch(new Request("https://x/"), env);
const html = await resp.text();
assert(html.includes("紫将监控"), "面板 HTML 渲染");

// ==== T6: 矿山当日已满（游戏内采过）====
console.log("T6: 矿山日限");
mineCount = 10;
const before = JSON.parse(kvStore.get("daily")).mining;
await worker.scheduled({ scheduledTime: Date.UTC(2026, 9, 15, 16, 5, 0), cron: "* * * * *" }, env, ctx);
await new Promise(r => setTimeout(r, 50));
const after = JSON.parse(kvStore.get("daily")).mining;
assert(after === 10 || after === before, `日限处理正确 (${before} -> ${after})`);

globalThis.fetch = realFetch;
console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
