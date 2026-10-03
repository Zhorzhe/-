(function () {
  "use strict";

  var TOKEN_KEY = "mpp-scan-token";
  var STATS_KEY = "mpp-scan-stats";
  var SAME_CODE_PAUSE_MS = 4000;   // повторно сканиране на същия код се игнорира
  var AUTO_CLOSE_OK_MS = 2000;     // валидният резултат се затваря сам
  var SCAN_INTERVAL_MS = 120;
  var TZ = "Europe/Sofia";

  var $ = function (s) { return document.querySelector(s); };
  var MONTHS = ["яну", "фев", "мар", "апр", "май", "юни", "юли", "авг", "сеп", "окт", "ное", "дек"];

  var token = null;
  var stream = null;
  var facing = "environment";
  var scanning = false;
  var busy = false;
  var lastText = "";
  var lastTextAt = 0;
  var autoCloseTimer = null;
  var history = [];
  var stats = { day: "", ok: 0, bad: 0 };

  // ---------- Помощни ----------
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmtDate(iso) {
    var p = iso.split("-");
    return +p[2] + " " + MONTHS[+p[1] - 1] + " " + p[0];
  }
  function fmtTime(d) {
    return new Date(d).toLocaleTimeString("bg-BG", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
  }
  function store(remember) { return remember ? localStorage : sessionStorage; }
  function getSaved() {
    try { return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY); } catch (e) { return null; }
  }
  function saveToken(t, remember) {
    try {
      localStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(TOKEN_KEY);
      if (t) store(remember).setItem(TOKEN_KEY, t);
    } catch (e) { /* без съхранение */ }
  }

  function api(method, url, body) {
    return fetch(url, {
      method: method,
      headers: Object.assign({ Authorization: "Bearer " + token }, body ? { "Content-Type": "application/json" } : {}),
      body: body ? JSON.stringify(body) : undefined
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        data.httpStatus = res.status;
        return data;
      });
    });
  }

  // ---------- Звук и вибрация ----------
  var audioCtx = null;
  function beep(ok) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      var tones = ok ? [880] : [220, 180];
      tones.forEach(function (f, i) {
        var o = audioCtx.createOscillator();
        var g = audioCtx.createGain();
        o.frequency.value = f;
        o.type = ok ? "sine" : "square";
        g.gain.value = 0.15;
        o.connect(g); g.connect(audioCtx.destination);
        var t = audioCtx.currentTime + i * 0.22;
        o.start(t); o.stop(t + (ok ? 0.15 : 0.2));
      });
    } catch (e) { /* без звук */ }
    if (navigator.vibrate) navigator.vibrate(ok ? 80 : [200, 100, 200]);
  }

  // ---------- Брояч за деня ----------
  function loadStats(today) {
    try { stats = JSON.parse(localStorage.getItem(STATS_KEY)) || stats; } catch (e) { /* нищо */ }
    if (stats.day !== today) stats = { day: today, ok: 0, bad: 0 };
    renderStats();
  }
  function bump(kind) {
    stats[kind]++;
    try { localStorage.setItem(STATS_KEY, JSON.stringify(stats)); } catch (e) { /* нищо */ }
    renderStats();
  }
  function renderStats() {
    $("#cntOk").textContent = stats.ok;
    $("#cntBad").textContent = stats.bad;
  }

  // ---------- Вход ----------
  function login(t, remember) {
    token = t;
    $("#loginError").textContent = "";
    $("#loginBtn").disabled = true;
    return api("GET", "/api/scan/me").then(function (d) {
      $("#loginBtn").disabled = false;
      if (d.httpStatus !== 200) throw new Error(d.error || "Грешка " + d.httpStatus);
      saveToken(t, remember);
      showScanner(d);
    }).catch(function (err) {
      $("#loginBtn").disabled = false;
      token = null;
      $("#loginError").textContent = err.message === "Failed to fetch" ? "Няма връзка със сървъра." : err.message;
      $("#loginView").hidden = false;
      $("#scanView").hidden = true;
    });
  }

  function showScanner(me) {
    $("#loginView").hidden = true;
    $("#scanView").hidden = false;
    $("#todayText").textContent = "Днес, " + fmtDate(me.today);
    $("#eventsText").textContent = me.events.length
      ? me.events.map(function (e) { return e.title; }).join(" · ")
      : "Днес няма активно събитие";
    loadStats(me.today);
    renderHistory();
  }

  function logout() {
    stopCamera();
    saveToken(null);
    token = null;
    $("#token").value = "";
    $("#scanView").hidden = true;
    $("#loginView").hidden = false;
  }

  // ---------- Камера ----------
  function setCameraMsg(text, showBtn) {
    $("#cameraMsg").hidden = !text;
    $("#cameraMsgText").textContent = text || "";
    $("#startCamBtn").hidden = !showBtn;
  }

  function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCameraMsg("Камерата не е достъпна. Отворете страницата през HTTPS или въведете кода ръчно.", false);
      return;
    }
    stopCamera();
    setCameraMsg("Включване на камерата…", false);
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing }, width: { ideal: 1280 } }, audio: false })
      .then(function (s) {
        stream = s;
        var v = $("#video");
        v.srcObject = s;
        return v.play();
      })
      .then(function () {
        setCameraMsg("", false);
        scanning = true;
        scheduleScan();
        return navigator.mediaDevices.enumerateDevices();
      })
      .then(function (devices) {
        var cams = (devices || []).filter(function (d) { return d.kind === "videoinput"; });
        $("#switchCamBtn").hidden = cams.length < 2;
      })
      .catch(function (err) {
        var denied = err && (err.name === "NotAllowedError" || err.name === "SecurityError");
        setCameraMsg(denied
          ? "Няма разрешение за камерата. Разрешете достъпа от настройките на браузъра или въведете кода ръчно."
          : "Камерата не може да бъде включена. Въведете кода ръчно.", true);
      });
  }

  function stopCamera() {
    scanning = false;
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null;
  }

  var canvas = $("#canvas");
  var ctx = canvas.getContext("2d", { willReadFrequently: true });

  function scheduleScan() {
    if (!scanning) return;
    setTimeout(function () { requestAnimationFrame(scanFrame); }, SCAN_INTERVAL_MS);
  }

  function scanFrame() {
    if (!scanning) return;
    var v = $("#video");
    if (!busy && v.readyState >= 2 && v.videoWidth) {
      // Изрязваме централния квадрат и го смаляваме – по-бързо и по-точно.
      var size = Math.min(v.videoWidth, v.videoHeight);
      var out = Math.min(size, 640);
      canvas.width = out;
      canvas.height = out;
      ctx.drawImage(v, (v.videoWidth - size) / 2, (v.videoHeight - size) / 2, size, size, 0, 0, out, out);
      var img = ctx.getImageData(0, 0, out, out);
      var code = window.jsQR && window.jsQR(img.data, out, out, { inversionAttempts: "dontInvert" });
      if (code && code.data) onScanned(code.data);
    }
    scheduleScan();
  }

  function onScanned(text) {
    var now = Date.now();
    if (text === lastText && now - lastTextAt < SAME_CODE_PAUSE_MS) return;
    lastText = text;
    lastTextAt = now;
    check(text);
  }

  // ---------- Проверка ----------
  function check(code) {
    if (busy) return;
    busy = true;
    api("POST", "/api/scan/check", { code: code }).then(function (d) {
      if (d.httpStatus === 401) {
        busy = false;
        logout();
        $("#loginError").textContent = "Ключът за достъп вече не е валиден. Влезте отново.";
        return;
      }
      showResult(d, code);
    }).catch(function () {
      showResult({ result: "offline", message: "Няма връзка със сървъра. Опитайте отново." }, code);
    });
  }

  var RESULTS = {
    ok: { cls: "ok", icon: "✓", title: "ВАЛИДЕН" },
    used: { cls: "bad", icon: "✕", title: "ИЗПОЛЗВАН" },
    not_found: { cls: "bad", icon: "✕", title: "НЕВАЛИДЕН" },
    unpaid: { cls: "warn", icon: "!", title: "НЕПЛАТЕН" },
    wrong_date: { cls: "warn", icon: "!", title: "НЕ Е ЗА ДНЕС" },
    offline: { cls: "warn", icon: "!", title: "НЯМА ВРЪЗКА" }
  };

  function showResult(d, rawCode) {
    var r = RESULTS[d.result] || { cls: "bad", icon: "✕", title: "ГРЕШКА" };
    var t = d.ticket || {};
    var box = $("#result");
    box.className = "result " + r.cls;
    $("#resultIcon").textContent = r.icon;
    $("#resultTitle").textContent = r.title;

    var msg = d.message || d.error || "";
    if (d.result === "used" && t.usedAt) msg = "Билетът е използван в " + fmtTime(t.usedAt) + " ч.";
    if (d.result === "wrong_date" && t.validFor && t.validFor !== "all") msg = "Билетът е за " + fmtDate(t.validFor) + ".";
    $("#resultMsg").textContent = msg;

    var rows = [];
    if (t.typeName) rows.push(["Билет", t.typeName + (t.validFor === "all" ? " (всички дни)" : "")]);
    if (t.event) rows.push(["Събитие", t.event]);
    if (t.holder) rows.push(["Купувач", t.holder]);
    if (t.code) rows.push(["Код", t.code]);
    $("#resultDetails").innerHTML = rows.map(function (x) {
      return "<dt>" + escapeHtml(x[0]) + "</dt><dd>" + escapeHtml(x[1]) + "</dd>";
    }).join("");

    box.hidden = false;
    $("#nextBtn").focus();
    beep(d.result === "ok");
    if (d.result === "ok") bump("ok");
    else if (d.result !== "offline") bump("bad");

    history.unshift({
      cls: r.cls, title: r.title, time: new Date(),
      label: t.typeName ? t.typeName + " · " + (t.holder || "") : msg,
      code: t.code || String(rawCode).slice(0, 40)
    });
    history = history.slice(0, 10);
    renderHistory();

    clearTimeout(autoCloseTimer);
    if (d.result === "ok") autoCloseTimer = setTimeout(closeResult, AUTO_CLOSE_OK_MS);
  }

  function closeResult() {
    clearTimeout(autoCloseTimer);
    $("#result").hidden = true;
    busy = false;
    lastTextAt = Date.now(); // кратка пауза преди същият код да се провери пак
  }

  function renderHistory() {
    var list = $("#historyList");
    if (!history.length) {
      list.innerHTML = '<li class="empty">Все още няма проверени билети.</li>';
      return;
    }
    list.innerHTML = history.map(function (h) {
      return '<li class="' + h.cls + '"><div class="h-main"><b>' + escapeHtml(h.title) + " – " + escapeHtml(h.label) +
        "</b><span>" + escapeHtml(h.code) + "</span></div><time>" + fmtTime(h.time) + "</time></li>";
    }).join("");
  }

  // ---------- Събития ----------
  $("#loginForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var t = $("#token").value.trim();
    if (!t) { $("#loginError").textContent = "Въведете ключ за достъп."; return; }
    login(t, $("#remember").checked);
  });
  $("#logoutBtn").addEventListener("click", logout);
  $("#startCamBtn").addEventListener("click", startCamera);
  $("#switchCamBtn").addEventListener("click", function () {
    facing = facing === "environment" ? "user" : "environment";
    startCamera();
  });
  $("#nextBtn").addEventListener("click", closeResult);
  $("#result").addEventListener("click", function (e) { if (e.target === e.currentTarget) closeResult(); });
  document.addEventListener("keydown", function (e) {
    if (!$("#result").hidden && (e.key === "Escape" || e.key === "Enter")) { e.preventDefault(); closeResult(); }
  });
  $("#manualForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var input = $("#manualCode");
    var v = input.value.trim().toUpperCase();
    if (!v) return;
    // Позволява въвеждане и без тирета: ABCD1234EFGH → ABCD-1234-EFGH
    var plain = v.replace(/[^A-Z0-9]/g, "");
    if (!v.includes("|") && plain.length === 12) v = plain.slice(0, 4) + "-" + plain.slice(4, 8) + "-" + plain.slice(8);
    input.value = "";
    input.blur();
    check(v);
  });
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) stopCamera();
    else if (token && !$("#scanView").hidden && $("#cameraMsg").hidden) startCamera();
  });

  // ---------- Старт ----------
  var saved = getSaved();
  if (saved) {
    var remembered = false;
    try { remembered = !!localStorage.getItem(TOKEN_KEY); } catch (e) { /* нищо */ }
    login(saved, remembered);
  }
})();
