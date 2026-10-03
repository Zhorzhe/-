"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { openDb } = require("../server/db");
const { loadCatalog } = require("../server/catalog");
const { createApp } = require("../server/app");
const { validateEik, todayIn } = require("../server/orders");
const { ticketsEmail } = require("../server/mailer");

const NOW = new Date("2026-10-21T08:00:00Z"); // 2-ри ден на есенния панаир (20–24 окт)

function setup(overrides = {}) {
  const sent = [];
  let now = NOW;
  const config = {
    ROOT: path.resolve(__dirname, ".."),
    trustProxy: 0,
    timeZone: "Europe/Sofia",
    adminToken: "secret-token",
    paymentMode: "demo",
    bank: { recipient: "Тест ЕАД", iban: "BG00TEST00000000000000", bankName: "" },
    ...overrides
  };
  const db = openDb(":memory:");
  const mailer = {
    sendTickets: async (o) => { sent.push(["tickets", o]); },
    sendBankInstructions: async (o) => { sent.push(["bank", o]); }
  };
  const app = createApp({ config, db, catalog: loadCatalog(), mailer, clock: () => now });
  const server = app.listen(0);
  const base = "http://127.0.0.1:" + server.address().port;
  return {
    sent,
    setNow: (d) => { now = d; },
    req: async (method, url, body, headers = {}) => {
      const res = await fetch(base + url, {
        method,
        headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* не е JSON */ }
      return { status: res.status, body: json, text };
    },
    close: () => { server.close(); db.close(); }
  };
}

const ADMIN = { authorization: "Bearer secret-token" };

function orderInput(extra = {}) {
  return {
    eventId: "autumn-fair",
    date: "2026-10-22",
    qty: { standard: 2, reduced: 1 },
    paymentMethod: "card",
    buyer: {
      firstName: "Иван", lastName: "Петров", email: "Ivan@Example.com", phone: "+359 88 123 4567",
      acceptTerms: true
    },
    ...extra
  };
}

test("създава платена поръчка с карта и изпраща билетите", async (t) => {
  const s = setup();
  t.after(s.close);
  const r = await s.req("POST", "/api/orders", orderInput());
  assert.equal(r.status, 201);
  const o = r.body.order;
  assert.match(o.id, /^MPP-2026-[A-Z2-9]{6}$/);
  assert.equal(o.status, "paid");
  assert.equal(o.total, 12.5);
  assert.equal(o.tickets.length, 3);
  assert.equal(new Set(o.tickets.map((x) => x.code)).size, 3);
  assert.equal(o.buyer.email, "ivan@example.com");
  assert.equal(o.buyer.phone, undefined, "телефонът не се връща публично");
  assert.equal(r.body.emailed, true);
  assert.deepEqual(s.sent.map((x) => x[0]), ["tickets"]);
});

test("цените се изчисляват на сървъра, групова отстъпка", async (t) => {
  const s = setup();
  t.after(s.close);
  const r = await s.req("POST", "/api/orders", orderInput({ qty: { standard: 10, child: 1 }, price: 0, total: 0 }));
  assert.equal(r.status, 201);
  assert.equal(r.body.order.subtotal, 50);
  assert.equal(r.body.order.discount, 5);
  assert.equal(r.body.order.total, 45);
});

test("банков превод: чака плащане, админ потвърждава, изпращат се билети", async (t) => {
  const s = setup();
  t.after(s.close);
  const r = await s.req("POST", "/api/orders", orderInput({ paymentMethod: "bank" }));
  assert.equal(r.body.order.status, "pending");
  assert.deepEqual(s.sent.map((x) => x[0]), ["bank"]);

  const code = r.body.order.tickets[0].code;
  const unpaid = await s.req("POST", "/api/admin/tickets/check", { code }, ADMIN);
  assert.equal(unpaid.body.result, "unpaid");

  const id = r.body.order.id;
  assert.equal((await s.req("POST", "/api/admin/orders/" + id + "/mark-paid", null, {})).status, 401);
  const paid = await s.req("POST", "/api/admin/orders/" + id + "/mark-paid", null, ADMIN);
  assert.equal(paid.status, 200);
  assert.equal(paid.body.order.status, "paid");
  assert.equal(paid.body.order.buyer.phone, "+359 88 123 4567");
  assert.deepEqual(s.sent.map((x) => x[0]), ["bank", "tickets"]);

  const again = await s.req("POST", "/api/admin/orders/" + id + "/mark-paid", null, ADMIN);
  assert.equal(again.status, 409);
});

test("не се допуска поръчка само с детски билети", async (t) => {
  const s = setup();
  t.after(s.close);
  const only = await s.req("POST", "/api/orders", orderInput({ qty: { child: 2 } }));
  assert.equal(only.status, 400);
  assert.match(only.body.error, /придружени/);
});

test("валидация на входните данни", async (t) => {
  const s = setup();
  t.after(s.close);
  const cases = [
    [{ eventId: "nope" }, /не е намерено/],
    [{ date: "2026-10-30" }, /ден на посещение/],
    [{ date: "2026-10-20" }, /минал/],
    [{ qty: {} }, /поне един/],
    [{ qty: { standard: 21 } }, /брой/],
    [{ qty: { standard: 1.5 } }, /брой/],
    [{ qty: { vip: 1 } }, /Непознат/],
    [{ paymentMethod: "cash" }, /метод/]
  ];
  for (const [patch, re] of cases) {
    const r = await s.req("POST", "/api/orders", orderInput(patch));
    assert.equal(r.status, 400, JSON.stringify(patch));
    assert.match(r.body.error, re);
  }

  const bad = await s.req("POST", "/api/orders", orderInput({
    buyer: { firstName: "", lastName: "X", email: "bad", phone: "1", acceptTerms: false,
      invoice: { company: "", eik: "121212124", vat: "123", mol: "", address: "" } }
  }));
  assert.equal(bad.status, 400);
  assert.deepEqual(Object.keys(bad.body.fields).sort(),
    ["acceptTerms", "email", "firstName", "invAddress", "invCompany", "invEik", "invMol", "invVat", "phone"]);
});

test("приключило събитие не може да се купи", async (t) => {
  const s = setup();
  t.after(s.close);
  s.setNow(new Date("2026-10-25T10:00:00Z"));
  const r = await s.req("POST", "/api/orders", orderInput());
  assert.equal(r.status, 400);
  assert.match(r.body.error, /приключило/);
});

test("картовите плащания са изключени извън демо режим", async (t) => {
  const s = setup({ paymentMode: "off" });
  t.after(s.close);
  const r = await s.req("POST", "/api/orders", orderInput());
  assert.equal(r.status, 503);
  const cfg = await s.req("GET", "/api/config");
  assert.equal(cfg.body.cardPayments, false);
  const bank = await s.req("POST", "/api/orders", orderInput({ paymentMethod: "bank" }));
  assert.equal(bank.status, 201);
});

test("търсене на поръчка изисква съвпадащ имейл", async (t) => {
  const s = setup();
  t.after(s.close);
  const { body } = await s.req("POST", "/api/orders", orderInput());
  const id = body.order.id;
  assert.equal((await s.req("GET", "/api/orders/" + id + "?email=other@example.com")).status, 404);
  assert.equal((await s.req("GET", "/api/orders/" + id)).status, 404);
  const ok = await s.req("GET", "/api/orders/" + id.toLowerCase() + "?email=IVAN@example.com");
  assert.equal(ok.status, 200);
  assert.equal(ok.body.order.tickets.length, 3);
});

test("проверка на билет на входа", async (t) => {
  const s = setup();
  t.after(s.close);
  const { body } = await s.req("POST", "/api/orders", orderInput({ qty: { standard: 1, multi: 1 } }));
  const std = body.order.tickets.find((x) => x.typeId === "standard");
  const multi = body.order.tickets.find((x) => x.typeId === "multi");

  // На 21 окт билетът за 22 окт не е валиден.
  assert.equal((await s.req("POST", "/api/admin/tickets/check", { code: std.code }, ADMIN)).body.result, "wrong_date");

  s.setNow(new Date("2026-10-22T09:00:00Z"));
  const qr = body.order.id + "|" + std.code;
  assert.equal((await s.req("POST", "/api/admin/tickets/check", { code: qr }, ADMIN)).body.result, "ok");
  const twice = await s.req("POST", "/api/admin/tickets/check", { code: std.code }, ADMIN);
  assert.equal(twice.body.result, "used");
  assert.ok(twice.body.ticket.usedAt);

  // Многократният билет минава всеки ден на събитието.
  assert.equal((await s.req("POST", "/api/admin/tickets/check", { code: multi.code }, ADMIN)).body.result, "ok");
  assert.equal((await s.req("POST", "/api/admin/tickets/check", { code: multi.code }, ADMIN)).body.result, "ok");

  assert.equal((await s.req("POST", "/api/admin/tickets/check", { code: "AAAA-BBBB-CCCC" }, ADMIN)).status, 404);
  assert.equal((await s.req("POST", "/api/admin/tickets/check", { code: std.code })).status, 401);

  const used = await s.req("GET", "/api/orders/" + body.order.id + "?email=ivan@example.com");
  assert.ok(used.body.order.tickets.find((x) => x.code === std.code).usedAt);
});

test("администраторският API е изключен без токен", async (t) => {
  const s = setup({ adminToken: "" });
  t.after(s.close);
  assert.equal((await s.req("GET", "/api/admin/orders", null, ADMIN)).status, 503);
});

test("списък с поръчки за администратора", async (t) => {
  const s = setup();
  t.after(s.close);
  await s.req("POST", "/api/orders", orderInput());
  await s.req("POST", "/api/orders", orderInput({ paymentMethod: "bank" }));
  assert.equal((await s.req("GET", "/api/admin/orders", null, ADMIN)).body.orders.length, 2);
  const pending = await s.req("GET", "/api/admin/orders?status=pending", null, ADMIN);
  assert.equal(pending.body.orders.length, 1);
  assert.equal(pending.body.orders[0].status, "pending");
});

test("невалиден JSON и статични файлове", async (t) => {
  const s = setup();
  t.after(s.close);
  const bad = await s.req("POST", "/api/orders", null, { "content-type": "application/json" });
  assert.equal(bad.status, 400);
  assert.equal((await s.req("GET", "/")).status, 200);
  assert.equal((await s.req("GET", "/assets/js/data.js")).status, 200);
  for (const p of ["/package.json", "/server/config.js", "/data/tickets.db", "/.env"]) {
    assert.equal((await s.req("GET", p)).status, 404, p);
  }
});

test("ЕИК и часова зона", () => {
  assert.equal(validateEik("121212121"), true);
  assert.equal(validateEik("121212124"), false);
  assert.equal(validateEik("12345"), false);
  assert.equal(todayIn("Europe/Sofia", new Date("2026-10-20T22:30:00Z")), "2026-10-21");
});

test("имейлът с билети съдържа QR кодовете и екранира данните", () => {
  const msg = ticketsEmail({
    id: "MPP-2026-ABCDEF", total: 5,
    event: { title: "Тест <b>", start: "2026-10-20", end: "2026-10-24", hours: "10–18", color: "#000" },
    buyer: { firstName: "<script>", email: "a@b.bg" },
    tickets: [{ code: "AAAA-BBBB-CCCC", typeName: "Стандартен", price: 5, validFor: "2026-10-22" }]
  });
  assert.equal(msg.attachments.length, 1);
  assert.ok(msg.html.includes("cid:qr0@mpp"));
  assert.ok(!msg.html.includes("<script>"));
  assert.ok(msg.html.includes("Тест &lt;b&gt;"));
});
