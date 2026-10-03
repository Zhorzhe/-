(function () {
  "use strict";

  var DATA = window.FAIR_DATA;
  var STORAGE_KEY = "mpp-tickets-orders";

  var state = {
    step: 1,
    event: null,
    date: null,
    qty: {},
    buyer: null
  };

  // ---------- Помощни функции ----------
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  var money = new Intl.NumberFormat("bg-BG", { style: "currency", currency: DATA.currency });
  function fmtMoney(v) { return money.format(v); }

  var MONTHS = ["яну", "фев", "мар", "апр", "май", "юни", "юли", "авг", "сеп", "окт", "ное", "дек"];
  var WEEKDAYS = ["нд", "пн", "вт", "ср", "чт", "пт", "сб"];

  function parseDate(s) {
    var p = s.split("-");
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }
  function isoDate(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function fmtDate(s) {
    var d = parseDate(s);
    return d.getDate() + " " + MONTHS[d.getMonth()] + " " + d.getFullYear();
  }
  function fmtRange(ev) {
    return ev.start === ev.end ? fmtDate(ev.start) : fmtDate(ev.start) + " – " + fmtDate(ev.end);
  }
  function today() {
    var d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }
  function eventDays(ev) {
    var days = [];
    for (var d = parseDate(ev.start); d <= parseDate(ev.end); d.setDate(d.getDate() + 1)) {
      days.push(new Date(d));
    }
    return days;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function loadOrders() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; } catch (e) { return []; }
  }
  function saveOrders(orders) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(orders)); } catch (e) { /* без съхранение */ }
  }
  function upsertOrder(order) {
    var orders = loadOrders().filter(function (o) { return o.id !== order.id; });
    orders.push(order);
    orders.sort(function (a, b) { return a.createdAt < b.createdAt ? -1 : 1; });
    saveOrders(orders);
    updateMyCount();
  }

  // ---------- Връзка със сървъра ----------
  function api(method, url, body) {
    return fetch(url, {
      method: method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error(data.error || "Грешка " + res.status);
          err.status = res.status;
          err.fields = data.fields || {};
          throw err;
        }
        return data;
      });
    }, function () {
      throw new Error("Няма връзка със сървъра. Проверете интернет връзката и опитайте отново.");
    });
  }

  function ticketType(id) {
    return DATA.ticketTypes.filter(function (t) { return t.id === id; })[0];
  }

  // ---------- Изчисления ----------
  function calcTotals() {
    var lines = [];
    var count = 0;
    var paidCount = 0;
    var subtotal = 0;
    DATA.ticketTypes.forEach(function (t) {
      var q = state.qty[t.id] || 0;
      if (!q) return;
      lines.push({ type: t, qty: q, sum: q * t.price });
      count += q;
      if (t.price > 0) paidCount += q;
      subtotal += q * t.price;
    });
    var g = DATA.groupDiscount;
    var discount = paidCount >= g.minTickets ? Math.round(subtotal * g.percent) / 100 : 0;
    return { lines: lines, count: count, subtotal: subtotal, discount: discount, total: subtotal - discount };
  }

  // ---------- Навигация ----------
  var STEP_VIEWS = { 1: "view-events", 2: "view-tickets", 3: "view-details", 4: "view-payment", 5: "view-done" };

  function showView(id) {
    $$(".view").forEach(function (v) { v.hidden = v.id !== id; });
    var inFlow = Object.keys(STEP_VIEWS).some(function (k) { return STEP_VIEWS[k] === id; });
    $("#stepper").hidden = !inFlow;
    $$(".main-nav a").forEach(function (a) {
      var nav = a.getAttribute("data-nav");
      a.classList.toggle("active", (nav === "events" && inFlow) || "view-" + nav === id);
    });
    window.scrollTo(0, 0);
  }

  function goStep(n) {
    if (n >= 2 && !state.event) n = 1;
    if (n >= 3 && calcTotals().count === 0) n = 2;
    if (n >= 4 && !state.buyer) n = 3;
    state.step = n;
    $$("#stepper li").forEach(function (li) {
      var s = +li.getAttribute("data-step");
      li.classList.toggle("current", s === n);
      li.classList.toggle("done", s < n);
      if (s === n) li.setAttribute("aria-current", "step"); else li.removeAttribute("aria-current");
    });
    if (n === 1) renderEvents();
    if (n === 2) renderTickets();
    if (n >= 2 && n <= 4) renderSummaries();
    showView(STEP_VIEWS[n]);
  }

  function nav(target) {
    if (target === "events") { resetFlow(); goStep(1); }
    else if (target === "my-tickets") { renderMyTickets(); showView("view-my-tickets"); refreshMyTickets(); }
    else if (target === "help") { showView("view-help"); }
  }

  function resetFlow() {
    state.event = null; state.date = null; state.qty = {}; state.buyer = null;
    $("#detailsForm").reset();
    $("#paymentForm").reset();
    $("#invoiceFields").hidden = true;
    togglePayMethod();
    clearErrors($("#detailsForm"));
    clearErrors($("#paymentForm"));
  }

  // ---------- Стъпка 1: Събития ----------
  function renderEvents() {
    var t = today();
    var minPrice = Math.min.apply(null, DATA.ticketTypes.filter(function (x) { return x.price > 0; }).map(function (x) { return x.price; }));
    var html = DATA.events.slice().sort(function (a, b) { return a.start < b.start ? -1 : 1; }).map(function (ev) {
      var past = parseDate(ev.end) < t;
      return '<article class="event-card' + (past ? " past" : "") + '">' +
        '<div class="band" style="background:' + ev.color + '"></div>' +
        '<div class="body">' +
          '<span class="cat" style="color:' + ev.color + '">' + escapeHtml(ev.category) + "</span>" +
          "<h3>" + escapeHtml(ev.title) + "</h3>" +
          '<p class="meta">📅 ' + fmtRange(ev) + "<br>🕒 " + escapeHtml(ev.hours) + "<br>📍 " + escapeHtml(ev.pavilions) + "</p>" +
          '<p class="desc">' + escapeHtml(ev.description) + "</p>" +
          '<p class="price-from">Билети от ' + fmtMoney(minPrice) + "</p>" +
          (past
            ? '<button class="btn btn-ghost" disabled>Събитието е приключило</button>'
            : '<button class="btn btn-primary" data-event="' + ev.id + '">Купи билет</button>') +
        "</div></article>";
    }).join("");
    $("#eventGrid").innerHTML = html;
  }

  // ---------- Стъпка 2: Билети ----------
  function renderTickets() {
    var ev = state.event;
    $("#eventSummary").innerHTML = "<strong>" + escapeHtml(ev.title) + "</strong><br>" +
      fmtRange(ev) + " · " + escapeHtml(ev.hours) + " · " + escapeHtml(ev.pavilions);

    var t = today();
    var days = eventDays(ev);
    if (!state.date) {
      var first = days.filter(function (d) { return d >= t; })[0];
      state.date = first ? isoDate(first) : null;
    }
    $("#dateList").innerHTML = days.map(function (d, i) {
      var iso = isoDate(d);
      var disabled = d < t;
      return '<div class="date-option">' +
        '<input type="radio" name="visitDate" id="d' + i + '" value="' + iso + '"' +
        (iso === state.date ? " checked" : "") + (disabled ? " disabled" : "") + ">" +
        '<label for="d' + i + '">' + WEEKDAYS[d.getDay()] + "<b>" + d.getDate() + "</b>" + MONTHS[d.getMonth()] + "</label></div>";
    }).join("");

    $("#ticketTypeList").innerHTML = DATA.ticketTypes.map(function (tt) {
      var q = state.qty[tt.id] || 0;
      return '<div class="ticket-row">' +
        '<div class="info"><div class="name">' + escapeHtml(tt.name) + '</div><div class="note">' + escapeHtml(tt.note) + "</div></div>" +
        '<div class="ticket-right"><span class="price">' + (tt.price ? fmtMoney(tt.price) : "Безплатен") + "</span>" +
        '<div class="qty">' +
          '<button type="button" data-qty="-1" data-type="' + tt.id + '" aria-label="Намали ' + escapeHtml(tt.name) + '"' + (q <= 0 ? " disabled" : "") + ">−</button>" +
          '<output aria-live="polite" id="q-' + tt.id + '">' + q + "</output>" +
          '<button type="button" data-qty="1" data-type="' + tt.id + '" aria-label="Увеличи ' + escapeHtml(tt.name) + '"' + (q >= DATA.maxPerType ? " disabled" : "") + ">+</button>" +
        "</div></div></div>";
    }).join("");
    $("#ticketsError").textContent = "";
  }

  function changeQty(typeId, delta) {
    var q = (state.qty[typeId] || 0) + delta;
    q = Math.max(0, Math.min(DATA.maxPerType, q));
    state.qty[typeId] = q;
    renderTickets();
    renderSummaries();
    var btn = $('[data-type="' + typeId + '"][data-qty="' + delta + '"]');
    if (btn && !btn.disabled) btn.focus();
  }

  function summaryHtml() {
    var ev = state.event;
    var tot = calcTotals();
    var html = '<div class="summary"><h3>' + escapeHtml(ev.title) + "</h3>" +
      '<p class="sub">' + (state.date ? fmtDate(state.date) : "Не е избран ден") + "</p>";
    if (!tot.count) {
      html += '<p class="empty">Все още няма избрани билети.</p>';
    } else {
      html += "<ul>" + tot.lines.map(function (l) {
        return "<li><span>" + l.qty + " × " + escapeHtml(l.type.name) + "</span><span>" + fmtMoney(l.sum) + "</span></li>";
      }).join("");
      if (tot.discount) {
        html += '<li class="discount"><span>Групова отстъпка ' + DATA.groupDiscount.percent + "%</span><span>−" + fmtMoney(tot.discount) + "</span></li>";
      }
      html += '<li class="total"><span>Общо</span><span>' + fmtMoney(tot.total) + "</span></li></ul>";
    }
    if (state.buyer) {
      html += '<p class="sub" style="margin-top:12px">Купувач: ' + escapeHtml(state.buyer.firstName + " " + state.buyer.lastName) +
        "<br>" + escapeHtml(state.buyer.email) + "</p>";
    }
    return html + "</div>";
  }

  function renderSummaries() {
    if (!state.event) return;
    var h = summaryHtml();
    ["#orderSummary2", "#orderSummary3", "#orderSummary4"].forEach(function (s) { $(s).innerHTML = h; });
    var tot = calcTotals();
    $("#payBtn").textContent = tot.total > 0 ? "Плати " + fmtMoney(tot.total) : "Потвърди поръчката";
  }

  // ---------- Валидация ----------
  function setError(input, msg) {
    var field = input.closest(".field");
    if (!field) return;
    field.classList.toggle("invalid", !!msg);
    var el = field.querySelector(".field-error");
    if (el) el.textContent = msg || "";
    input.setAttribute("aria-invalid", msg ? "true" : "false");
  }
  function clearErrors(form) {
    $$(".field", form).forEach(function (f) {
      f.classList.remove("invalid");
      var e = f.querySelector(".field-error");
      if (e) e.textContent = "";
    });
    $$("input", form).forEach(function (i) { i.removeAttribute("aria-invalid"); });
  }

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  var PHONE_RE = /^\+?[0-9 ()-]{8,18}$/;

  function validateEik(v) {
    if (!/^\d{9}(\d{4})?$/.test(v)) return false;
    var d = v.split("").map(Number);
    var s = 0, i, r;
    for (i = 0; i < 8; i++) s += d[i] * (i + 1);
    r = s % 11;
    if (r === 10) { s = 0; for (i = 0; i < 8; i++) s += d[i] * (i + 3); r = s % 11; if (r === 10) r = 0; }
    if (r !== d[8]) return false;
    if (d.length === 13) {
      var w1 = [2, 7, 3, 5], w2 = [4, 9, 5, 7];
      s = 0; for (i = 0; i < 4; i++) s += d[8 + i] * w1[i];
      r = s % 11;
      if (r === 10) { s = 0; for (i = 0; i < 4; i++) s += d[8 + i] * w2[i]; r = s % 11; if (r === 10) r = 0; }
      if (r !== d[12]) return false;
    }
    return true;
  }

  function validateDetails() {
    var f = $("#detailsForm");
    clearErrors(f);
    var ok = true;
    function req(id, msg, test) {
      var el = $("#" + id);
      var v = el.value.trim();
      var err = !v ? (msg || "Полето е задължително.") : (test ? test(v) : "");
      if (err) { setError(el, err); if (ok) el.focus(); ok = false; }
      return v;
    }
    var buyer = {
      firstName: req("firstName"),
      lastName: req("lastName"),
      email: req("email", null, function (v) { return EMAIL_RE.test(v) ? "" : "Невалиден имейл адрес."; }),
      phone: req("phone", null, function (v) { return PHONE_RE.test(v) ? "" : "Невалиден телефонен номер."; }),
      company: $("#company").value.trim(),
      newsletter: $("#newsletter").checked,
      acceptTerms: true,
      invoice: null
    };
    req("email2", null, function (v) { return v.toLowerCase() === $("#email").value.trim().toLowerCase() ? "" : "Имейлите не съвпадат."; });

    if ($("#wantInvoice").checked) {
      buyer.invoice = {
        company: req("invCompany"),
        eik: req("invEik", null, function (v) { return validateEik(v) ? "" : "Невалиден ЕИК/БУЛСТАТ."; }),
        vat: $("#invVat").value.trim().toUpperCase(),
        mol: req("invMol"),
        address: req("invAddress")
      };
      if (buyer.invoice.vat && !/^BG\d{9,10}$/.test(buyer.invoice.vat)) {
        setError($("#invVat"), "Форматът е BG и 9 или 10 цифри.");
        ok = false;
      }
    }
    var terms = $("#acceptTerms");
    if (!terms.checked) {
      setError(terms, "Необходимо е да приемете условията.");
      if (ok) terms.focus();
      ok = false;
    }
    return ok ? buyer : null;
  }

  function luhn(num) {
    var s = 0, alt = false;
    for (var i = num.length - 1; i >= 0; i--) {
      var n = +num[i];
      if (alt) { n *= 2; if (n > 9) n -= 9; }
      s += n; alt = !alt;
    }
    return s % 10 === 0;
  }

  function validatePayment() {
    var f = $("#paymentForm");
    clearErrors(f);
    if (payMethod() !== "card" || calcTotals().total === 0) return true;
    var ok = true;
    function fail(el, msg) { setError(el, msg); if (ok) el.focus(); ok = false; }

    var name = $("#cardName");
    if (name.value.trim().length < 3) fail(name, "Въведете името, изписано на картата.");

    var num = $("#cardNumber");
    var digits = num.value.replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19 || !luhn(digits)) fail(num, "Невалиден номер на карта.");

    var exp = $("#cardExp");
    var m = /^(\d{2})\/(\d{2})$/.exec(exp.value.trim());
    if (!m || +m[1] < 1 || +m[1] > 12) fail(exp, "Въведете дата във формат ММ/ГГ.");
    else {
      var now = new Date();
      var expEnd = new Date(2000 + +m[2], +m[1], 1);
      if (expEnd <= now) fail(exp, "Картата е с изтекла валидност.");
    }

    var cvc = $("#cardCvc");
    if (!/^\d{3,4}$/.test(cvc.value.trim())) fail(cvc, "CVC трябва да е 3 или 4 цифри.");
    return ok;
  }

  function payMethod() {
    var r = $('input[name="payMethod"]:checked');
    return r ? r.value : "card";
  }
  function togglePayMethod() {
    var free = state.event && calcTotals().total === 0;
    var bank = payMethod() === "bank";
    $(".pay-methods").hidden = !!free;
    $("#cardFields").hidden = bank || !!free;
    $("#bankFields").hidden = !bank || !!free;
  }

  function ticketHtml(order, t) {
    var valid = t.validFor === "all" ? fmtRange(order.event) + " (всички дни)" : fmtDate(t.validFor);
    var pending = order.status === "pending";
    var status = pending ? ["pending", "Очаква плащане"] : t.usedAt ? ["used", "Използван"] : ["", "Валиден"];
    return '<div class="ticket">' +
      '<div class="stub" style="background:' + order.event.color + '"></div>' +
      '<div class="t-body"><div class="t-info">' +
        "<h4>" + escapeHtml(order.event.title) + "</h4>" +
        "<p><strong>" + escapeHtml(t.typeName) + "</strong> · " + (t.price ? fmtMoney(t.price) : "безплатен") + "</p>" +
        "<p>📅 " + valid + "</p>" +
        "<p>🕒 " + escapeHtml(order.event.hours) + "</p>" +
        '<p class="t-code">' + t.code + "</p>" +
        '<span class="status ' + status[0] + '">' + status[1] + "</span>" +
      "</div>" +
      '<div class="t-qr" data-qr="' + escapeHtml(order.id + "|" + t.code) + '" role="img" aria-label="QR код на билет ' + t.code + '"></div>' +
      "</div></div>";
  }

  function drawQrCodes(root) {
    $$("[data-qr]", root).forEach(function (el) {
      if (el.childNodes.length) return;
      var text = el.getAttribute("data-qr");
      if (window.qrcode) {
        var qr = window.qrcode(0, "M");
        qr.addData(text);
        qr.make();
        el.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
      } else {
        el.textContent = text;
        el.style.fontSize = "11px";
      }
    });
  }

  function renderDone(order, emailed) {
    var pending = order.status === "pending";
    var mailNote = emailed
      ? "Изпратихме потвърждение на <strong>" + escapeHtml(order.buyer.email) + "</strong>."
      : "Не успяхме да изпратим имейл в момента — билетите са запазени в „Моите билети“.";
    $("#h-done").textContent = pending ? "Поръчката е регистрирана" : "Поръчката е успешна!";
    $("#doneText").innerHTML = "Номер на поръчката: <strong>" + order.id + "</strong><br>" +
      (pending
        ? "Моля, преведете " + fmtMoney(order.total) + " с основание <strong>" + order.id + "</strong>. Билетите ще станат валидни и ще бъдат изпратени по имейл след получаване на плащането.<br>" + mailNote
        : mailNote + " Билетите са запазени и в „Моите билети“.");
    $("#doneTickets").innerHTML = order.tickets.map(function (t) { return ticketHtml(order, t); }).join("");
    drawQrCodes($("#doneTickets"));
  }

  // ---------- Моите билети ----------
  function renderMyTickets() {
    var orders = loadOrders();
    var box = $("#myTicketsList");
    if (!orders.length) {
      box.innerHTML = '<div class="card empty-state"><p>Все още нямате закупени билети.</p>' +
        '<button class="btn btn-primary" data-nav="events">Разгледай събитията</button></div>';
      return;
    }
    box.innerHTML = orders.slice().reverse().map(function (o) {
      return '<div class="order-block"><h3>' + escapeHtml(o.event.title) + "</h3>" +
        '<p class="sub">Поръчка ' + o.id + " · " + new Date(o.createdAt).toLocaleString("bg-BG") + " · " + fmtMoney(o.total) + "</p>" +
        '<div class="tickets-list">' + o.tickets.map(function (t) { return ticketHtml(o, t); }).join("") + "</div></div>";
    }).join("") + '<button class="btn btn-secondary" id="printMy">Принтирай всички</button>';
    drawQrCodes(box);
  }

  // Обновява статусите (напр. потвърден превод, използван билет) от сървъра.
  function refreshMyTickets() {
    var orders = loadOrders();
    if (!orders.length) return;
    Promise.all(orders.map(function (o) {
      return api("GET", "/api/orders/" + encodeURIComponent(o.id) + "?email=" + encodeURIComponent(o.buyer.email))
        .then(function (d) { return d.order; }, function () { return o; });
    })).then(function (fresh) {
      if (JSON.stringify(fresh) === JSON.stringify(orders)) return;
      saveOrders(fresh);
      updateMyCount();
      if (!$("#view-my-tickets").hidden) renderMyTickets();
    });
  }

  function updateMyCount() {
    var n = loadOrders().reduce(function (s, o) { return s + o.tickets.length; }, 0);
    var b = $("#myTicketsCount");
    b.hidden = !n;
    b.textContent = n;
  }

  // ---------- Събития (event listeners) ----------
  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-nav],[data-event],[data-qty],[data-goto],#printTickets,#printMy");
    if (!t) return;
    if (t.hasAttribute("data-nav")) { e.preventDefault(); nav(t.getAttribute("data-nav")); }
    else if (t.hasAttribute("data-event")) {
      var id = t.getAttribute("data-event");
      if (!state.event || state.event.id !== id) { state.date = null; state.qty = {}; }
      state.event = DATA.events.filter(function (ev) { return ev.id === id; })[0];
      goStep(2);
    }
    else if (t.hasAttribute("data-qty")) changeQty(t.getAttribute("data-type"), +t.getAttribute("data-qty"));
    else if (t.hasAttribute("data-goto")) goStep(+t.getAttribute("data-goto"));
    else if (t.id === "printTickets" || t.id === "printMy") window.print();
  });

  document.addEventListener("change", function (e) {
    if (e.target.name === "visitDate") { state.date = e.target.value; renderSummaries(); }
    if (e.target.name === "payMethod") togglePayMethod();
    if (e.target.id === "wantInvoice") $("#invoiceFields").hidden = !e.target.checked;
  });

  $("#toDetails").addEventListener("click", function () {
    var err = "";
    if (!state.date) err = "Изберете ден на посещение.";
    else if (!calcTotals().count) err = "Изберете поне един билет.";
    else if (calcTotals().count === (state.qty.child || 0)) err = "Децата до 7 г. трябва да са придружени от възрастен с билет.";
    $("#ticketsError").textContent = err;
    if (!err) goStep(3);
  });

  $("#detailsForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var buyer = validateDetails();
    if (buyer) { state.buyer = buyer; togglePayMethod(); goStep(4); }
  });

  // Форматиране на полетата за карта
  $("#cardNumber").addEventListener("input", function (e) {
    var d = e.target.value.replace(/\D/g, "").slice(0, 19);
    e.target.value = d.replace(/(.{4})/g, "$1 ").trim();
  });
  $("#cardExp").addEventListener("input", function (e) {
    var d = e.target.value.replace(/\D/g, "").slice(0, 4);
    e.target.value = d.length > 2 ? d.slice(0, 2) + "/" + d.slice(2) : d;
  });
  $("#cardCvc").addEventListener("input", function (e) {
    e.target.value = e.target.value.replace(/\D/g, "").slice(0, 4);
  });

  $("#paymentForm").addEventListener("submit", function (e) {
    e.preventDefault();
    $("#paymentError").textContent = "";
    if (!validatePayment()) return;
    var btn = $("#payBtn");
    var tot = calcTotals();

    // Демонстрационен режим: тестова карта за отказано плащане.
    // При реален платежен оператор данните за картата се въвеждат на неговата страница
    // и НЕ се изпращат към нашия сървър.
    if (payMethod() === "card" && tot.total > 0 && $("#cardNumber").value.replace(/\D/g, "") === "4000000000000002") {
      $("#paymentError").textContent = "Плащането е отказано от банката. Опитайте с друга карта.";
      return;
    }

    btn.disabled = true;
    btn.textContent = "Обработка…";
    var b = state.buyer;
    api("POST", "/api/orders", {
      eventId: state.event.id,
      date: state.date,
      qty: state.qty,
      paymentMethod: payMethod(),
      buyer: {
        firstName: b.firstName, lastName: b.lastName, email: b.email, phone: b.phone,
        company: b.company, newsletter: b.newsletter, acceptTerms: b.acceptTerms, invoice: b.invoice
      }
    }).then(function (data) {
      btn.disabled = false;
      upsertOrder(data.order);
      $("#paymentForm").reset();
      renderDone(data.order, data.emailed);
      goStep5();
    }, function (err) {
      btn.disabled = false;
      renderSummaries();
      var fieldIds = Object.keys(err.fields || {});
      if (fieldIds.length) {
        goStep(3);
        fieldIds.forEach(function (id) { var el = $("#" + id); if (el) setError(el, err.fields[id]); });
        var first = $("#" + fieldIds[0]);
        if (first) first.focus();
        return;
      }
      $("#paymentError").textContent = err.message;
    });
  });

  function goStep5() {
    state.step = 5;
    $$("#stepper li").forEach(function (li) {
      var s = +li.getAttribute("data-step");
      li.classList.toggle("current", s === 5);
      li.classList.toggle("done", s < 5);
    });
    showView("view-done");
    // поръчката е завършена — следващата започва на чисто
    state.event = null; state.date = null; state.qty = {}; state.buyer = null;
    $("#detailsForm").reset();
    $("#invoiceFields").hidden = true;
  }

  $("#lookupForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var msg = $("#lookupMsg");
    var id = $("#lookupId").value.trim();
    var email = $("#lookupEmail").value.trim();
    if (!id || !EMAIL_RE.test(email)) { msg.textContent = "Въведете номер на поръчка и имейл."; return; }
    msg.textContent = "Търсене…";
    api("GET", "/api/orders/" + encodeURIComponent(id) + "?email=" + encodeURIComponent(email)).then(function (d) {
      upsertOrder(d.order);
      msg.textContent = "Поръчката е добавена.";
      $("#lookupForm").reset();
      renderMyTickets();
    }, function (err) { msg.textContent = err.message; });
  });

  function applyServerConfig(cfg) {
    var bank = cfg.bank || {};
    $("#bankRecipient").textContent = bank.recipient || "—";
    $("#bankIban").textContent = bank.iban || "—";
    $("#demoBanner").hidden = cfg.paymentMode !== "demo";
    if (!cfg.cardPayments) {
      var card = $('input[name="payMethod"][value="card"]');
      card.disabled = true;
      card.closest("label").title = "Плащането с карта временно не е достъпно";
      $('input[name="payMethod"][value="bank"]').checked = true;
      togglePayMethod();
    }
  }

  // ---------- Старт ----------
  var g = DATA.groupDiscount;
  $("#groupInfo").textContent = "Да — при покупка на " + g.minTickets + " или повече платени билета в една поръчка получавате " +
    g.percent + "% отстъпка автоматично. За организирани групи над 50 души се свържете с нас.";
  $("#venueText").textContent = DATA.venue;
  $("#year").textContent = new Date().getFullYear();
  updateMyCount();
  goStep(1);
  api("GET", "/api/config").then(applyServerConfig, function () { /* сървърът ще върне грешка при поръчка */ });
})();
