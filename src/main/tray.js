const { Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const { moodFor } = require('./mood');
const { tr } = require('./lang');

// CYL Audio Hub's tray. There is always exactly one main icon: left click opens the window, right
// click opens the menu (profiles, microphone, EQ, batteries, settings, quit), which is built at the
// moment it opens so it never shows stale state and nothing has to poll to keep it current.
// Optional extra icons, one per battery device ('perDevice' layout), can be turned on in Settings.
//
// Glyphs are PRE-RENDERED PNG files (assets/tray/*.png, built by scripts/make-icon.js) — the
// app never runs a canvas / hidden window / builds a COM image at runtime, which was crashing
// Windows' shell COM layer (combase.dll). Here we just load the matching file for a Tray.

const TRAY_DIR = path.join(__dirname, '..', '..', 'assets', 'tray');
const APP_ICON = path.join(__dirname, '..', '..', 'assets', 'icon.png');

let handlers = { open: () => {}, quit: () => {}, flyout: () => {}, menu: null, tooltip: null };
let mode = 'list';
let perDeviceIcons = true; // the 'trayEnabled' setting: extra per-device icons allowed
const devices = new Map();     // id -> info { name, capacity, charging, offline }  (source of truth)
const perTrays = new Map();    // id -> { tray, lastKey }   (perDevice mode)
let mainTray = null;
let mainKey = '';
const imageCache = new Map();  // file -> nativeImage

function setHandlers(open, quit, flyout, menu, tooltip) {
  handlers = { open, quit, flyout, menu, tooltip };
}

function cached(file) {
  let img = imageCache.get(file);
  if (!img) {
    img = nativeImage.createFromPath(file);
    if (file === APP_ICON) img = img.resize({ width: 16, height: 16, quality: 'best' });
    imageCache.set(file, img);
  }
  return img;
}

function imageFile(fill, charging, offline) {
  if (offline || fill == null) return 'tray-offline.png';
  if (charging) return 'tray-charging.png';
  const bucket = Math.max(0, Math.min(100, Math.round(fill / 5) * 5));
  return `tray-${bucket}.png`;
}

function statusText(info) {
  if (info.offline || info.capacity == null) return tr(info.offLabel || 'Not connected');
  if (info.charging) return tr(`Charging, ${info.capacity}%`);
  return `${info.capacity}%`;
}

// ---- main icon ----

function ensureMain() {
  if (mainTray) return mainTray;
  mainTray = new Tray(cached(APP_ICON));
  mainTray.on('click', () => handlers.open());
  mainTray.on('right-click', () => popMenu(mainTray));
  renderMain();
  return mainTray;
}

let menuOpening = false;
async function popMenu(tray) {
  if (menuOpening || !handlers.menu) return;
  menuOpening = true;
  try {
    const template = await handlers.menu({ devices: list(), quit: handlers.quit });
    if (!tray.isDestroyed()) tray.popUpContextMenu(Menu.buildFromTemplate(template));
  } catch (_) {
    if (!tray.isDestroyed()) {
      tray.popUpContextMenu(Menu.buildFromTemplate([
        { label: 'Abrir CYL Audio Hub', click: () => handlers.open() },
        { label: 'Sair do CYL Audio Hub', click: () => handlers.quit() },
      ]));
    }
  } finally {
    menuOpening = false;
  }
}

// Picture and tooltip of the main icon. In the single-icon layout its face follows the battery
// that most needs attention; with no battery devices it is the app icon.
function renderMain() {
  if (!mainTray) return;
  const all = list();
  const useMood = mode === 'list' && all.length > 0;
  const file = useMood ? path.join(TRAY_DIR, `mood-${moodFor(all)}.png`) : APP_ICON;
  const head = handlers.tooltip ? handlers.tooltip() : 'CYL Audio Hub';
  const tip = [head, ...(mode === 'list' ? all.map((d) => `${d.name}: ${statusText(d)}`) : [])].join('\n').slice(0, 127);
  const key = `${file}|${tip}`;
  if (key === mainKey) return;
  if (!mainKey.startsWith(`${file}|`)) mainTray.setImage(cached(file));
  mainTray.setToolTip(tip);
  mainKey = key;
}

// info: { name, capacity, charging, offline }
function updateDevice(id, info) {
  devices.set(id, { ...info });
  renderMain();
  if (mode === 'perDevice' && perDeviceIcons) renderPerDeviceOne(id);
}

function removeDevice(id) {
  devices.delete(id);
  const entry = perTrays.get(id);
  if (entry) { try { entry.tray.destroy(); } catch (_) {} perTrays.delete(id); }
  renderMain();
}

// ---- per-device icons (optional) ----

function renderPerDeviceOne(id) {
  const info = devices.get(id);
  if (!info) return;
  const offline = info.offline || info.capacity == null;
  const file = imageFile(info.capacity, info.charging, offline);
  const status = statusText(info);
  const key = `${file}|${info.name}|${status}`;

  let entry = perTrays.get(id);
  if (entry && entry.lastKey === key) return; // nothing changed; skip

  if (!entry) {
    const tray = new Tray(cached(path.join(TRAY_DIR, file)));
    tray.on('click', () => handlers.flyout(tray.getBounds()));
    tray.on('right-click', () => popMenu(tray));
    entry = { tray, lastKey: key };
    perTrays.set(id, entry);
  } else {
    if (!entry.lastKey.startsWith(`${file}|`)) entry.tray.setImage(cached(path.join(TRAY_DIR, file))); // keep shell icon calls rare
    entry.lastKey = key;
  }
  entry.tray.setToolTip(`${info.name}: ${status}`);
}

// ---- mode / lifecycle ----

function destroyPerDevice() {
  for (const [, e] of perTrays) { try { e.tray.destroy(); } catch (_) {} }
  perTrays.clear();
}

function rebuild() {
  destroyPerDevice();
  mainKey = '';
  renderMain();
  if (mode === 'perDevice' && perDeviceIcons) for (const id of devices.keys()) renderPerDeviceOne(id);
}

function setMode(newMode) {
  const m = newMode === 'perDevice' ? 'perDevice' : 'list';
  if (m === mode && mainTray) return;
  mode = m;
  ensureMain();
  rebuild();
}

function setPerDeviceIcons(on) {
  perDeviceIcons = !!on;
  rebuild();
}

// Drop trays for devices that are no longer saved.
function sync(savedIds) {
  for (const id of Array.from(devices.keys())) {
    if (!savedIds.includes(id)) removeDevice(id);
  }
}

// Battery icons go; the main icon stays (it is the way back to the app).
function destroyAll() {
  destroyPerDevice();
}

function destroyEverything() {
  destroyPerDevice();
  if (mainTray) { try { mainTray.destroy(); } catch (_) {} mainTray = null; mainKey = ''; }
}

const list = () => Array.from(devices.values());

module.exports = { setHandlers, setMode, setPerDeviceIcons, updateDevice, removeDevice, sync, destroyAll, destroyEverything, list, ensureMain, refreshMain: renderMain, mainBounds: () => (mainTray ? mainTray.getBounds() : null) };
