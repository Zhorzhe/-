"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const express = require("express");

const { ValidationError, buildOrder, serializeOrder, serializeOrderAdmin, todayIn } = require("./orders");

/** Просто ограничение на заявките по IP (фиксиран прозорец, в паметта). */
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    const now = Date.now();
    let h = hits.get(req.ip);
    if (!h || h.reset <= now) {
      h = { count: 0, reset: now + windowMs };
      hits.set(req.ip, h);
    }
    if (++h.count > max) {
      res.set("Retry-After", String(Math.ceil((h.reset - now) / 1000)));
      return res.status(429).json({ error: "Твърде много заявки. Опитайте отново след малко." });
    }
    next();
  };
}

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * @param {object} deps
 * @param {object} deps.config   – виж config.js
 * @param {object} deps.db       – виж db.js
 * @param {object} deps.catalog  – събития и билети
 * @param {object} deps.mailer   – { sendTickets, sendBankInstructions }
 * @param {() => Date} [deps.clock]
 */
function createApp({ config, db, catalog, mailer, clock = () => new Date() }) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);

  app.use((req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "same-origin");
    res.set("X-Frame-Options", "DENY");
    next();
  });

  // ---------- Статични файлове (само публичните) ----------
  const root = config.ROOT;
  app.use("/assets", express.static(path.join(root, "assets"), { maxAge: "1h" }));
  app.get(["/", "/index.html"], (req, res) => res.sendFile(path.join(root, "index.html")));
  app.get(["/scan", "/scan.html"], (req, res) => res.sendFile(path.join(root, "scan.html")));

  const api = express.Router();
  api.use(express.json({ limit: "20kb" }));
  api.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  async function notify(orderRow) {
    const order = serializeOrder(orderRow, db.getTickets(orderRow.id), catalog);
    try {
      if (order.status === "paid") await mailer.sendTickets(order);
      else if (order.status === "pending") await mailer.sendBankInstructions(order);
      db.markEmailed(order.id, clock().toISOString());
      return true;
    } catch (err) {
      console.error("[mail] Грешка при изпращане за поръчка", order.id, err.message);
      return false;
    }
  }

  // ---------- Публичен API ----------
  api.get("/config", (req, res) => {
    res.json({
      paymentMode: config.paymentMode,
      cardPayments: config.paymentMode === "demo",
      bank: config.bank
    });
  });

  api.get("/catalog", (req, res) => res.json(catalog));

  api.post("/orders", rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }), async (req, res, next) => {
    try {
      const { order, tickets } = buildOrder(req.body, {
        catalog,
        timeZone: config.timeZone,
        paymentMode: config.paymentMode,
        now: clock()
      });
      db.insertOrder(order, tickets);
      const row = db.getOrder(order.id);
      const emailed = await notify(row);
      res.status(201).json({ order: serializeOrder(row, db.getTickets(order.id), catalog), emailed });
    } catch (err) {
      next(err);
    }
  });

  // Търсене на поръчка по номер и имейл (за „Моите билети“ на друго устройство).
  api.get("/orders/:id", rateLimit({ windowMs: 15 * 60 * 1000, max: 60 }), (req, res) => {
    const row = db.getOrder(String(req.params.id).trim().toUpperCase());
    const email = String(req.query.email || "").trim().toLowerCase();
    if (!row || !email || row.email !== email) {
      return res.status(404).json({ error: "Не е намерена поръчка с този номер и имейл." });
    }
    res.json({ order: serializeOrder(row, db.getTickets(row.id), catalog) });
  });

  // ---------- Достъп с токен ----------
  // Връща ролята за подадения токен: "admin", "scanner" или null.
  function roleFor(req) {
    const m = /^Bearer (.+)$/.exec(req.get("authorization") || "");
    if (!m) return null;
    if (config.adminToken && safeEqual(m[1], config.adminToken)) return "admin";
    if (config.scannerToken && safeEqual(m[1], config.scannerToken)) return "scanner";
    return null;
  }
  // Броят се само неуспешните опити, за да не се спират скенерите на оживен вход.
  const failedAuth = new Map();
  const AUTH_WINDOW = 15 * 60 * 1000;
  const AUTH_MAX_FAILS = 20;
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of failedAuth) if (v.reset <= now) failedAuth.delete(k);
  }, AUTH_WINDOW).unref();
  function requireRole(...roles) {
    return (req, res, next) => {
      if (!config.adminToken && !config.scannerToken) {
        return res.status(503).json({ error: "Достъпът не е настроен (ADMIN_TOKEN / SCANNER_TOKEN)." });
      }
      const now = Date.now();
      let f = failedAuth.get(req.ip);
      if (f && f.reset <= now) { failedAuth.delete(req.ip); f = null; }
      if (f && f.count >= AUTH_MAX_FAILS) {
        return res.status(429).json({ error: "Твърде много неуспешни опити. Опитайте по-късно." });
      }
      const role = roleFor(req);
      if (!role || !roles.includes(role)) {
        if (!role) {
          if (!f) { f = { count: 0, reset: now + AUTH_WINDOW }; failedAuth.set(req.ip, f); }
          f.count++;
        }
        return res.status(401).json({ error: "Неоторизиран достъп." });
      }
      req.role = role;
      next();
    };
  }

  // ---------- Администраторски API ----------
  const admin = express.Router();
  admin.use(requireRole("admin"));

  admin.get("/orders", (req, res) => {
    const status = ["paid", "pending", "cancelled"].includes(req.query.status) ? req.query.status : null;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const rows = db.listOrders(status, limit, offset);
    res.json({ orders: rows.map((r) => serializeOrderAdmin(r, db.getTickets(r.id), catalog)) });
  });

  admin.get("/orders/:id", (req, res) => {
    const row = db.getOrder(req.params.id);
    if (!row) return res.status(404).json({ error: "Поръчката не е намерена." });
    res.json({ order: serializeOrderAdmin(row, db.getTickets(row.id), catalog) });
  });

  // Потвърждаване на получен банков превод – билетите стават валидни и се изпращат.
  admin.post("/orders/:id/mark-paid", async (req, res) => {
    const row = db.getOrder(req.params.id);
    if (!row) return res.status(404).json({ error: "Поръчката не е намерена." });
    if (!db.markPaid(row.id, clock().toISOString())) {
      return res.status(409).json({ error: "Поръчката не очаква плащане (статус: " + row.status + ")." });
    }
    const updated = db.getOrder(row.id);
    const emailed = await notify(updated);
    res.json({ order: serializeOrderAdmin(updated, db.getTickets(row.id), catalog), emailed });
  });

  api.use("/admin", admin);

  // ---------- Проверка на билети на входа (контрольори и администратори) ----------
  const scan = express.Router();
  scan.use(requireRole("admin", "scanner"));

  // Проверка на токена при вход в страницата за сканиране.
  scan.get("/me", (req, res) => {
    const today = todayIn(config.timeZone, clock());
    const events = catalog.events
      .filter((e) => e.start <= today && today <= e.end)
      .map((e) => ({ id: e.id, title: e.title, hours: e.hours }));
    res.json({ role: req.role, today, events });
  });

  // Проверка на билет на входа. Приема кода или съдържанието на QR кода („поръчка|код“).
  scan.post("/check", (req, res) => {
    const raw = String((req.body && req.body.code) || "").trim().toUpperCase();
    const code = raw.includes("|") ? raw.split("|").pop() : raw;
    const t = code && db.getTicket(code);
    if (!t) return res.status(404).json({ result: "not_found", message: "Билетът не е намерен." });

    const order = db.getOrder(t.order_id);
    const ev = catalog.events.find((e) => e.id === order.event_id);
    const info = {
      code: t.code, orderId: order.id, typeName: t.type_name, validFor: t.valid_for,
      event: ev ? ev.title : order.event_id, holder: order.first_name + " " + order.last_name
    };
    if (order.status !== "paid") return res.status(409).json({ result: "unpaid", message: "Поръчката не е платена.", ticket: info });

    const today = todayIn(config.timeZone, clock());
    const validToday = t.valid_for === "all" ? ev && ev.start <= today && today <= ev.end : t.valid_for === today;
    if (!validToday) return res.status(409).json({ result: "wrong_date", message: "Билетът не е за днешния ден.", ticket: info });

    // Многократният билет може да се ползва всеки ден; останалите – еднократно.
    if (t.valid_for !== "all") {
      if (!db.useTicket(t.code, clock().toISOString())) {
        return res.status(409).json({ result: "used", message: "Билетът вече е използван.", ticket: { ...info, usedAt: db.getTicket(t.code).used_at } });
      }
    }
    res.json({ result: "ok", message: "Валиден билет.", ticket: info });
  });

  api.use("/scan", scan);

  api.use((req, res) => res.status(404).json({ error: "Не е намерено." }));

  // eslint-disable-next-line no-unused-vars
  api.use((err, req, res, next) => {
    if (err instanceof ValidationError) {
      return res.status(err.status || 400).json({ error: err.message, fields: err.fields });
    }
    if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Невалидна заявка." });
    if (err.type === "entity.too.large") return res.status(413).json({ error: "Заявката е твърде голяма." });
    console.error(err);
    res.status(500).json({ error: "Вътрешна грешка. Опитайте отново." });
  });

  app.use("/api", api);
  app.use((req, res) => res.status(404).send("Страницата не е намерена."));
  return app;
}

module.exports = { createApp };
