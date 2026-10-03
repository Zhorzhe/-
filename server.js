"use strict";

const config = require("./server/config");
const { openDb } = require("./server/db");
const { loadCatalog } = require("./server/catalog");
const { createMailer } = require("./server/mailer");
const { createApp } = require("./server/app");

const db = openDb(config.dbPath);
const catalog = loadCatalog();
const mailer = createMailer(config);
const app = createApp({ config, db, catalog, mailer });

const server = app.listen(config.port, () => {
  console.log("Онлайн билети: http://localhost:" + config.port);
  if (config.paymentMode === "demo") console.log("ВНИМАНИЕ: картовите плащания са в демонстрационен режим (PAYMENT_MODE=demo).");
  if (!config.mail.host) console.log("SMTP не е настроен – писмата се записват в", config.outboxDir);
  if (!config.adminToken) console.log("ADMIN_TOKEN не е зададен – администраторският API е изключен.");
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
