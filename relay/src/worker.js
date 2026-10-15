// Q将水浒 · token 上报中继（完整逻辑已迁移至自建服务器）
// 作用：https 页面（qjsh.top 游戏）无法向 http 的自建服务器上报（mixed content 限制），
//      本 Worker 仅把 /api/report-token 转发到服务器版面板。
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json; charset=utf-8" };
    if ((url.pathname === "/sync" || url.pathname === "/api/sync") && request.method === "POST") {
      try {
        console.log("RELAY-IN path=" + url.pathname);
        const body = await request.text();
        console.log("RELAY-BODY " + body.slice(0, 50));
        console.log("RELAY-FETCH start");
        const r = await fetch(env.RELAY_URL || "https://qjsh.duckdns.org/r/__RELAY_SECRET__", {
          method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8", "X-Relay-Key": env.RELAY_KEY || "" }, body,
        });
        const t = await r.text();
        console.log("RELAY-OK status=" + r.status + " body=" + t.slice(0, 60));
        return new Response(t, { status: r.status, headers: cors });
      } catch (e) {
        console.log("RELAY-ERR " + (e && e.message));
        return new Response(JSON.stringify({ ok: false, error: "relay_failed: " + e.message }), { status: 502, headers: cors });
      }
    }
    return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain" } });
  },
};
