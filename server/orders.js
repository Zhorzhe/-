"use strict";

const crypto = require("node:crypto");

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^\+?[0-9 ()-]{8,18}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

class ValidationError extends Error {
  constructor(message, fields) {
    super(message);
    this.fields = fields || {};
  }
}

function randomCode(len) {
  let out = "";
  for (let i = 0; i < len; i++) out += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  return out;
}

const cents = (eur) => Math.round(eur * 100);

/** Днешната дата (ГГГГ-ММ-ДД) в часовата зона на панаира. */
function todayIn(timeZone, now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function eventDays(ev) {
  const days = [];
  const d = new Date(ev.start + "T00:00:00Z");
  const end = new Date(ev.end + "T00:00:00Z");
  for (; d <= end; d.setUTCDate(d.getUTCDate() + 1)) days.push(d.toISOString().slice(0, 10));
  return days;
}

function validateEik(v) {
  if (!/^\d{9}(\d{4})?$/.test(v)) return false;
  const d = v.split("").map(Number);
  let s = 0, r;
  for (let i = 0; i < 8; i++) s += d[i] * (i + 1);
  r = s % 11;
  if (r === 10) {
    s = 0;
    for (let i = 0; i < 8; i++) s += d[i] * (i + 3);
    r = s % 11;
    if (r === 10) r = 0;
  }
  if (r !== d[8]) return false;
  if (d.length === 13) {
    const w1 = [2, 7, 3, 5], w2 = [4, 9, 5, 7];
    s = 0;
    for (let i = 0; i < 4; i++) s += d[8 + i] * w1[i];
    r = s % 11;
    if (r === 10) {
      s = 0;
      for (let i = 0; i < 4; i++) s += d[8 + i] * w2[i];
      r = s % 11;
      if (r === 10) r = 0;
    }
    if (r !== d[12]) return false;
  }
  return true;
}

function str(v, max) {
  if (typeof v !== "string") return "";
  return v.trim().slice(0, max);
}

function validateBuyer(b) {
  const errors = {};
  b = b && typeof b === "object" ? b : {};
  const buyer = {
    firstName: str(b.firstName, 100),
    lastName: str(b.lastName, 100),
    email: str(b.email, 254).toLowerCase(),
    phone: str(b.phone, 30),
    company: str(b.company, 200),
    newsletter: b.newsletter === true,
    invoice: null
  };
  if (!buyer.firstName) errors.firstName = "Полето е задължително.";
  if (!buyer.lastName) errors.lastName = "Полето е задължително.";
  if (!EMAIL_RE.test(buyer.email)) errors.email = "Невалиден имейл адрес.";
  if (!PHONE_RE.test(buyer.phone)) errors.phone = "Невалиден телефонен номер.";
  if (b.acceptTerms !== true) errors.acceptTerms = "Необходимо е да приемете условията.";

  if (b.invoice) {
    const i = b.invoice;
    const inv = {
      company: str(i.company, 200),
      eik: str(i.eik, 13),
      vat: str(i.vat, 12).toUpperCase(),
      mol: str(i.mol, 200),
      address: str(i.address, 300)
    };
    if (!inv.company) errors.invCompany = "Полето е задължително.";
    if (!validateEik(inv.eik)) errors.invEik = "Невалиден ЕИК/БУЛСТАТ.";
    if (inv.vat && !/^BG\d{9,10}$/.test(inv.vat)) errors.invVat = "Форматът е BG и 9 или 10 цифри.";
    if (!inv.mol) errors.invMol = "Полето е задължително.";
    if (!inv.address) errors.invAddress = "Полето е задължително.";
    buyer.invoice = inv;
  }
  return { buyer, errors };
}

/**
 * Проверява заявка за поръчка и изчислява сумите по цените от каталога.
 * Връща готови за запис редове или хвърля ValidationError.
 */
function buildOrder(input, { catalog, timeZone, paymentMode, now = new Date() }) {
  input = input && typeof input === "object" ? input : {};

  const ev = catalog.events.find((e) => e.id === input.eventId);
  if (!ev) throw new ValidationError("Събитието не е намерено.");

  const today = todayIn(timeZone, now);
  if (ev.end < today) throw new ValidationError("Събитието е приключило.");

  const date = input.date;
  if (typeof date !== "string" || !DATE_RE.test(date) || !eventDays(ev).includes(date)) {
    throw new ValidationError("Невалиден ден на посещение.");
  }
  if (date < today) throw new ValidationError("Избраният ден вече е минал.");

  const qtyIn = input.qty && typeof input.qty === "object" ? input.qty : {};
  for (const key of Object.keys(qtyIn)) {
    if (!catalog.ticketTypes.some((t) => t.id === key)) throw new ValidationError("Непознат вид билет: " + key);
  }

  const lines = [];
  let count = 0, paidCount = 0, subtotal = 0;
  for (const t of catalog.ticketTypes) {
    const q = qtyIn[t.id] === undefined ? 0 : qtyIn[t.id];
    if (!Number.isInteger(q) || q < 0 || q > catalog.maxPerType) {
      throw new ValidationError("Невалиден брой билети „" + t.name + "“.");
    }
    if (!q) continue;
    lines.push({ type: t, qty: q });
    count += q;
    if (t.price > 0) paidCount += q;
    subtotal += q * cents(t.price);
  }
  if (!count) throw new ValidationError("Изберете поне един билет.");
  if (lines.every((l) => l.type.id === "child")) {
    throw new ValidationError("Децата до 7 г. трябва да са придружени от възрастен с билет.");
  }

  const g = catalog.groupDiscount;
  const discount = g && paidCount >= g.minTickets ? Math.round((subtotal * g.percent) / 100) : 0;
  const total = subtotal - discount;

  const { buyer, errors } = validateBuyer(input.buyer);
  if (Object.keys(errors).length) throw new ValidationError("Проверете данните за купувача.", errors);

  let paymentMethod;
  if (total === 0) paymentMethod = "free";
  else if (input.paymentMethod === "bank") paymentMethod = "bank";
  else if (input.paymentMethod === "card") {
    if (paymentMode !== "demo") {
      const e = new ValidationError("Плащането с карта временно не е достъпно.");
      e.status = 503;
      throw e;
    }
    paymentMethod = "card";
  } else throw new ValidationError("Невалиден метод на плащане.");

  const createdAt = now.toISOString();
  const status = paymentMethod === "bank" ? "pending" : "paid";
  const id = "MPP-" + today.slice(0, 4) + "-" + randomCode(6);

  const order = {
    id,
    created_at: createdAt,
    status,
    payment_method: paymentMethod,
    event_id: ev.id,
    visit_date: date,
    first_name: buyer.firstName,
    last_name: buyer.lastName,
    email: buyer.email,
    phone: buyer.phone,
    company: buyer.company || null,
    newsletter: buyer.newsletter ? 1 : 0,
    invoice_json: buyer.invoice ? JSON.stringify(buyer.invoice) : null,
    subtotal_cents: subtotal,
    discount_cents: discount,
    total_cents: total,
    paid_at: status === "paid" ? createdAt : null
  };

  const tickets = [];
  for (const l of lines) {
    for (let i = 0; i < l.qty; i++) {
      tickets.push({
        code: randomCode(4) + "-" + randomCode(4) + "-" + randomCode(4),
        order_id: id,
        type_id: l.type.id,
        type_name: l.type.name,
        price_cents: cents(l.type.price),
        valid_for: l.type.allDays ? "all" : date
      });
    }
  }
  return { order, tickets };
}

/** Публичен вид на поръчка – същата структура, която ползва фронтендът. */
function serializeOrder(row, ticketRows, catalog) {
  const ev = catalog.events.find((e) => e.id === row.event_id) || { id: row.event_id, title: row.event_id };
  return {
    id: row.id,
    createdAt: row.created_at,
    status: row.status,
    paymentMethod: row.payment_method,
    event: {
      id: ev.id, title: ev.title, start: ev.start, end: ev.end,
      hours: ev.hours, pavilions: ev.pavilions, color: ev.color
    },
    date: row.visit_date,
    buyer: { firstName: row.first_name, lastName: row.last_name, email: row.email },
    subtotal: row.subtotal_cents / 100,
    discount: row.discount_cents / 100,
    total: row.total_cents / 100,
    tickets: ticketRows.map((t) => ({
      code: t.code,
      typeId: t.type_id,
      typeName: t.type_name,
      price: t.price_cents / 100,
      validFor: t.valid_for,
      usedAt: t.used_at || null
    }))
  };
}

/** Пълен вид за администратора (с телефон и данни за фактура). */
function serializeOrderAdmin(row, ticketRows, catalog) {
  const o = serializeOrder(row, ticketRows, catalog);
  o.buyer.phone = row.phone;
  o.buyer.company = row.company;
  o.buyer.newsletter = !!row.newsletter;
  o.buyer.invoice = row.invoice_json ? JSON.parse(row.invoice_json) : null;
  o.paidAt = row.paid_at;
  o.emailSentAt = row.email_sent_at;
  return o;
}

module.exports = {
  ValidationError,
  buildOrder,
  serializeOrder,
  serializeOrderAdmin,
  todayIn,
  eventDays,
  validateEik
};
