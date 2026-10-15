// ==UserScript==
// @name         Q将水浒 · token 自动上报
// @namespace    qjsh-automation
// @version      1.1
// @description  游戏页面自动捕获 accessToken 并上报到自动化面板（刷新/重进游戏无需再点书签）。右下角圆点=运行状态：灰=待捕获 绿=已上报 红=上报失败
// @match        https://qjsh.top/*
// @match        https://*.qjsh.top/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
(function () {
  var W = "https://qjsh-automation.fhcmksj.workers.dev";
  var lastTok = "";

  // ---- 状态徽标（右下角小圆点 + 文字）----
  var badge = document.createElement("div");
  badge.textContent = "QJSH:脚本已运行,待捕获token";
  badge.style.cssText = "position:fixed;right:8px;bottom:8px;z-index:99999;background:#333;color:#fff;" +
    "font:11px/1.4 monospace;padding:3px 8px;border-radius:10px;opacity:.85;pointer-events:none;";
  function setStatus(text, color) {
    badge.textContent = "QJSH:" + text;
    badge.style.background = color;
  }
  function mountBadge() {
    if (!document.body) return setTimeout(mountBadge, 200);
    document.body.appendChild(badge);
  }
  mountBadge();

  // ---- 上报（beacon 优先，失败 fetch 重试；徽标反馈结果）----
  function report(token) {
    if (!token || token === lastTok) return;
    lastTok = token;
    setStatus("已捕获token,上报中...", "#a60");
    var payload = JSON.stringify({ token: token });
    var ok = false;
    try { ok = navigator.sendBeacon(W + "/api/report-token", payload); } catch (e) { ok = false; }
    if (ok) { setStatus("已上报 ✓", "#2a7"); return; }
    // beacon 被拒时用 fetch 兜底（no-cors：能发出即认为送达链路通）
    fetch(W + "/api/report-token", {
      method: "POST", mode: "no-cors",
      headers: { "Content-Type": "text/plain" },
      body: payload,
    }).then(function () { setStatus("已上报 ✓(fetch)", "#2a7"); })
      .catch(function (e) { setStatus("上报失败:" + (e && e.message || e), "#a22"); });
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
