// Q将水浒 自动化 Worker
// 调度（北京时间 = UTC+8，由每分钟 tick 内部判断）：
//   00:01  签到（7日 + 月）并开始矿山开采计划（~30s 间隔，共 10 次，失败下一 tick 续采）
//   整点    兑换 12 银票（粮草不足则全部）+ 征收市场 + 收取驻守城池铜钱
//   每 5 分钟 轮询公告（TAVERN_APPEARANCE 30 分钟时效，5 分钟轮询零遗漏），跟踪存活紫将
//   每 1 分钟 检查预约抢购队列，保护期结束立刻抢；网页在线时浏览器秒级触发双保险
//
// 接口格式均逆向自 Web 客户端 /releases/20261015-001/，见 README.md

const API = "https://service.qjsh.top";
const RELEASE_ID = "dy-recharge-prod-water-v1-0.1.0";
const CLIENT_VERSION = "0.1.0";
const DEVICE = "cf-worker-qjsh-01";
const TZ_OFFSET_MS = 8 * 3600 * 1000; // 北京时间

const PURPLE_PLUS = ["PURPLE", "ORANGE"];
const EXCHANGE_TIERS = [8, 5, 1];       // 凑 12 银票的贪心档位
const DAILY_MINING = 10;
const LOG_MAX = 300;

// ---------- 工具 ----------

const opId = () => crypto.randomUUID();

