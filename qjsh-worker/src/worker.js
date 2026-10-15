// Q将水浒 自动化 Worker（accessToken 模式）
//
// 认证：不做账密登录（避免顶掉手机会话）。accessToken 由「书签」在游戏页面里
//       捕获并上报到 POST /api/report-token，之后所有任务复用该 token。
//       手机重新进入游戏会换新 token（旧的失效），面板会提示重新点一次书签。
//
// 调度（北京时间 = UTC+8，由每分钟 tick 内部判断）：
//   00:01  签到（7日 + 月）并启动矿山开采计划（~30s 间隔共 10 次，失败下一 tick 续采）
//   整点    兑换 12 银票（粮草不足则全部）+ 征收市场 + 收取驻守城池铜钱
//   每 5 分钟 轮询公告（TAVERN_APPEARANCE 30 分钟时效），跟踪存活紫将
//   每 1 分钟 检查预约抢购，保护期结束立刻抢；网页在线时浏览器 10s 轮询双保险
//
// 存储：绑定 QJSH_KV 则持久化（wrangler.toml 配置）；未绑定时用内存降级
//      （实例重启后丢失 token/监控列表，需重新点书签上报）。

const API = "https://service.qjsh.top";
const TZ_OFFSET_MS = 8 * 3600 * 1000; // 北京时间

const PURPLE_PLUS = ["PURPLE", "ORANGE"];  // 紫将+橙将
const EXCHANGE_TIERS = [8, 5, 1];       // 凑 12 银票的贪心档位
const DAILY_MINING = 10;
const LOG_MAX = 300;
const NO_TOKEN_WARN_MS = 3600_000;      // 无 token 提示限频 1 小时

// ---------- 存储：KV 优先，内存降级 ----------

const mem = globalThis.__QJSH_MEM__ ?? (globalThis.__QJSH_MEM__ = new Map());

const store = {
  async get(env, key) {
    if (env.QJSH_KV) { const v = await env.QJSH_KV.get(key); if (v !== null) return v; return mem.has(key) ? mem.get(key) : null; }
    return mem.get(key) ?? null;
  },
  async put(env, key, value) {
    mem.set(key, value);
    if (env.QJSH_KV) await env.QJSH_KV.put(key, value);
  },
};

async function load(env, key, fallback) {
  const v = await store.get(env, key);
  if (v == null) return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}

async function save(env, key, value) {
  await store.put(env, key, JSON.stringify(value));
}

async function addLog(env, msg, level = "info") {
  const log = await load(env, "log", []);
  log.unshift({ t: new Date().toISOString(), msg, level });
  if (log.length > LOG_MAX) log.length = LOG_MAX;
  await save(env, "log", log);
}

// ---------- accessToken 管理 ----------

async function readToken(env) {
  const st = await load(env, "token", {});
  if (!st.token || Date.now() > (st.expiresAt || 0)) return null;
  return st.token;
}

async function reportToken(env, token) {
  // accessToken 有效期 7 天（enter 响应 expiresAt）；这里保守按 6 天
  await save(env, "token", {
    token, reportedAt: new Date().toISOString(),
    expiresAt: Date.now() + 6 * 86400_000,
  });
}

// 无 token / token 失效的提示（限频，避免每分钟刷日志）
async function warnOnce(env, cacheKey, msg) {
  const flags = await load(env, "warnFlags", {});
  if (flags[cacheKey] && Date.now() - flags[cacheKey] < NO_TOKEN_WARN_MS) return;
  flags[cacheKey] = Date.now();
  await save(env, "warnFlags", flags);
  await addLog(env, msg, "warn");
}

// 带失效处理的调用：fn(token) → SESSION_EXPIRED 时清 token 并提示重新上报
async function withSession(env, fn) {
  const token = await readToken(env);
  if (!token) {
    await warnOnce(env, "noToken", "尚无 accessToken：请在手机游戏页面点一下书签上报（见面板顶部说明）");
    throw Object.assign(new Error("NO_TOKEN"), { code: "NO_TOKEN" });
  }
  try {
    return await fn(token);
  } catch (e) {
    if (e.code === "SESSION_EXPIRED" || e.code === "SESSION_REPLACED" || e.status === 401) {
      await save(env, "token", {});  // 清除失效 token
      await addLog(env, "accessToken 已失效（手机端重新进过游戏？）——请重新点书签上报", "warn");
    }
    throw e;
  }
}

