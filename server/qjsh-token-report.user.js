// ==UserScript==
// @name         Q将水浒 · token 自动上报
// @namespace    qjsh-automation
// @version      1.5
// @description  游戏页面自动捕获 accessToken 并上报到自动化面板。右下角徽标：灰=待捕获 橙=上报中 绿=确认后4秒消失 红=失败常显(含原因)
// @match        https://qjsh.top/*
// @match        https://*.qjsh.top/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
(function () {
  var W = "https://qjsh.duckdns.org";
  var lastTok = "";

  // ---- 状态徽标 ----
  var badge = document.createElement("div");
  badge.textContent = "QJSH:脚本已运行,待捕获token";
  badge.style.cssText = "position:fixed;right:8px;bottom:8px;z-index:99999;background:#444;color:#fff;" +
    "font:11px/1.4 monospace;padding:3px 8px;border-radius:10px;opacity:.9;pointer-events:none;max-width:60vw;";
  function setStatus(text, color, autoHide) {
    badge.textContent = "QJSH:" + text;
    badge.style.background = color;
    badge.style.display = "block";
    clearTimeout(window.__qjshHide);
    if (autoHide) window.__qjshHide = setTimeout(function () { badge.style.display = "none"; }, 4000);
  }
  (function mount() {
    if (!document.body) return setTimeout(mount, 200);
    document.body.appendChild(badge);
  })();

  // ---- 上报：fetch + 服务器确认（text/plain 避免预检；读响应验证真实送达）----
  function report(token) {
    if (!token || token === lastTok) return;
    lastTok = token;
    setStatus("已捕获token,上报中...", "#a60");
    fetch(W + "/api/report-token", {
      method: "POST",
      mode: "cors",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({ token: token }),
    }).then(function (r) {
      return r.text().then(function (t) {
        var d; try { d = JSON.parse(t) } catch (e) { d = { __status: r.status, __raw: t } }
        return d;
      });
    }).then(function (d) {
      if (d && d.ok) setStatus("已上报✓", "#2a7", true);
      else setStatus("服务器拒绝:" + (d.error || ("HTTP" + d.__status + ":" + String(d.__raw || "").slice(0, 70))), "#a22");
    }).catch(function (e) {
      setStatus("上报失败:网络到workers.dev不通(需代理或自定义域名)", "#a22");
      console.error("[qjsh] 上报失败:", e);
    });
  }

  function extractAuth(v) { return String(v).replace(/^Bearer\s+/i, ""); }

  // ---- fetch patch ----
  var F = window.fetch;
  if (F) {
    window.fetch = function (input, init) {
      try {
        var url = String((input && input.url) || input);
        var h = (init && init.headers) || (input && input.headers);
        var a = h && (h.Authorization || (h.get && h.get("Authorization")));
        if (a && url.indexOf("/auth/") < 0) report(extractAuth(a));
      } catch (e) { /* ignore */ }
      return F.apply(this, arguments);
    };
  }

  // ---- XHR patch ----
  var X = XMLHttpRequest.prototype.open;
  var S = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (m, u) {
    this.__qjshUrl = u;
    return X.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    try {
      if (String(k).toLowerCase() === "authorization" && v) {
        var url = String(this.__qjshUrl || "");
        if (url.indexOf("/auth/") < 0) report(extractAuth(v));
      }
    } catch (e) { /* ignore */ }
    return S.apply(this, arguments);
  };
})();
