"use strict";

const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

module.exports = {
  ROOT,
  port: Number(env("PORT", 3000)),
  // Брой обратни проксита пред приложението (за правилен IP при ограничаването на заявки).
  trustProxy: Number(env("TRUST_PROXY", 0)),
  dbPath: env("DB_PATH", path.join(ROOT, "data", "tickets.db")),
  outboxDir: env("OUTBOX_DIR", path.join(ROOT, "data", "outbox")),
  timeZone: env("TIME_ZONE", "Europe/Sofia"),

  // Токен за администраторските заявки (потвърждаване на преводи, проверка на билети).
  // Без него администраторските заявки са изключени.
  adminToken: env("ADMIN_TOKEN", ""),

  // "demo" – картовите плащания се приемат без реално таксуване.
  // Друга стойност изключва картовите плащания, докато не се свърже платежен оператор.
  paymentMode: env("PAYMENT_MODE", "demo"),

  bank: {
    recipient: env("BANK_RECIPIENT", ""),
    iban: env("BANK_IBAN", ""),
    bankName: env("BANK_NAME", "")
  },

  mail: {
    host: env("SMTP_HOST", ""),
    port: Number(env("SMTP_PORT", 587)),
    secure: env("SMTP_SECURE", "false") === "true",
    user: env("SMTP_USER", ""),
    pass: env("SMTP_PASS", ""),
    from: env("MAIL_FROM", "Международен панаир Пловдив <tickets@example.com>"),
    replyTo: env("MAIL_REPLY_TO", "")
  }
};
