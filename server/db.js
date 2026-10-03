"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS orders (
  id             TEXT PRIMARY KEY,
  created_at     TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('paid', 'pending', 'cancelled')),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('card', 'bank', 'free')),
  event_id       TEXT NOT NULL,
  visit_date     TEXT NOT NULL,
  first_name     TEXT NOT NULL,
  last_name      TEXT NOT NULL,
  email          TEXT NOT NULL,
  phone          TEXT NOT NULL,
  company        TEXT,
  newsletter     INTEGER NOT NULL DEFAULT 0,
  invoice_json   TEXT,
  subtotal_cents INTEGER NOT NULL,
  discount_cents INTEGER NOT NULL,
  total_cents    INTEGER NOT NULL,
  paid_at        TEXT,
  email_sent_at  TEXT
);
CREATE INDEX IF NOT EXISTS orders_status ON orders(status);

CREATE TABLE IF NOT EXISTS tickets (
  code        TEXT PRIMARY KEY,
  order_id    TEXT NOT NULL REFERENCES orders(id),
  type_id     TEXT NOT NULL,
  type_name   TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  valid_for   TEXT NOT NULL,
  used_at     TEXT
);
CREATE INDEX IF NOT EXISTS tickets_order ON tickets(order_id);
`;

function openDb(file) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);

  const q = {
    insertOrder: db.prepare(`INSERT INTO orders (id, created_at, status, payment_method, event_id, visit_date,
      first_name, last_name, email, phone, company, newsletter, invoice_json,
      subtotal_cents, discount_cents, total_cents, paid_at)
      VALUES (:id, :created_at, :status, :payment_method, :event_id, :visit_date,
      :first_name, :last_name, :email, :phone, :company, :newsletter, :invoice_json,
      :subtotal_cents, :discount_cents, :total_cents, :paid_at)`),
    insertTicket: db.prepare(`INSERT INTO tickets (code, order_id, type_id, type_name, price_cents, valid_for)
      VALUES (:code, :order_id, :type_id, :type_name, :price_cents, :valid_for)`),
    getOrder: db.prepare("SELECT * FROM orders WHERE id = ?"),
    getTickets: db.prepare("SELECT * FROM tickets WHERE order_id = ? ORDER BY rowid"),
    getTicket: db.prepare("SELECT * FROM tickets WHERE code = ?"),
    listOrders: db.prepare("SELECT * FROM orders ORDER BY created_at DESC LIMIT ? OFFSET ?"),
    listOrdersByStatus: db.prepare("SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?"),
    markPaid: db.prepare("UPDATE orders SET status = 'paid', paid_at = ? WHERE id = ? AND status = 'pending'"),
    markEmailed: db.prepare("UPDATE orders SET email_sent_at = ? WHERE id = ?"),
    useTicket: db.prepare("UPDATE tickets SET used_at = ? WHERE code = ? AND used_at IS NULL")
  };

  function transaction(fn) {
    db.exec("BEGIN");
    try {
      const r = fn();
      db.exec("COMMIT");
      return r;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  return {
    raw: db,
    close: () => db.close(),

    insertOrder(order, tickets) {
      transaction(() => {
        q.insertOrder.run(order);
        for (const t of tickets) q.insertTicket.run(t);
      });
    },
    getOrder: (id) => q.getOrder.get(id),
    getTickets: (orderId) => q.getTickets.all(orderId),
    getTicket: (code) => q.getTicket.get(code),
    listOrders(status, limit, offset) {
      return status ? q.listOrdersByStatus.all(status, limit, offset) : q.listOrders.all(limit, offset);
    },
    markPaid: (id, at) => q.markPaid.run(at, id).changes === 1,
    markEmailed: (id, at) => q.markEmailed.run(at, id),
    useTicket: (code, at) => q.useTicket.run(at, code).changes === 1
  };
}

module.exports = { openDb };