function bj(dateMs) {
  const d = new Date(dateMs + TZ_OFFSET_MS);
  return {
    date: d.toISOString().slice(0, 10),   // 北京日期 YYYY-MM-DD
    hour: d.getUTCHours(), minute: d.getUTCMinutes(),
  };
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

// ---------- 状态存取（KV） ----------

async function load(env, key, fallback) {
  const v = await env.QJSH_KV.get(key);
  if (!v) return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}

async function save(env, key, value) {
  await env.QJSH_KV.put(key, JSON.stringify(value));
}

async function addLog(env, msg, level = "info") {
  const log = await load(env, "log", []);
  log.unshift({ t: new Date().toISOString(), msg, level });
  if (log.length > LOG_MAX) log.length = LOG_MAX;
  await save(env, "log", log);
}

// 登录（两级 token），KV 缓存；SESSION_EXPIRED 时重登一次
async function getToken(env, force = false) {
  const st = await load(env, "state", {});
  if (!force && st.token && Date.now() < (st.tokenExp || 0)) return st.token;
  const acct = await api("POST", "/api/v1/auth/password/login", {
    body: {
      releaseId: RELEASE_ID, clientVersion: CLIENT_VERSION, deviceFingerprint: DEVICE,
      phoneNumber: env.PHONE, password: env.PASSWORD,
    },
  });
  const servers = await api("GET", "/api/v1/auth/servers", { token: acct.accountToken });
  const session = await api("POST", "/api/v1/auth/servers/enter", {
    token: acct.accountToken, body: { serverId: servers.defaultServerId },
  });
  const exp = Date.parse(session.expiresAt) - 10 * 60 * 1000; // 提前 10 分钟视为过期
  await save(env, "state", {
    token: session.accessToken, tokenExp: exp,
    playerId: session.playerId, serverId: session.serverId,
    lastLoginAt: new Date().toISOString(),
  });
  return session.accessToken;
}

// 带会话失效重试的调用
async function withSession(env, fn) {
  let token = await getToken(env);
  try { return await fn(token); }
  catch (e) {
    if (e.code === "SESSION_EXPIRED" || e.status === 401) {
      token = await getToken(env, true);
      return await fn(token);
    }
    throw e;
  }
}

// ---------- 每日任务 ----------

async function jobSignIn(env) {
  const results = [];
  // 7 日签到
  try {
    await withSession(env, async (token) => {
      const s = await api("GET", "/api/v1/login-rewards", { token });
      const day = s.days?.find(d => d.status === "AVAILABLE" || d.status === "CLAIMABLE");
      if (!day) { results.push("7日签到: 今日已签"); return; }
      const r = await api("POST", "/api/v1/login-rewards/claims", {
        token, body: {
          operationId: opId(), day: day.day, cycleId: s.cycleId, expectedVersion: s.version,
        },
      });
      results.push(`7日签到: 第${day.day}天 ✓`);
    });
  } catch (e) { results.push(`7日签到失败: ${e.message}`); }
  // 月签到（ALL = 领取全部可领）
  try {
    await withSession(env, async (token) => {
      const s = await api("GET", "/api/v1/monthly-login-rewards", { token });
      const claimable = (s.days || []).some(d => d.status === "AVAILABLE" || d.status === "CLAIMABLE");
      if (!claimable) { results.push("月签到: 今日已签"); return; }
      await api("POST", "/api/v1/monthly-login-rewards/claims", {
        token, body: {
          operationId: opId(), monthId: s.monthId, expectedVersion: s.version, mode: "ALL", day: null,
        },
      });
      results.push("月签到: ✓");
    });
  } catch (e) { results.push(`月签到失败: ${e.message}`); }
  return results;
}

// 开采 1 次；返回 "OK" | "DONE"(今日满) | 错误信息
async function mineOnce(env) {
  return withSession(env, async (token) => {
    const r = await api("POST", "/api/v1/home/mining-collections", {
      token, body: { operationId: opId() },
    });
    return "OK";
  }).catch(async (e) => {
    if (e.code === "HOME_MINING_DAILY_LIMIT") return "DONE";
    if (e.code === "HOME_MINING_COOLDOWN") return "COOLDOWN";
    throw e;
  });
}

// 整点任务：兑换银票 + 征收 + 收租
async function jobHourly(env) {
  const out = [];
  try {
    await withSession(env, async (token) => {
      const home = await api("GET", "/api/v1/home", { token });
      const prov = home.economy.currencies.find(c => c.code === "PROVISIONS")?.balance ?? 0;
      const copper = home.economy.currencies.find(c => c.code === "COPPER")?.balance ?? 0;

      // --- 兑换银票：贪心凑 12，不足则全部 ---
      let budget = Math.min(12, prov);
      const plan = {}; // tier -> count
      for (const t of EXCHANGE_TIERS) {
        while (budget >= t) { plan[t] = (plan[t] || 0) + 1; budget -= t; }
      }
      const tickets = Object.entries(plan).reduce((s, [t, n]) => s + t * n, 0);
      const copperNeed = Object.entries(plan).reduce((s, [t, n]) => s + t * 100 * n, 0);
      if (tickets > 0 && copper >= copperNeed) {
        for (const [t, n] of Object.entries(plan)) {
          const r = await api("POST", "/api/v1/home/market/exchanges", {
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
      if (occ?.status === "GARRISONED") {
        const r = await api("POST", "/api/v1/home/garrison/rent-collections", {
          token, body: { operationId: opId(), expectedVersion: occ.version },
        });
        out.push(`收租 +${r.occupation?.rent?.availableCopper ?? "?"} 铜`);
      } else if (occ?.rent?.availableCopper > 0) {
        const r = await api("POST", "/api/v1/home/garrison/rent-collections", {
          token, body: { operationId: opId(), expectedVersion: occ.version },
        });
        out.push(`收租 ✓`);
      } else {
        out.push("收租: 未驻守或无可收");
      }

      // 快照
      await save(env, "snapshot", {
        at: new Date().toISOString(),
        player: { displayName: home.player.displayName, level: home.player.level,
                  combatPower: home.player.combatPower, provisionsCapacity: home.player.provisionsCapacity },
        currencies: home.economy.currencies,
        mining: home.mining,
      });
    });
  } catch (e) { out.push(`失败: ${e.message}`); }
  return out;
}

// ---------- 紫将监控与抢购 ----------

function parseAppearance(text) {
  // 【酒馆消息】飞天龙的酒馆出现了4星紫将【时迁】，快去参观吧！
  const m = text.match(/【酒馆消息】(.+?)的酒馆出现了(\d+)星(紫|橙)将【(.+?)】/);
  return m ? { owner: m[1], star: +m[2], qualityName: m[3], hero: m[4] } : null;
}

const qualityCode = (q) => q === "紫" ? "PURPLE" : q === "橙" ? "ORANGE" : null;

// 5 分钟任务：轮询公告 + 刷新存活紫将
async function jobPurpleScan(env) {
  const found = [];
  try {
    await withSession(env, async (token) => {
      const ann = await api("GET", "/api/v1/home-announcements", { token });
      const appearances = (ann.entries || [])
        .map(e => ({ ...parseAppearance(e.content || ""), at: e.startsAt }))
        .filter(x => x.owner);

      // 名字 -> playerId（带缓存）
      const pcache = await load(env, "playerCache", {});
      const heroes = await load(env, "purpleHeroes", {});

      for (const a of appearances) {
        try {
          if (!pcache[a.owner]) {
            const s = await api("GET", `/api/v1/player-search?type=NAME&query=${encodeURIComponent(a.owner)}`, { token });
            const p = (s.players || [])[0];
            if (!p) continue; // 找不到玩家（可能改名/下架），下次再试
            pcache[a.owner] = { playerId: p.playerId, shortId: p.shortId, level: p.level };
          }
          const pid = pcache[a.owner].playerId;
          const key = `${pid}:${a.hero}`;
          if (heroes[key]?.status === "GRABBED") continue;

          const t = await api("GET", `/api/v1/friend-cities/${pid}/tavern`, { token });
          const cand = (t.candidates || []).find(c =>
            c.name === a.hero && PURPLE_PLUS.includes(c.quality));
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
            heroes[key].status = "GONE"; // 已被别人招走/刷新掉
          }
        } catch (e) { /* 单条失败不影响其他 */ }
      }

      // 存活复核：对 ALIVE 且不在本次公告里的也重新确认（可能悄悄被抢）
      for (const [key, h] of Object.entries(heroes)) {
        if (h.status !== "ALIVE") continue;
        if (found.some(f => f.includes(h.hero) && f.includes(h.owner))) continue;
        try {
          const t = await api("GET", `/api/v1/friend-cities/${h.playerId}/tavern`, { token });
          const cand = (t.candidates || []).find(c => c.candidateId === h.candidateId);
          if (!cand) { h.status = "GONE"; }
          else {
            h.candidateVersion = cand.version;
            h.protectionEndsAt = t.protectionEndsAt;
            h.lastSeenAt = new Date().toISOString();
          }
        } catch (e) { /* 忽略 */ }
      }

      // 清理：GONE 超过 1 天的删除
      const dayAgo = Date.now() - 86400_000;
      for (const [key, h] of Object.entries(heroes)) {
        if (h.status === "GONE" && Date.parse(h.lastSeenAt) < dayAgo) delete heroes[key];
      }

      await save(env, "playerCache", pcache);
      await save(env, "purpleHeroes", heroes);
    });
  } catch (e) {
    await addLog(env, `紫将扫描失败: ${e.message}`, "error");
    return found;
  }
  return found;
}

// 抢购一个紫将
async function grabHero(env, key, manual = false) {
  const heroes = await load(env, "purpleHeroes", {});
  const h = heroes[key];
  if (!h) return { ok: false, msg: "目标不存在" };
  if (h.status === "GRABBED") return { ok: false, msg: "已抢购成功" };

  // 刷新最新 candidateId/version（卡池可能刷新过）
  try {
    await withSession(env, async (token) => {
      const t = await api("GET", `/api/v1/friend-cities/${h.playerId}/tavern`, { token });
      const cand = (t.candidates || []).find(c => c.name === h.hero && PURPLE_PLUS.includes(c.quality));
      if (!cand) throw Object.assign(new Error("武将已不在卡池"), { code: "GONE" });
      h.candidateId = cand.candidateId;
      h.candidateVersion = cand.version;
      const r = await api("POST", `/api/v1/friend-cities/${h.playerId}/tavern/recruitments`, {
        token, body: {
          operationId: opId(), candidateId: h.candidateId,
          expectedCandidateVersion: h.candidateVersion,
        },
      });
      h.status = "GRABBED";
      h.grabbedAt = new Date().toISOString();
    });
    heroes[key] = h;
    await save(env, "purpleHeroes", heroes);
    await addLog(env, `🎉 抢购成功: ${h.owner}家 ${h.hero}(${h.quality}${h.star}星)`, "success");
    return { ok: true, msg: `已抢到 ${h.hero}` };
  } catch (e) {
    if (e.code === "GONE") {
      h.status = "GONE"; heroes[key] = h; await save(env, "purpleHeroes", heroes);
      await addLog(env, `抢购失败: ${h.hero} 已不在卡池`, "warn");
      return { ok: false, msg: "武将已不在卡池" };
    }
    const retry = e.code === "PROTECTION_ACTIVE" || /保护/.test(e.message || "");
    await addLog(env, `抢购失败(${h.hero}): ${e.message}`, retry ? "warn" : "error");
    return { ok: false, msg: e.message, retry };
  }
}

// 每分钟检查预约到期
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

async function scheduled(event, env, ctx) {
  const { date, hour, minute } = bj(event.scheduledTime || Date.now());
  const daily = await load(env, "daily", {});
  if (daily.date !== date) {
    Object.assign(daily, { date, signin: false, mining: 0, hourly: {} });
    await save(env, "daily", daily);
  }

  try {
    // --- 00:01 签到 + 开采计划启动 ---
    if (hour === 0 && minute === 1 && !daily.signin) {
      const r = await jobSignIn(env);
      await addLog(env, `签到: ${r.join("; ")}`);
      daily.signin = true; await save(env, "daily", daily);
    }

    // --- 矿山开采窗口（00:01 起，采满 10 次或 00:30 止）---
    if (hour === 0 && minute >= 1 && minute <= 30 && daily.mining < DAILY_MINING) {
      const r = await mineOnce(env);
      if (r === "OK") {
        daily.mining++;
        await save(env, "daily", daily);
        if (daily.mining === DAILY_MINING) await addLog(env, "矿山: 今日 10 次开采完成");
      } else if (r === "DONE") {
        daily.mining = DAILY_MINING; await save(env, "daily", daily);
        await addLog(env, "矿山: 次数已用完（可能在游戏内已采）");
      } else if (r === "COOLDOWN") {
        await new Promise(res => setTimeout(res, 30_000)); // 30s 后同 tick 内重试一次
        const r2 = await mineOnce(env);
        if (r2 === "OK") { daily.mining++; await save(env, "daily", daily); }
        else if (r2 === "DONE") { daily.mining = DAILY_MINING; await save(env, "daily", daily); }
      }
    }

    // --- 整点任务（每小时）---
    if (minute === 0 && !daily.hourly[hour]) {
      const r = await jobHourly(env);
      daily.hourly[hour] = true; await save(env, "daily", daily);
      await addLog(env, `[${String(hour).padStart(2, "0")}:00] ${r.join("; ")}`);
    }

    // --- 紫将公告轮询（每 5 分钟）---
    if (minute % 5 === 2) {
      const found = await jobPurpleScan(env);
      for (const f of found) await addLog(env, `发现紫将: ${f}`, "success");
    }

    // --- 预约到期抢购（每分钟）---
    await checkReservations(env);
  } catch (e) {
    await addLog(env, `调度异常: ${e.message}`, "error");
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
.log{max-height:340px;overflow-y:auto;font-size:12.5px;font-family:inherit}
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
#login{position:fixed;inset:0;background:var(--bg);display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px;z-index:9}
#login input{background:#131a29;border:1px solid var(--line);color:var(--txt);border-radius:8px;padding:10px 14px;font-size:15px;width:240px}
.cd{font-variant-numeric:tabular-nums;color:var(--warn)}
.muted{color:var(--dim);font-size:12px}
.tag{font-size:11px;color:var(--dim)}
</style></head><body>
<div id="login" hidden><h3>访问密码</h3><input id="pwd" type="password" placeholder="输入访问密码"><button onclick="doLogin()">进入</button><p id="lerr" class="muted"></p></div>
<h1><span class="dot" id="hdot"></span>Q将水浒 · 自动化面板 <span class="tag" id="hserver"></span></h1>
<div class="card"><h2>账号</h2><div id="player" class="muted">加载中…</div><div class="cur" id="cur" style="margin-top:8px"></div></div>
<div class="card"><h2>今日任务</h2><div class="grid" id="daily"></div>
  <div class="row" style="margin-top:10px">
    <button class="ghost" onclick="job('signin')">立即签到</button>
    <button class="ghost" onclick="job('hourly')">立即整点任务</button>
    <button class="ghost" onclick="job('mine')">开采一次</button>
    <button class="ghost" onclick="job('scan')">扫描紫将</button>
  </div></div>
<div class="card"><h2>紫将监控 <span class="tag">公告每5分钟轮询 · 酒馆30分钟保护期</span></h2>
  <div id="heroes"><p class="muted">暂无存活紫将</p></div></div>
<div class="card"><h2>日志</h2><div class="log" id="log"></div></div>
<script>
let KEY=localStorage.getItem('pk')||'';
const $=id=>document.getElementById(id);
async function req(path,opts={}){const r=await fetch('/api/'+path,{...opts,headers:{'Content-Type':'application/json','X-Page-Key':KEY,...(opts.headers||{})}});if(r.status===401){$('login').hidden=false;throw 0}return r.json()}
function doLogin(){KEY=$('pwd').value;localStorage.setItem('pk',KEY);render()}
const CUR={COPPER:'铜钱',YUANBAO:'元宝',SILVER_TICKET:'银票',PROVISIONS:'粮草',BATTLE_ACHIEVEMENT:'战功'};
function fmt(n){return (+n).toLocaleString('zh-CN')}
function cd(iso){const s=Math.floor((new Date(iso)-Date.now())/1000);return s>0?Math.floor(s/60)+'分'+String(s%60).padStart(2,'0')+'秒':'已结束'}
const inflight=new Set();
async function render(){
  try{
    const s=await req('status');
    // 预约到期且页面开着 → 浏览器端立刻抢（与每分钟 cron 双保险，秒级精度）
    for(const h of Object.values(s.heroes||{})){
      if(h.reserved&&h.status==='ALIVE'&&new Date(h.protectionEndsAt)<=new Date()&&!inflight.has(h.key)){
        inflight.add(h.key);grab(h.key).finally(()=>inflight.delete(h.key));
      }
    }
    $('hserver').textContent=s.state?.serverId||'';
    $('hdot').style.background=s.state?.token?'var(--ok)':'var(--err)';
    if(s.snapshot?.player){const p=s.snapshot.player;$('player').innerHTML='<b>'+p.displayName+'</b> Lv'+p.level+' · 战力 '+fmt(p.combatPower||0)}
    $('cur').innerHTML=(s.snapshot?.currencies||[]).map(c=>'<span>'+(CUR[c.code]||c.code)+' <b>'+fmt(c.balance)+'</b></span>').join('');
    const d=s.daily||{signin:false,mining:0,hourly:{}};
    const hrs=Object.keys(d.hourly||{}).length;
    $('daily').innerHTML=[
      ['签到',d.signin?'✓ 已完成':'待 00:01'],
      ['矿山',d.mining+'/10 次'],
      ['整点任务',hrs+' 次'],
      ['上次登录',(s.state?.lastLoginAt||'').slice(11,19)],
    ].map(([k,v])=>'<div class="kv"><span>'+k+'</span><b>'+v+'</b></div>').join('');
    const hs=Object.values(s.heroes||{}).filter(h=>h.status!=='GONE');
    $('heroes').innerHTML=hs.length?('<table><tr><th>武将</th><th>酒馆主人</th><th>成本</th><th>保护期</th><th>状态</th><th></th></tr>'+
      hs.map(h=>{const k=h.key.replace(/"/g,'&quot;');
        const st=h.status==='GRABBED'?'<span class="st-GRABBED">已抢到</span>':h.reserved?'<span class="st-ALIVE">已预约</span>':'';
        const btn=h.status==='GRABBED'?'':h.reserved
          ?'<button class="ghost" onclick="res(\\''+k+'\\')">取消</button> <button class="warn" onclick="grab(\\''+k+'\\')">立即抢</button>'
          :'<button onclick="res(\\''+k+'\\')">预约抢购</button>';
        return '<tr><td><span class="q q-'+h.quality+'">'+(h.quality==='PURPLE'?'紫':'橙')+'</span> '+h.hero+' '+h.star+'星</td><td>'+h.owner+'(Lv'+h.ownerLevel+')</td><td>'+fmt(h.copperCost)+'铜'+(h.silverTicketCost?'+'+h.silverTicketCost+'票':'')+'</td><td><span class="cd">'+cd(h.protectionEndsAt)+'</span></td><td>'+st+'</td><td class="row">'+btn+'</td></tr>'}).join('')+'</table>')
      :'<p class="muted">暂无存活紫将（'+Object.keys(s.heroes||{}).length+' 条历史记录）</p>';
    $('log').innerHTML=(s.log||[]).slice(0,120).map(l=>'<div><time>'+l.t.slice(5,16).replace('T',' ')+'</time><span class="lv-'+l.level+'">'+l.msg+'</span></div>').join('');
  }catch(e){if(e!==0)console.error(e)}
}
async function res(k){await req('reserve',{method:'POST',body:JSON.stringify({key:k})});render()}
async function grab(k){await req('grab',{method:'POST',body:JSON.stringify({key:k})});render()}
async function job(n){await req('job',{method:'POST',body:JSON.stringify({name:n})});setTimeout(render,800)}
render();setInterval(render,10000);
</script></body></html>`;

function authOk(request, env) {
  if (!env.PAGE_KEY) return true; // 未设密码则开放（不建议）
  const key = request.headers.get("X-Page-Key") ||
    new URL(request.url).searchParams.get("key");
  return key === env.PAGE_KEY;
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  const route = url.pathname.replace(/^\/api\//, "");

  if (!authOk(request, env)) return json({ error: "unauthorized" }, 401);

  if (route === "status" && request.method === "GET") {
    const [state, daily, heroes, log, snapshot] = await Promise.all([
      load(env, "state", {}), load(env, "daily", {}),
      load(env, "purpleHeroes", {}), load(env, "log", []), load(env, "snapshot", {}),
    ]);
    const { token, ...stateSafe } = state;  // 不向页面暴露凭据
    return json({ state: stateSafe, daily, heroes, log, snapshot });
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
  if (route === "job" && request.method === "POST") {
    const { name } = await request.json();
    if (name === "signin") { const r = await jobSignIn(env); const d = await load(env, "daily", {}); d.signin = true; d.date = bj(Date.now()).date; await save(env, "daily", d); await addLog(env, `手动签到: ${r.join("; ")}`); return json({ ok: true, result: r }); }
    if (name === "hourly") { const r = await jobHourly(env); await addLog(env, `手动整点任务: ${r.join("; ")}`); return json({ ok: true, result: r }); }
    if (name === "mine") { const r = await mineOnce(env); if (r === "OK") { const d = await load(env, "daily", {}); d.mining = (d.mining || 0) + 1; await save(env, "daily", d); } await addLog(env, `手动开采: ${r}`); return json({ ok: true, result: r }); }
    if (name === "scan") { const r = await jobPurpleScan(env); for (const f of r) await addLog(env, `发现紫将: ${f}`, "success"); return json({ ok: true, found: r }); }
    return json({ error: "unknown job" }, 400);
  }
  return json({ error: "not found" }, 404);
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status, headers: { "Content-Type": "application/json; charset=utf-8" },
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env);
    return new Response(PAGE, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(scheduled(event, env));
  },
};
