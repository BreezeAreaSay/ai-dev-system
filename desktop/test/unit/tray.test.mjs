import assert from "node:assert/strict";
import test from "node:test";
import zlib from "node:zlib";
import { TRAY_COLOURS, circlePng, trayState } from "../../src/main/tray-icon.mjs";
import { trayMenuTemplate } from "../../src/main/tray.mjs";
import { translate } from "../../src/renderer/i18n.js";

/** The chunks of a PNG, checked: length, type, CRC. */
function chunks(png) {
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const found = [];
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at);
    const type = png.toString("ascii", at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + length);
    assert.equal(png.readUInt32BE(at + 8 + length), zlib.crc32(png.subarray(at + 4, at + 8 + length)) >>> 0, `${type} CRC`);
    found.push({ type, data });
    at += 12 + length;
  }
  return found;
}

test("the tray icon is a valid RGBA PNG: the colour in the middle, transparency in the corner", () => {
  const png = circlePng(TRAY_COLOURS.ok, 32);
  const parts = chunks(png);
  assert.deepEqual(parts.map((part) => part.type), ["IHDR", "IDAT", "IEND"]);
  const header = parts[0].data;
  assert.deepEqual([header.readUInt32BE(0), header.readUInt32BE(4), header[8], header[9]], [32, 32, 8, 6]);
  const pixels = zlib.inflateSync(parts[1].data);
  assert.equal(pixels.length, 32 * (1 + 32 * 4));
  const pixel = (x, y) => [...pixels.subarray(y * 129 + 1 + x * 4, y * 129 + 1 + x * 4 + 4)];
  assert.deepEqual(pixel(16, 16), [...TRAY_COLOURS.ok, 255]);
  assert.equal(pixel(0, 0)[3], 0);
  assert.throws(() => circlePng(TRAY_COLOURS.ok, 4), /size must be/);
});

test("the tray's colour follows system_status, and its menu what can be done now", () => {
  assert.deepEqual([{ status: "ok" }, { status: "degraded" }, { status: "failed" }, { status: "odd" }, null].map(trayState), ["ok", "degraded", "failed", "offline", "offline"]);
  const t = (key, params) => translate("en", key, params);
  const noop = () => undefined;
  const actions = { open: noop, rebuild: noop, stop: noop, quit: noop };
  const items = (view) => trayMenuTemplate({ t, ...view }, actions).filter((item) => item.id).map(({ id, label, enabled = true }) => [id, label, enabled]);
  assert.deepEqual(items({ online: true, rebuilding: null }), [
    ["open", "Open AI Dev", true], ["rebuild", "Rebuild search index", true], ["stop", "Stop the daemon", true], ["quit", "Quit", true]
  ]);
  assert.deepEqual(items({ online: true, rebuilding: 40 }).find(([id]) => id === "rebuild"), ["rebuild", "Rebuilding the index… 40%", false]);
  assert.deepEqual(items({ online: false, rebuilding: null }).filter(([, , enabled]) => !enabled).map(([id]) => id), ["rebuild", "stop"]);
});

test("each state is drawn in its own colour, and a failed rebuild is said in the menu (Д-254, Д-257 п. 5)", async () => {
  const { EventEmitter } = await import("node:events");
  const { createTray } = await import("../../src/main/tray.mjs");
  const made = [];
  const set = [];
  let menu = [];
  const electron = {
    nativeImage: { createFromBuffer: (buffer) => { const image = { buffer }; made.push(image); return image; } },
    Tray: class {
      setImage(image) { set.push(image); }
      setToolTip(text) { this.tip = text; }
      setContextMenu(template) { menu = template; }
      on() {}
    },
    Menu: { buildFromTemplate: (template) => template }
  };
  const link = Object.assign(new EventEmitter(), { state: { phase: "online" }, status: null });
  const t = (key, params) => translate("en", key, params);
  const tray = createTray({ electron, link, t, actions: { open() {}, rebuild() {}, stop() {}, quit() {} } });
  const colours = Object.keys(TRAY_COLOURS);
  assert.equal(new Set(colours.map((state) => String(TRAY_COLOURS[state]))).size, colours.length, "four different colours");
  for (const state of ["ok", "degraded", "failed"]) {
    link.status = { status: state };
    link.emit("status", link.status);
    assert.equal(tray.state(), state);
    assert.ok(set.at(-1).buffer.equals(circlePng(TRAY_COLOURS[state], 32)), `${state} is drawn in its colour`);
  }
  link.state = { phase: "offline" };
  link.emit("state", link.state);
  assert.ok(set.at(-1).buffer.equals(circlePng(TRAY_COLOURS.offline, 32)));
  tray.setRebuilding(null, "The index folder is a file.");
  assert.equal(tray.menu().find((item) => item.id === "rebuild").label, "Rebuild failed — try again");
  assert.match(tray.tray.tip, /\nThe last rebuild failed: The index folder is a file\.$/, "and why, in the tooltip");
  tray.setRebuilding(10);
  assert.equal(tray.menu().find((item) => item.id === "rebuild").label, "Rebuilding the index… 10%");
  tray.setRebuilding(null);
  assert.equal(tray.menu().find((item) => item.id === "rebuild").label, "Rebuild search index");
  assert.ok(menu.length > 0);
  // A Stop that failed is said too, with why in the tooltip, until the next one (Д-271, п. 6) —
  // in the menu Electron is given, which is the one the person sees (Д-275).
  const native = () => menu.find((item) => item.id === "stop");
  link.state = { phase: "online" };
  tray.setStopFailed("No handshake within 5000 ms");
  assert.deepEqual([native().label, native().enabled], ["Stop failed — try again", true]);
  assert.deepEqual(tray.menu().find((item) => item.id === "stop"), { id: "stop", label: "Stop failed — try again", enabled: true });
  assert.match(tray.tray.tip, /The daemon did not stop: No handshake within 5000 ms/);
  assert.equal(tray.tooltip(), tray.tray.tip);
  tray.setStopFailed(null);
  assert.equal(native().label, "Stop the daemon");
  assert.doesNotMatch(tray.tray.tip, /did not stop/);
  // The note was about the daemon the app was on: once the app is off it, it goes (Д-276, п. 1).
  tray.setStopFailed("No handshake within 5000 ms");
  link.state = { phase: "offline" };
  link.emit("state", link.state);
  assert.equal(native().label, "Stop the daemon");
  assert.doesNotMatch(tray.tray.tip, /did not stop/);
  link.state = { phase: "online" };
  link.emit("state", link.state);
  assert.equal(native().label, "Stop the daemon", "not back on the next daemon");
});
