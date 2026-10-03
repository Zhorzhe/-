"use strict";

// Зарежда каталога (събития, билети, цени) от същия файл, който ползва браузърът,
// за да има един източник на данни. Цените на сървъра са меродавни.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const DATA_FILE = path.join(__dirname, "..", "assets", "js", "data.js");

function loadCatalog(file = DATA_FILE) {
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(file, "utf8"), sandbox, { filename: file });
  const data = sandbox.window.FAIR_DATA;
  if (!data || !Array.isArray(data.events) || !Array.isArray(data.ticketTypes)) {
    throw new Error("Невалиден каталог в " + file);
  }
  // JSON копие, за да не държим обекти от друг vm контекст.
  return JSON.parse(JSON.stringify(data));
}

module.exports = { loadCatalog };
