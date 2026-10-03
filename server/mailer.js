"use strict";

const fs = require("node:fs");
const path = require("node:path");
const nodemailer = require("nodemailer");
const qrcode = require("../assets/vendor/qrcode-generator.js");

const MONTHS = ["януари", "февруари", "март", "април", "май", "юни", "юли", "август", "септември", "октомври", "ноември", "декември"];

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function fmtDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return d + " " + MONTHS[m - 1] + " " + y;
}
function fmtMoney(v) {
  return new Intl.NumberFormat("bg-BG", { style: "currency", currency: "EUR" }).format(v);
}

function qrGif(text) {
  // qrcode-generator дава GIF; пощенските клиенти го показват надеждно като прикачен (cid) файл.
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const dataUrl = qr.createDataURL(6, 8);
  return Buffer.from(dataUrl.split(",")[1], "base64");
}

function layout(title, inner) {
  return `<!doctype html><html lang="bg"><head><meta charset="utf-8"><title>${esc(title)}</title></head>
<body style="margin:0;background:#f4f6f9;font-family:Arial,Helvetica,sans-serif;color:#1b2430">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:12px">
<tr><td style="background:#0b5ea8;color:#fff;padding:18px 24px;border-radius:12px 12px 0 0;font-size:18px;font-weight:bold">Международен панаир Пловдив</td></tr>
<tr><td style="padding:24px">${inner}</td></tr>
</table></td></tr></table></body></html>`;
}

function ticketsEmail(order) {
  const attachments = [];
  const rows = order.tickets.map((t, i) => {
    const cid = "qr" + i + "@mpp";
    attachments.push({ filename: t.code + ".gif", content: qrGif(order.id + "|" + t.code), cid });
    const valid = t.validFor === "all"
      ? fmtDate(order.event.start) + " – " + fmtDate(order.event.end) + " (всички дни)"
      : fmtDate(t.validFor);
    return `<tr><td style="border:1px solid #dde3ea;border-left:8px solid ${esc(order.event.color || "#0b5ea8")};border-radius:8px;padding:14px">
<table role="presentation" width="100%"><tr>
<td valign="top" style="font-size:14px">
<b>${esc(order.event.title)}</b><br>
${esc(t.typeName)} · ${t.price ? fmtMoney(t.price) : "безплатен"}<br>
Дата: ${esc(valid)}<br>
Работно време: ${esc(order.event.hours)}<br>
<span style="font-family:monospace;color:#5f6b7a">${esc(t.code)}</span>
</td>
<td width="150" align="right" valign="top"><img src="cid:${cid}" width="150" height="150" alt="QR код ${esc(t.code)}"></td>
</tr></table></td></tr><tr><td style="height:12px"></td></tr>`;
  }).join("");

  const html = layout("Вашите билети", `
<h2 style="margin:0 0 8px">Благодарим за покупката, ${esc(order.buyer.firstName)}!</h2>
<p>Номер на поръчката: <b>${esc(order.id)}</b><br>Обща сума: <b>${fmtMoney(order.total)}</b></p>
<p>Покажете QR кода на всеки билет на входа – от телефона или разпечатан.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>
<p style="color:#5f6b7a;font-size:13px">Намаленият билет е валиден само с документ, удостоверяващ правото на намаление.</p>`);

  const text = [
    "Благодарим за покупката, " + order.buyer.firstName + "!",
    "Номер на поръчката: " + order.id,
    "Обща сума: " + fmtMoney(order.total),
    "",
    ...order.tickets.map((t) => "- " + t.typeName + " · " + (t.validFor === "all" ? "всички дни" : fmtDate(t.validFor)) + " · " + t.code)
  ].join("\n");

  return { subject: "Вашите билети – " + order.event.title + " (" + order.id + ")", html, text, attachments };
}

function bankEmail(order, bank) {
  const html = layout("Очаква плащане", `
<h2 style="margin:0 0 8px">Поръчката е регистрирана</h2>
<p>Здравейте, ${esc(order.buyer.firstName)}! Вашата поръчка за <b>${esc(order.event.title)}</b> очаква плащане.</p>
<table role="presentation" cellpadding="4" style="font-size:14px">
<tr><td style="color:#5f6b7a">Сума</td><td><b>${fmtMoney(order.total)}</b></td></tr>
<tr><td style="color:#5f6b7a">Получател</td><td>${esc(bank.recipient || "—")}</td></tr>
<tr><td style="color:#5f6b7a">IBAN</td><td>${esc(bank.iban || "—")}</td></tr>
${bank.bankName ? `<tr><td style="color:#5f6b7a">Банка</td><td>${esc(bank.bankName)}</td></tr>` : ""}
<tr><td style="color:#5f6b7a">Основание</td><td><b>${esc(order.id)}</b></td></tr>
</table>
<p>Билетите ще Ви бъдат изпратени на този имейл след постъпване на сумата. Резервацията е валидна 3 работни дни.</p>`);
  const text = "Поръчка " + order.id + " очаква плащане на " + fmtMoney(order.total) +
    ".\nПолучател: " + (bank.recipient || "—") + "\nIBAN: " + (bank.iban || "—") + "\nОснование: " + order.id;
  return { subject: "Очаква плащане – поръчка " + order.id, html, text, attachments: [] };
}

/**
 * Създава изпращач. Без SMTP_HOST писмата се записват като .eml файлове в outboxDir,
 * за да могат да се прегледат при разработка.
 */
function createMailer(cfg) {
  const smtp = !!cfg.mail.host;
  const transport = smtp
    ? nodemailer.createTransport({
        host: cfg.mail.host,
        port: cfg.mail.port,
        secure: cfg.mail.secure,
        auth: cfg.mail.user ? { user: cfg.mail.user, pass: cfg.mail.pass } : undefined
      })
    : nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "unix" });

  async function send(order, kind) {
    const msg = kind === "bank" ? bankEmail(order, cfg.bank) : ticketsEmail(order);
    const info = await transport.sendMail({
      from: cfg.mail.from,
      replyTo: cfg.mail.replyTo || undefined,
      to: order.buyer.email,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      attachments: msg.attachments
    });
    if (!smtp) {
      fs.mkdirSync(cfg.outboxDir, { recursive: true });
      const file = path.join(cfg.outboxDir, order.id + "-" + kind + "-" + Date.now() + ".eml");
      fs.writeFileSync(file, info.message);
      console.log("[mail] SMTP не е настроен – писмото е записано в", file);
    }
    return info;
  }

  return {
    sendTickets: (order) => send(order, "tickets"),
    sendBankInstructions: (order) => send(order, "bank")
  };
}

module.exports = { createMailer, ticketsEmail, bankEmail };
