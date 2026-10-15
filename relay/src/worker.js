// Q将水浒 · token 上报中继（完整逻辑已迁移至自建服务器）
// 作用：https 页面（qjsh.top 游戏）无法向 http 的自建服务器上报（mixed content 限制），
//      本 Worker 仅把 /api/report-token 转发到服务器版面板。
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const cors = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json; charset=utf-8" };
    if (url.pathname === "/api/report-token" && request.method === "POST") {
      try {
        const body = await request.text();
        const r = await fetch("http://72.18.82.231:8787/api/report-token", {
          method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8", "X-Relay-Key": "8a51b123acdb3e6b" }, body,
        });
        return new Response(await r.text(), { status: r.status, headers: cors });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: "relay_failed: " + e.message }), { status: 502, headers: cors });
      }
    }
    return new Response(JSON.stringify({ ok: true, service: "qjsh-relay", target: "http://72.18.82.231:8787" }), { headers: cors });
  },
};
