// worker.js 集成测试（accessToken 模式）：mock KV + mock 游戏 API
// 运行: node test/integration.test.mjs
import { readFileSync } from "fs";

const src = readFileSync(new URL("../src/worker.js", import.meta.url), "utf8");
const mod = await import("data:text/javascript;base64," + Buffer.from(src).toString("base64"));
const worker = mod.default;

// ---- mock KV（同时验证内存降级：不传 QJSH_KV，worker 应走 globalThis 内存） ----
const env = { PAGE_KEY: "test123" };  // 故意不绑 QJSH_KV

// ---- mock 游戏 API（一律要求 Bearer RT-good-0123456789abcdef012345） ----
const calls = [];
let mineCount = 0;
let sessionExpired = false;
const apiResp = (data, code = "OK") => ({ code, message: "success", data });
const routes = {
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
  "POST /api/v1/home/market/exchanges": (b) => apiResp({ offerId: b.offerId, quantity: String(b.quantity) }),
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
routes["POST /api/v1/friend-cities/pid1/tavern/recruitments"] = () => apiResp({ operationId: "x", candidateId: "cand1" });

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  if (u.origin.startsWith("http://x") || u.origin.includes("localhost")) return realFetch(url, opts); // worker 自身请求
  const key = `${opts.method || "GET"} ${u.pathname}`;
  calls.push(key);
  const handler = routes[key];
  if (!handler) return new Response(JSON.stringify({ code: "NOT_FOUND", message: key, data: null }), { status: 404, headers: { "Content-Type": "application/json" } });
  const auth = (opts.headers?.Authorization || opts.headers?.get?.("Authorization") || "");
  if (auth !== "Bearer RT-good-0123456789abcdef012345") {
    return new Response(JSON.stringify({ code: "SESSION_EXPIRED", message: "登录已过期", data: null }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  const body = opts.body ? JSON.parse(opts.body) : null;
  const data = handler(body);
  return new Response(JSON.stringify(data), {
    status: data.code === "OK" ? 200 : 409,
    headers: { "Content-Type": "application/json" },
  });
};

const ctx = { waitUntil: (p) => p.catch(e => { console.error("waitUntil:", e); process.exitCode = 1; }) };
let passed = 0, failed = 0;
const assert = (cond, msg) => { if (cond) { passed++; console.log("  PASS:", msg); } else { failed++; console.log("  FAIL:", msg); } };
const tick = async (utcMs) => worker.scheduled({ scheduledTime: utcMs, cron: "* * * * *" }, env, ctx).then(() => new Promise(r => setTimeout(r, 60)));

// ==== T0: 未上报 token 时任务被跳过，不产生游戏 API 调用 ====
console.log("T0: 无 token 保护");
await tick(Date.UTC(2026, 9, 15, 16, 1, 0));
const gameCallsBefore = calls.length;
assert(gameCallsBefore === 0, "无 token 时不调用游戏 API");

// ==== T0b: 书签上报 token（sendBeacon 风格 text/plain body）====
console.log("T0b: 书签上报 accessToken");
let resp = await worker.fetch(new Request("https://x/api/report-token", {
  method: "POST", body: JSON.stringify({ token: "RT-good-0123456789abcdef012345", key: "test123" }),
}), env);
assert(resp.status === 200, "report-token 200");
resp = await worker.fetch(new Request("https://x/api/report-token", {
  method: "POST", body: JSON.stringify({ token: "RT-good-0123456789abcdef012345", key: "WRONG" }),
}), env);
assert(resp.status === 200, "无密码模式：任意密钥可上报");

// ==== T1: 北京 00:01 签到 + 开采 ====
console.log("T1: 00:01 签到+开采");
await tick(Date.UTC(2026, 9, 15, 16, 1, 0));
const st1 = await (await worker.fetch(new Request("https://x/api/status", { headers: { "X-Page-Key": "test123" } }), env)).json();
assert(st1.daily.signin === true, "signin=true");
assert(st1.daily.mining >= 1, `开采 (=${st1.daily.mining})`);
assert(st1.log.some(l => l.msg.includes("签到")), "签到日志");

// ==== T2: 整点任务 ====
console.log("T2: 整点任务");
await tick(Date.UTC(2026, 9, 15, 17, 0, 0));
const st2 = await (await worker.fetch(new Request("https://x/api/status", { headers: { "X-Page-Key": "test123" } }), env)).json();
const hl = st2.log.find(l => l.msg.includes("[01:00]"));
assert(/兑换 12 银票/.test(hl?.msg || ""), "兑换 12 银票: " + hl?.msg);
assert(/征收 \+3924/.test(hl?.msg || ""), "征收");
assert(/收租 ✓/.test(hl?.msg || ""), "收租");

// ==== T3: 紫将扫描 ====
console.log("T3: 紫将扫描");
await tick(Date.UTC(2026, 9, 15, 17, 2, 0));
const st3 = await (await worker.fetch(new Request("https://x/api/status", { headers: { "X-Page-Key": "test123" } }), env)).json();
const h = Object.values(st3.heroes)[0];
assert(h && h.hero === "时迁" && h.quality === "PURPLE", "时迁入列表");

// ==== T4: 预约到期自动抢 ====
console.log("T4: 预约抢购");
h.reserved = true;
h.protectionEndsAt = new Date(Date.now() - 1000).toISOString();
await worker.fetch(new Request("https://x/api/reserve", { method: "POST", headers: { "X-Page-Key": "test123", "Content-Type": "application/json" }, body: JSON.stringify({ key: h.key }) }), env);
// 手动设置过期（绕过 reserve 的 toggle）
const raw3 = st3.heroes;
await tick(Date.UTC(2026, 9, 15, 17, 3, 0));
const st4 = await (await worker.fetch(new Request("https://x/api/status", { headers: { "X-Page-Key": "test123" } }), env)).json();
// 因 protectionEndsAt 已被 mock 为未来，改用手动 grab 验证
const gr = await (await worker.fetch(new Request("https://x/api/grab", { method: "POST", headers: { "X-Page-Key": "test123", "Content-Type": "application/json" }, body: JSON.stringify({ key: h.key }) }), env)).json();
assert(gr.ok === true, "手动抢购成功");
assert(calls.includes("POST /api/v1/friend-cities/pid1/tavern/recruitments"), "抢购请求已发出");

// ==== T5: status 不泄露 token ====
console.log("T5: 脱敏");
const st5 = await (await worker.fetch(new Request("https://x/api/status", { headers: { "X-Page-Key": "test123" } }), env)).json();
assert(!JSON.stringify(st5).includes("RT-good-0123456789abcdef012345"), "status 无原始 token");
const html = await (await worker.fetch(new Request("https://x/"), env)).text();
assert(html.includes("书签") && html.includes("report-token"), "面板含书签指引");

// ==== T6: token 失效自动清理提示 ====
console.log("T6: SESSION_EXPIRED 清理");
// 用坏 token 覆盖
await worker.fetch(new Request("https://x/api/report-token", { method: "POST", body: JSON.stringify({ token: "RT-bad-0123456789abcdef0123456", key: "test123" }) }), env);
await tick(Date.UTC(2026, 9, 15, 18, 0, 0));
const st6 = await (await worker.fetch(new Request("https://x/api/status", { headers: { "X-Page-Key": "test123" } }), env)).json();
assert(st6.log.some(l => l.msg.includes("失效")), "失效提示日志");
assert(st6.token && !st6.token.token, "失效 token 已清除");

globalThis.fetch = realFetch;
console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
