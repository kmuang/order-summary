const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, "data", "orders.json");

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function writeAll(data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function get(id) {
  if (!id) return null;
  return readAll()[id] || null;
}

function upsert(id, patch) {
  const all = readAll();
  all[id] = {
    ...(all[id] || {}),
    ...patch,
    id,
    updatedAt: new Date().toISOString(),
  };
  writeAll(all);
  return all[id];
}

module.exports = { get, upsert };