async function api(method, path, { token, body } = {}) {
  const headers = { "Accept": "application/json", "User-Agent": "Mozilla/5.0" };
  if (token) headers["Authorization"] = "Bearer " + token;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const resp = await fetch(API + path, {
    method, headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let payload;
  try { payload = await resp.json(); }
  catch { throw new Error(`${method} ${path} -> HTTP ${resp.status} 非JSON`); }
  if (payload.code !== "OK") {
    const err = new Error(`${method} ${path} -> ${payload.code}: ${payload.message}`);
    err.code = payload.code; err.status = resp.status;
    throw err;
  }
  return payload.data;
}

// ---------- 每日任务 ----------

async function jobSignIn(env) {
  const results = [];
  try {
    await withSession(env, async (token) => {
      const s = await api("GET", "/api/v1/login-rewards", { token });
      const day = s.days?.find(d => d.status === "AVAILABLE" || d.status === "CLAIMABLE");
      if (!day) { results.push("7日签到: 今日已签"); }
      else {
        await api("POST", "/api/v1/login-rewards/claims", {
          token, body: { operationId: opId(), day: day.day, cycleId: s.cycleId, expectedVersion: s.version },
        });
        results.push(`7日签到: 第${day.day}天 ✓`);
      }
    });
  } catch (e) { results.push(`7日签到失败: ${e.code || e.message}`); }
  try {
    await withSession(env, async (token) => {
      const s = await api("GET", "/api/v1/monthly-login-rewards", { token });
      const claimable = (s.days || []).some(d => d.status === "AVAILABLE" || d.status === "CLAIMABLE");
      if (!claimable) { results.push("月签到: 今日已签"); return; }
      await api("POST", "/api/v1/monthly-login-rewards/claims", {
        token, body: { operationId: opId(), monthId: s.monthId, expectedVersion: s.version, mode: "ALL", day: null },
      });
      results.push("月签到: ✓");
    });
  } catch (e) { results.push(`月签到失败: ${e.code || e.message}`); }
  return results;
}

const opId = () => crypto.randomUUID();

// 开采 1 次；返回 "OK" | "DONE"(今日满) | "COOLDOWN" | 抛错
async function mineOnce(env) {
  try {
    return await withSession(env, async (token) => {
      await api("POST", "/api/v1/home/mining-collections", { token, body: { operationId: opId() } });
      return "OK";
    });
  } catch (e) {
    if (e.code === "HOME_MINING_DAILY_LIMIT") return "DONE";
    if (e.code === "HOME_MINING_COOLDOWN") return "COOLDOWN";
    throw e;
  }
}

// 玩家活跃检测：操作版本指纹（排除被动变化：粮草恢复、市场/租金累积不进版本号）
const ACTIVITY_TIMEOUT_MS = 10 * 60_000;   // 10 分钟无操作 = 判定下线
const SELF_ACTION_GRACE_MS = 2 * 60_000;   // Worker 自己写操作后的宽限

function activityFingerprint(home) {
  const v = (code) => home.economy.currencies.find(c => c.code === code)?.version ?? 0;
  return [
    home.player.progressVersion,
    v("COPPER"), v("YUANBAO"), v("SILVER_TICKET"), v("BATTLE_ACHIEVEMENT"),
    home.mining?.version ?? 0,
    home.occupation?.version ?? 0,
    home.marketCollection?.version ?? 0,
  ].join("|");
}

// 每分钟 tick 调用：采样 + 更新活跃状态；返回 true=玩家活跃（近10分钟有操作）
async function trackActivity(env, home) {
  const fp = activityFingerprint(home);
  const st = await load(env, "activity", {});
  const now = Date.now();
  const prev = st.fingerprint;
  st.fingerprint = fp;
  if (prev !== undefined && prev !== fp) {
    // Worker 自己写操作后的宽限期内变化不计
    if (!st.lastSelfActionAt || now - st.lastSelfActionAt > SELF_ACTION_GRACE_MS) {
      if (!st.lastActiveAt || now - st.lastActiveAt > ACTIVITY_TIMEOUT_MS) {
        await addLog(env, "检测到玩家活跃（手机操作中），自动暂停消耗性任务", "warn");
      }
      st.lastActiveAt = now;
    }
  }
  st.active = !!st.lastActiveAt && (now - st.lastActiveAt < ACTIVITY_TIMEOUT_MS);
  await save(env, "activity", st);
  return st.active;
}

// Worker 写操作完成后调用（宽限自身造成的版本变化）
async function markSelfAction(env) {
  const st = await load(env, "activity", {});
  st.lastSelfActionAt = Date.now();
  await save(env, "activity", st);
}

// 刷新快照（60 秒节流；force=true 跳过节流）
async function refreshSnapshot(env, force = false) {
  try {
    const meta = await load(env, "snapMeta", {});
    if (!force && Date.now() - (meta.at || 0) < 60_000) return;
    await withSession(env, async (token) => {
      const home = await api("GET", "/api/v1/home", { token });
      await writeSnapshot(env, token, home);
    });
    await save(env, "snapMeta", { at: Date.now() });
  } catch (e) { /* 刷新失败不影响主流程 */ }
}

// 快照：账号 + 货币 + 武将容量（tavern 接口）
async function writeSnapshot(env, token, home) {
  let heroCapacity = null;
  try {
    const t = await api("GET", "/api/v1/tavern", { token });
    heroCapacity = { capacity: t.heroCapacity, owned: t.ownedHeroCount, remaining: t.remainingHeroCapacity };
  } catch (e) { /* 容量拉取失败不阻断 */ }
  await save(env, "snapshot", {
    at: new Date().toISOString(),
    player: { displayName: home.player.displayName, level: home.player.level,
              combatPower: home.player.combatPower, provisionsCapacity: home.player.provisionsCapacity },
    currencies: home.economy.currencies,
    mining: home.mining,
    heroCapacity,
  });
}

async function jobHourly(env) {
  const out = [];
  try {
    await withSession(env, async (token) => {
      const home = await api("GET", "/api/v1/home", { token });
      const prov = home.economy.currencies.find(c => c.code === "PROVISIONS")?.balance ?? 0;
      const copper = home.economy.currencies.find(c => c.code === "COPPER")?.balance ?? 0;

      // --- 兑换银票：贪心凑 12，不足则全部 ---
      let budget = Math.min(12, prov);
      const plan = {};
      for (const t of EXCHANGE_TIERS) while (budget >= t) { plan[t] = (plan[t] || 0) + 1; budget -= t; }
      const tickets = Object.entries(plan).reduce((s, [t, n]) => s + t * n, 0);
      const copperNeed = tickets * 100;
      if (tickets > 0 && copper >= copperNeed) {
        for (const [t, n] of Object.entries(plan)) {
          await api("POST", "/api/v1/home/market/exchanges", {
            token, body: { operationId: opId(), offerId: `MARKET_EXCHANGE_${t}`, quantity: n },
          });
        }
        out.push(`兑换 ${tickets} 银票 (-${copperNeed}铜 -${tickets}粮草)`);
      } else if (tickets > 0) {
        out.push(`兑换跳过: 需${copperNeed}铜 仅有${copper}`);
      } else {
        out.push(`兑换跳过: 粮草 ${prov} 点`);
      }

      // --- 征收市场 ---
      const market = await api("GET", "/api/v1/home/market", { token });
      if (market.collectionStatus === "READY") {
        const r = await api("POST", "/api/v1/home/market/collections", {
          token, body: { operationId: opId(), expectedVersion: market.version },
        });
        out.push(`征收 +${r.collectedCopper} 铜`);
      } else {
        out.push(`征收: ${market.collectionStatus}`);
      }

      // --- 收取驻守城池租金 ---
      const occ = home.occupation;
      if (occ?.status === "GARRISONED" || occ?.rent?.availableCopper > 0) {
        const r = await api("POST", "/api/v1/home/garrison/rent-collections", {
          token, body: { operationId: opId(), expectedVersion: occ.version },
        });
        out.push(`收租 ✓`);
      } else {
        out.push("收租: 未驻守或无可收");
      }

      await writeSnapshot(env, token, home);
    });
  } catch (e) { out.push(`失败: ${e.code || e.message}`); }
  return out;
}

// ---------- 紫将监控与抢购 ----------

function parseAppearance(text) {
  // 【酒馆消息】飞天龙的酒馆出现了4星紫将【时迁】，快去参观吧！
  const m = text.match(/【酒馆消息】(.+?)的酒馆出现了(\d+)星(紫|橙)将【(.+?)】/);
  return m ? { owner: m[1], star: +m[2], qualityName: m[3], hero: m[4] } : null;
}

async function jobPurpleScan(env) {
  const found = [];
  try {
    await withSession(env, async (token) => {
      const ann = await api("GET", "/api/v1/home-announcements", { token });
      const appearances = (ann.entries || [])
        .map(e => ({ ...parseAppearance(e.content || ""), at: e.startsAt }))
        .filter(x => x.owner);

      const pcache = await load(env, "playerCache", {});
      const heroes = await load(env, "purpleHeroes", {});

      for (const a of appearances) {
        try {
          if (!pcache[a.owner]) {
            const s = await api("GET", `/api/v1/player-search?type=NAME&query=${encodeURIComponent(a.owner)}`, { token });
            const p = (s.players || [])[0];
            if (!p) continue;
            pcache[a.owner] = { playerId: p.playerId, shortId: p.shortId, level: p.level };
          }
          const pid = pcache[a.owner].playerId;
          const key = `${pid}:${a.hero}`;
          if (heroes[key]?.status === "GRABBED") continue;

          const t = await api("GET", `/api/v1/friend-cities/${pid}/tavern`, { token });
          const cand = (t.candidates || []).find(c => c.name === a.hero && PURPLE_PLUS.includes(c.quality));
          if (cand) {
            heroes[key] = {
              ...heroes[key],  // 保留 reserved 等字段
              key, playerId: pid, owner: a.owner, ownerLevel: pcache[a.owner].level,
              hero: a.hero, quality: cand.quality, star: cand.star, troopType: cand.troopType,
              copperCost: cand.copperCost, silverTicketCost: cand.silverTicketCost,
              candidateId: cand.candidateId, candidateVersion: cand.version,
              foundAt: a.at, protectionEndsAt: t.protectionEndsAt,
              lastSeenAt: new Date().toISOString(), status: "ALIVE",
            };
            found.push(`${a.owner}家 ${a.hero}(${cand.quality}${cand.star}星)`);
          } else if (heroes[key]?.status === "ALIVE") {
            delete heroes[key];
          }
        } catch (e) { /* 单条失败不影响其他 */ }
      }

      // 存活复核
      for (const [key, h] of Object.entries(heroes)) {
        if (h.status !== "ALIVE") continue;
        if (found.some(f => f.includes(h.hero) && f.includes(h.owner))) continue;
        try {
          const t = await api("GET", `/api/v1/friend-cities/${h.playerId}/tavern`, { token });
          const cand = (t.candidates || []).find(c => c.candidateId === h.candidateId);
          if (!cand) { delete heroes[key]; continue; }
          else {
            h.candidateVersion = cand.version;
            h.protectionEndsAt = t.protectionEndsAt;
            h.lastSeenAt = new Date().toISOString();
          }
        } catch (e) { /* 忽略 */ }
      }

      await save(env, "playerCache", pcache);
      await save(env, "purpleHeroes", heroes);
    });
  } catch (e) {
    if (e.code !== "NO_TOKEN") await addLog(env, `紫将扫描失败: ${e.code || e.message}`, "error");
    return found;
  }
  return found;
}

async function grabHero(env, key, manual = false) {
  const heroes = await load(env, "purpleHeroes", {});
  const h = heroes[key];
  if (!h) return { ok: false, msg: "目标不存在" };
  if (h.status === "GRABBED") return { ok: false, msg: "已抢购成功" };
  // 武将位满员预检（快照容量；remaining<=0 拒绝）
  const cap = (await load(env, "snapshot", {})).heroCapacity;
  if (cap && cap.remaining <= 0) {
    const msg = `武将位已满（${cap.owned}/${cap.capacity}），请先解雇或提取武魂腾出位置`;
    if (!manual) await warnOnce(env, "capFull", "抢购跳过: " + msg);
    return { ok: false, msg };
  }

  try {
    await withSession(env, async (token) => {
      const t = await api("GET", `/api/v1/friend-cities/${h.playerId}/tavern`, { token });
      const cand = (t.candidates || []).find(c => c.name === h.hero && PURPLE_PLUS.includes(c.quality));
      if (!cand) throw Object.assign(new Error("武将已不在卡池"), { code: "GONE" });
      h.candidateId = cand.candidateId;
      h.candidateVersion = cand.version;
      await api("POST", `/api/v1/friend-cities/${h.playerId}/tavern/recruitments`, {
        token, body: { operationId: opId(), candidateId: h.candidateId, expectedCandidateVersion: h.candidateVersion },
      });
      h.status = "GRABBED";
      h.grabbedAt = new Date().toISOString();
      await markSelfAction(env);
    });
    heroes[key] = h;
    await save(env, "purpleHeroes", heroes);
    await addLog(env, `🎉 抢购成功: ${h.owner}家 ${h.hero}(${h.quality}${h.star}星)`, "success");
    return { ok: true, msg: `已抢到 ${h.hero}` };
  } catch (e) {
    if (e.code === "GONE") {
      delete heroes[key]; await save(env, "purpleHeroes", heroes);
      await addLog(env, `抢购失败: ${h.hero} 已不在卡池`, "warn");
      return { ok: false, msg: "武将已不在卡池" };
    }
    await addLog(env, `抢购失败(${h.hero}): ${e.code || e.message}`, "error");
    return { ok: false, msg: e.message };
  }
}

async function checkReservations(env) {
  const heroes = await load(env, "purpleHeroes", {});
  const now = Date.now();
  for (const [key, h] of Object.entries(heroes)) {
    if (h.status !== "ALIVE" || !h.reserved) continue;
    if (now >= Date.parse(h.protectionEndsAt)) {
      await grabHero(env, key);
    }
  }
}

// ---------- 调度 ----------

function bj(dateMs) {
  const d = new Date(dateMs + TZ_OFFSET_MS);
  return {
    date: d.toISOString().slice(0, 10),
    hour: d.getUTCHours(), minute: d.getUTCMinutes(),
  };
}

async function scheduled(event, env, ctx) {
  const { date, hour, minute } = bj(event.scheduledTime || Date.now());
  const daily = await load(env, "daily", {});
  if (daily.date !== date) {
    Object.assign(daily, { date, signin: false, mining: 0, hourly: {} });
    await save(env, "daily", daily);
  }

  // 无 token 时跳过全部任务（避免每分钟空转刷日志），保留整点标记
  const token = await readToken(env);
  if (!token) {
    await warnOnce(env, "noToken", "尚无 accessToken：请在手机游戏页面点一下书签上报（见面板顶部说明）");
    return;
  }
  // 每分钟采样：快照 + 玩家活跃检测
  let playerActive = false;
  try {
    const homeNow = await withSession(env, async (token) => {
      const h = await api("GET", "/api/v1/home", { token });
      await writeSnapshot(env, token, h);
      return h;
    });
    playerActive = await trackActivity(env, homeNow);
  } catch (e) { /* 采样失败不阻断 */ }

  // 手动暂停 或 玩家活跃：跳过一切写操作（签到/开采/整点/抢购），只保留只读扫描
  const manualPaused = (await load(env, "paused", false)) === true;
  if (manualPaused || playerActive) {
    if (minute % 5 === 2) {
      const found0 = await jobPurpleScan(env);
      for (const f of found0) await addLog(env, `发现紫将(暂停中仅记录): ${f}`, "success");
    }
    return;
  }

  try {
    if (hour === 0 && minute === 1 && !daily.signin) {
      const r = await jobSignIn(env);
      await addLog(env, `签到: ${r.join("; ")}`);
      daily.signin = true; await save(env, "daily", daily);
    }

    if (hour === 0 && minute >= 1 && minute <= 30 && daily.mining < DAILY_MINING) {
      const r = await mineOnce(env);
      if (r === "OK") {
        await markSelfAction(env);
        daily.mining++;
        await save(env, "daily", daily);
        if (daily.mining === DAILY_MINING) await addLog(env, "矿山: 今日 10 次开采完成");
      } else if (r === "DONE") {
        daily.mining = DAILY_MINING; await save(env, "daily", daily);
        await addLog(env, "矿山: 次数已用完（可能在游戏内已采）");
      } else if (r === "COOLDOWN") {
        await new Promise(res => setTimeout(res, 30_000));
        const r2 = await mineOnce(env);
        if (r2 === "OK") { await markSelfAction(env); daily.mining++; await save(env, "daily", daily); }
        else if (r2 === "DONE") { daily.mining = DAILY_MINING; await save(env, "daily", daily); }
      }
    }

    if (minute === 0 && !daily.hourly[hour]) {
      const r = await jobHourly(env);
      await markSelfAction(env);
      daily.hourly[hour] = true; await save(env, "daily", daily);
      await addLog(env, `[${String(hour).padStart(2, "0")}:00] ${r.join("; ")}`);
    }

    if (minute % 5 === 2) {
      const found = await jobPurpleScan(env);
      for (const f of found) await addLog(env, `发现紫将: ${f}`, "success");
    }

    await checkReservations(env);
  } catch (e) {
    if (e.code !== "NO_TOKEN") await addLog(env, `调度异常: ${e.code || e.message}`, "error");
  }
}

// ---------- Web ----------

const PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Q将水浒 · 自动化面板</title><style>
:root{--bg:#0f1420;--card:#1a2233;--line:#2a3550;--txt:#e8ecf4;--dim:#8a94ab;--acc:#4f8cff;--ok:#3fb96f;--warn:#e6a23c;--err:#e5646c;--purple:#a875ff}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--txt);font:14px/1.6 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;padding:16px;max-width:860px;margin:0 auto}
h1{font-size:18px;margin-bottom:12px;display:flex;align-items:center;gap:8px}
h1 .dot{width:8px;height:8px;border-radius:50%;background:var(--ok)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:14px}
.card h2{font-size:14px;color:var(--dim);font-weight:600;margin-bottom:10px;text-transform:uppercase;letter-spacing:.5px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}
.kv{display:flex;justify-content:space-between;padding:6px 10px;background:#131a29;border-radius:8px;font-size:13px}
.kv b{color:var(--acc)}
.cur{display:flex;gap:14px;flex-wrap:wrap;font-size:13px}
.cur span b{font-size:16px}
.log{max-height:340px;overflow-y:auto;font-size:12.5px}
.log div{padding:4px 0;border-bottom:1px solid #202a40;display:flex;gap:8px}
.log time{color:var(--dim);flex-shrink:0;font-variant-numeric:tabular-nums}
.lv-success{color:var(--ok)}.lv-error{color:var(--err)}.lv-warn{color:var(--warn)}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{padding:8px 6px;text-align:left;border-bottom:1px solid var(--line)}
th{color:var(--dim);font-weight:500;font-size:12px}
.q{padding:1px 6px;border-radius:4px;font-size:11px;font-weight:600}
.q-PURPLE{background:#3d2b66;color:#c9a6ff}.q-ORANGE{background:#4d3010;color:#ffc46b}
.st-ALIVE{color:var(--ok)}.st-GONE{color:var(--dim)}.st-GRABBED{color:var(--acc)}
button{background:var(--acc);color:#fff;border:0;border-radius:8px;padding:6px 12px;font-size:13px;cursor:pointer}
button.ghost{background:transparent;border:1px solid var(--line);color:var(--txt)}
button.warn{background:var(--warn)}button:disabled{opacity:.4;cursor:default}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.cd{font-variant-numeric:tabular-nums;color:var(--warn)}
.muted{color:var(--dim);font-size:12px}
.tag{font-size:11px;color:var(--dim)}
#toast{position:fixed;top:12px;left:50%;transform:translateX(-50%);background:#2a3550;border:1px solid var(--acc);color:#fff;padding:8px 16px;border-radius:8px;font-size:13px;z-index:99;display:none;max-width:90%;box-shadow:0 4px 16px rgba(0,0,0,.4)}
#tokbanner{border-color:var(--warn)}
#tokbanner .code{background:#0c111c;border:1px dashed var(--line);border-radius:8px;padding:8px;margin-top:8px;font-size:11px;word-break:break-all;font-family:monospace;max-height:90px;overflow:auto}
#tokbanner ol{margin:6px 0 0 18px;font-size:12.5px}
</style></head><body>
<div id="toast"></div>
<h1><span class="dot" id="hdot"></span>Q将水浒 · 自动化面板 <span class="tag" id="hserver"></span><button id="sndbtn" class="ghost" style="padding:2px 8px;margin-left:auto;font-size:15px" onclick="toggleSnd()">🔔</button></h1>
<div class="card" id="tokbanner" hidden>
  <h2>尚未上报 accessToken</h2>
  <ol>
    <li>把下面的代码添加为浏览器<b>书签</b>（名称随意，网址粘贴代码）</li>
    <li>手机打开游戏 qjsh.top 并进入（已登录状态）</li>
    <li>点一下该书签，再在游戏里<b>点击任意操作</b>（或等待心跳）即完成上报</li>
  </ol>
  <div class="code" id="bmcode"></div>
  <button class="ghost" onclick="copyBM()" style="margin-top:8px">复制书签代码</button>
</div>
<div class="card"><h2>账号</h2><div id="player" class="muted">加载中…</div><div class="cur" id="cur" style="margin-top:8px"></div></div>
<div class="card"><h2>今日任务</h2><div class="grid" id="daily"></div>
  <div class="row" style="margin-top:10px">
    <button class="ghost" onclick="job('signin')">立即签到</button>
    <button class="ghost" onclick="job('hourly')">立即整点任务</button>
    <button class="ghost" onclick="job('mine')">开采一次</button>
    <button class="ghost" onclick="job('scan')">扫描紫将</button>
    <button id="pauser" class="ghost" onclick="togglePause()">暂停自动化</button>
  </div></div>
<div class="card"><h2>紫将监控 <span class="tag">公告每5分钟轮询</span> <span class="tag" id="herocap"></span></h2>
  <div id="heroes"><p class="muted">暂无存活紫将</p></div></div>
<div class="card"><h2>日志</h2><div class="log" id="log"></div></div>
<script>
const KEY='';
const ORIGIN=location.origin;
const $=id=>document.getElementById(id);
function toast(t,ok){var e=$('toast');e.textContent=t;e.style.display='block';e.style.borderColor=ok===false?'var(--err)':'var(--acc)';clearTimeout(window.__tt);window.__tt=setTimeout(function(){e.style.display='none'},4000)}
let audioCtx=null,soundOn=localStorage.getItem('snd')!=='0';
function unlockAudio(){try{audioCtx=audioCtx||new (window.AudioContext||window.webkitAudioContext)();audioCtx.resume()}catch(e){}}
document.addEventListener('pointerdown',unlockAudio,{once:true});
function beep(){if(!soundOn)return;try{unlockAudio();if(!audioCtx||audioCtx.state!=='running')return;var t=audioCtx.currentTime;[[880,0],[1174,0.16],[1568,0.32]].forEach(function(fd){var o=audioCtx.createOscillator(),g=audioCtx.createGain();o.type='sine';o.frequency.value=fd[0];o.connect(g);g.connect(audioCtx.destination);g.gain.setValueAtTime(0.0001,t+fd[1]);g.gain.exponentialRampToValueAtTime(0.25,t+fd[1]+0.02);g.gain.exponentialRampToValueAtTime(0.0001,t+fd[1]+0.45);o.start(t+fd[1]);o.stop(t+fd[1]+0.5)})}catch(e){}}
function toggleSnd(){soundOn=!soundOn;localStorage.setItem('snd',soundOn?'1':'0');$('sndbtn').textContent=soundOn?'🔔':'🔕';$('sndbtn').style.opacity=soundOn?'1':'0.5';if(soundOn){unlockAudio();beep()}}
const BM='javascript:(function(){var W=\\''+ORIGIN+'\\';function arm(){window.__qjsh=1;var F=window.fetch,X=XMLHttpRequest.prototype.open,S=XMLHttpRequest.prototype.setRequestHeader;function ok(t){try{navigator.sendBeacon(W+\\'/api/report-token\\',JSON.stringify({token:t}))}catch(e){}window.fetch=F;XMLHttpRequest.prototype.setRequestHeader=S;XMLHttpRequest.prototype.open=X;window.__qjsh=2}window.fetch=function(i,o){try{var u=\\'\\'+(i&&i.url||i);var h=(o&&o.headers)||(i&&i.headers),a=h&&(h.Authorization||(h.get&&h.get(\\'Authorization\\')));if(a&&u.indexOf(\\'/auth/\\')<0)ok(String(a).replace(\\'Bearer \\',\\'\\'))}catch(e){}return F.apply(this,arguments)};XMLHttpRequest.prototype.open=function(m,u){this.__u=u;return X.apply(this,arguments)};XMLHttpRequest.prototype.setRequestHeader=function(k,v){try{if(String(k).toLowerCase()==\\'authorization\\'&&v&&(\\'\\'+this.__u).indexOf(\\'/auth/\\')<0)ok(String(v).replace(\\'Bearer \\',\\'\\'))}catch(e){}return S.apply(this,arguments)}}if(window.__qjsh===1)return alert(\\'监听已开启，请在游戏里点任意操作\\');arm();alert(\\'监听已开启：在游戏里点击任意操作（或等几秒），token 会自动上报\\')})()';
async function req(path,opts={}){const r=await fetch('/api/'+path,{...opts,headers:{'Content-Type':'application/json',...(opts.headers||{})}});return r.json()}
function copyBM(){var t=$('bmcode').textContent||BM;function ok(){toast('已复制！去浏览器「添加书签」，把网址替换为这段代码')}function fb(){var ta=document.createElement('textarea');ta.value=t;ta.style.cssText='position:fixed;top:0;left:0;opacity:0';document.body.appendChild(ta);ta.focus();ta.select();ta.setSelectionRange(0,t.length);var s=false;try{s=document.execCommand('copy')}catch(e){}document.body.removeChild(ta);s?ok():prompt('复制失败，请长按下面文本框手动复制:',t)}if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(ok,fb)}else{fb()}}
const CUR={COPPER:'铜钱',YUANBAO:'元宝',SILVER_TICKET:'银票',PROVISIONS:'粮草',BATTLE_ACHIEVEMENT:'战功'};
function fmt(n){return (+n).toLocaleString('zh-CN')}
function fmtBJ(iso){var d=new Date(iso);if(isNaN(d))return '';d=new Date(d.getTime()+8*3600e3);var p=x=>String(x).padStart(2,'0');return p(d.getUTCMonth()+1)+'-'+p(d.getUTCDate())+' '+p(d.getUTCHours())+':'+p(d.getUTCMinutes())}
function cd(iso){const s=Math.floor((new Date(iso)-Date.now())/1000);return s>0?Math.floor(s/60)+'分'+String(s%60).padStart(2,'0')+'秒':'已结束'}
const inflight=new Set();
let knownHeroKeys=null;
async function render(){
  try{
    const s=await req('status');
    const hasTok=!!(s.token&&s.token.hasToken);
    $('tokbanner').hidden=hasTok;
    if(!hasTok)$('bmcode').textContent=BM;
    $('hserver').textContent=hasTok?('token '+fmtBJ(s.token.reportedAt)+' 上报'):'';
    $('hdot').style.background=hasTok?'var(--ok)':'var(--err)';
    if(s.snapshot?.player){const p=s.snapshot.player;$('player').innerHTML='<b>'+p.displayName+'</b> Lv'+p.level+' · 战力 '+fmt(p.combatPower||0)}else if(s.token&&s.token.token){$('player').textContent='token 已生效，账号数据将在整点任务时刷新'}
    $('cur').innerHTML=(s.snapshot?.currencies||[]).filter(c=>c.code!=='PROVISIONS').map(c=>'<span>'+(CUR[c.code]||c.code)+' <b>'+fmt(c.balance)+'</b></span>').join('');
    const d=s.daily||{signin:false,mining:0,hourly:{}};
    const hrs=Object.keys(d.hourly||{}).length;
    const provC=(s.snapshot?.currencies||[]).find(c=>c.code==='PROVISIONS');
    const provNow=provC?provC.balance:'-';
    const provCap=s.snapshot?.player?.provisionsCapacity??'-';
    window.__cap=s.snapshot?.heroCapacity||null;
    $('sndbtn').textContent=soundOn?'🔔':'🔕';$('sndbtn').style.opacity=soundOn?'1':'0.5';
    const act=s.activity||{};
    $('hserver').textContent=(s.state?.serverId||'')+(act.active?' · 🟢玩家活跃(自动暂停中)':' · ⚪玩家离线(自动运行)');
    window.__paused=!!s.paused;
    $('pauser').textContent=window.__paused?'▶ 恢复自动化':'暂停自动化';
    $('pauser').style.borderColor=window.__paused?'var(--err)':'var(--line)';
    $('pauser').style.color=window.__paused?'var(--err)':'';
    $('herocap').textContent=window.__cap?('武将 '+window.__cap.owned+'/'+window.__cap.capacity+(window.__cap.remaining<=0?' (满)':'')):'';
    $('daily').innerHTML=[
      ['签到',d.signin?'✓ 已完成':'待 00:01'],
      ['矿山',d.mining+'/10 次'],
      ['整点任务',hrs+' 次'],
      ['粮草',provNow+'/'+provCap],
    ].map(([k,v])=>'<div class="kv"><span>'+k+'</span><b>'+v+'</b></div>').join('');
    for(const h of Object.values(s.heroes||{})){
      if(h.reserved&&h.status==='ALIVE'&&new Date(h.protectionEndsAt)<=new Date()&&!inflight.has(h.key)){
        inflight.add(h.key);grab(h.key).finally(()=>inflight.delete(h.key));
      }
    }
    const hs=Object.values(s.heroes||{}).filter(h=>h.status!=='GONE');
    const liveKeys=hs.filter(h=>h.status==='ALIVE').map(h=>h.key);
    if(knownHeroKeys===null){knownHeroKeys=new Set(liveKeys)}
    else{
      for(const k of liveKeys){if(!knownHeroKeys.has(k)){const nh=hs.find(x=>x.key===k);const label=nh?(nh.hero+'('+nh.quality+nh.star+'星 @'+nh.owner+'家)'):k;toast('发现新目标: '+label);beep()}}
      knownHeroKeys=new Set(liveKeys);
    }
    $('heroes').innerHTML=hs.length?('<table><tr><th>武将</th><th>酒馆主人</th><th>成本</th><th>保护期</th><th>状态</th><th></th></tr>'+
      hs.map(h=>{const k=h.key.replace(/"/g,'&quot;');
        const st=h.status==='GRABBED'?'<span class="st-GRABBED">已抢到</span>':h.reserved?'<span class="st-ALIVE">已预约</span>':'';
        const btn=h.status==='GRABBED'?'':h.reserved
          ?'<button class="ghost" onclick="res(\\''+k+'\\')">取消</button> <button class="warn" onclick="grab(\\''+k+'\\')">立即抢</button>'
          :'<button onclick="res(\\''+k+'\\')">预约抢购</button>';
        return '<tr><td><span class="q q-'+h.quality+'">'+(h.quality==='PURPLE'?'紫':'橙')+'</span> '+h.hero+' '+h.star+'星</td><td>'+h.owner+'(Lv'+h.ownerLevel+')</td><td>'+fmt(h.copperCost)+'铜'+(h.silverTicketCost?'+'+h.silverTicketCost+'票':'')+'</td><td><span class="cd">'+cd(h.protectionEndsAt)+'</span></td><td>'+st+'</td><td class="row">'+btn+'</td></tr>'}).join('')+'</table>')
      :'<p class="muted">暂无存活紫将</p>';
    $('log').innerHTML=(s.log||[]).slice(0,120).map(l=>'<div><time>'+fmtBJ(l.t)+'</time><span class="lv-'+l.level+'">'+l.msg+'</span></div>').join('');
  }catch(e){if(e!==0)console.error(e)}
}
async function capFull(){const c=window.__cap;return c&&c.remaining<=0}
async function togglePause(){const r=await req('pause',{method:'POST',body:JSON.stringify({paused:!window.__paused})});render()}
async function res(k){if(capFull()){return toast('武将位已满（'+window.__cap.owned+'/'+window.__cap.capacity+'），请先解雇或提取武魂腾位置，否则到期也抢不了',false)}await req('reserve',{method:'POST',body:JSON.stringify({key:k})});render()}
async function grab(k){if(capFull()){return toast('武将位已满（'+window.__cap.owned+'/'+window.__cap.capacity+'），请先解雇或提取武魂腾位置',false)}const r=await req('grab',{method:'POST',body:JSON.stringify({key:k})});if(!r.ok)toast(r.msg||'抢购失败',false);else toast('已抢到 '+r.msg.replace('已抢到 ',''),true);render()}
async function job(n){const r=await req('job',{method:'POST',body:JSON.stringify({name:n})});const res=r.result;let txt=Array.isArray(res)?res.join('\\n'):(''+res);if(r.found&&r.found.length)txt+='\\n'+r.found.join('\\n');toast(txt||'已执行');setTimeout(render,800)}
render();setInterval(render,10000);
</script></body></html>`;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status, headers: { "Content-Type": "application/json; charset=utf-8" },
  });

async function handleApi(request, env, ctx) {
  const url = new URL(request.url);
  const route = url.pathname.replace(/^\/api\//, "");

  // 书签上报（sendBeacon 发 text/plain 且无法带自定义 header，密钥从 body 取）
  if (route === "report-token" && request.method === "POST") {
    let body;
    try { body = JSON.parse(await request.text()); }
    catch { return json({ error: "bad json" }, 400); }
    if (!body.token || typeof body.token !== "string" || body.token.length < 20) {
      return json({ error: "invalid token" }, 400);
    }
    await reportToken(env, body.token);
    // 立即验证并生成账号快照（面板马上能看到账号信息）
    try {
      const home = await api("GET", "/api/v1/home", { token: body.token });
      await writeSnapshot(env, body.token, home);
      await addLog(env, `accessToken 已上报 ✓ ${home.player.displayName} Lv${home.player.level}（书签）`, "success");
    } catch (e) {
      if (e.code === "SESSION_EXPIRED" || e.code === "SESSION_REPLACED" || e.status === 401) {
        await save(env, "token", {});
        await addLog(env, "上报的 token 无效——请确认游戏已进入（过了登录页）再点书签", "error");
        return json({ ok: false, error: "invalid token" }, 400);
      }
      await addLog(env, "accessToken 已上报 ✓（验证请求延迟，不影响使用）（书签）", "success");
    }
    return json({ ok: true });
  }

  if (route === "status" && request.method === "GET") {
    const [token, daily, heroes, log, snapshot, paused, activity] = await Promise.all([
      load(env, "token", {}), load(env, "daily", {}),
      load(env, "purpleHeroes", {}), load(env, "log", []), load(env, "snapshot", {}),
      load(env, "paused", false), load(env, "activity", {}),
    ]);
    const { token: tok, ...tokenSafe } = token;  // 不向页面暴露凭据
    tokenSafe.hasToken = !!tok;
    const { fingerprint, ...actSafe } = activity;
    return json({ token: tokenSafe, daily, heroes, log, snapshot, paused, activity: actSafe });
  }
  if (route === "reserve" && request.method === "POST") {
    const { key } = await request.json();
    const heroes = await load(env, "purpleHeroes", {});
    if (!heroes[key]) return json({ error: "not found" }, 404);
    heroes[key].reserved = !heroes[key].reserved;
    if (heroes[key].reserved) heroes[key].reservedAt = new Date().toISOString();
    await save(env, "purpleHeroes", heroes);
    await addLog(env, `${heroes[key].reserved ? "预约" : "取消预约"}: ${heroes[key].owner}家 ${heroes[key].hero}`);
    return json({ ok: true, reserved: heroes[key].reserved });
  }
  if (route === "grab" && request.method === "POST") {
    const { key } = await request.json();
    const r = await grabHero(env, key, true);
    return json(r);
  }
  if (route === "pause" && request.method === "POST") {
    const { paused } = await request.json();
    const val = !!paused;
    await save(env, "paused", val);
    await addLog(env, val ? "自动化已暂停（手动操作不受影响）" : "自动化已恢复", val ? "warn" : "success");
    if (val) await refreshSnapshot(env, true);
    return json({ ok: true, paused: val });
  }
  if (route === "job" && request.method === "POST") {
    const { name } = await request.json();
    if (name === "signin") { const r = await jobSignIn(env); const d = await load(env, "daily", {}); d.signin = true; d.date = bj(Date.now()).date; await save(env, "daily", d); await addLog(env, `手动签到: ${r.join("; ")}`); return json({ ok: true, result: r }); }
    if (name === "hourly") { const r = await jobHourly(env); await addLog(env, `手动整点任务: ${r.join("; ")}`); return json({ ok: true, result: r }); }
    if (name === "mine") { const r = await mineOnce(env); if (r === "OK") { const d = await load(env, "daily", {}); d.mining = (d.mining || 0) + 1; await save(env, "daily", d); } await addLog(env, `手动开采: ${r}`); return json({ ok: true, result: r }); }
    if (name === "scan") { const r = await jobPurpleScan(env); for (const f of r) await addLog(env, `发现紫将: ${f}`, "success"); return json({ ok: true, result: [r.length ? ('发现 '+r.length+' 个: '+r.join('; ')) : '无新发现'], found: r }); }
    return json({ error: "unknown job" }, 400);
  }
  return json({ error: "not found" }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env, ctx);
    return new Response(PAGE, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(scheduled(event, env));
  },
};
