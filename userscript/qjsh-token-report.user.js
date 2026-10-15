// ==UserScript==
// @name         Q将水浒 · token 自动上报
// @namespace    qjsh-automation
// @version      1.0
// @description  游戏页面自动捕获 accessToken 并上报到自动化面板（刷新/重进游戏无需再点书签）
// @match        https://qjsh.top/*
// @match        https://*.qjsh.top/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
(function () {
  var W = "https://qjsh-automation.fhcmksj.workers.dev";
  var lastTok = "";

  function report(token) {
    if (!token || token === lastTok) return;
    lastTok = token;
    try {
      navigator.sendBeacon(W + "/api/report-token", JSON.stringify({ token: token }));
      console.log("[qjsh] accessToken 已自动上报");
    } catch (e) { /* ignore */ }
  }

  function extractAuth(headerVal) {
    return String(headerVal).replace(/^Bearer\s+/i, "");
  }

  // --- fetch ---
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

  // --- XHR ---
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
