const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const devdiag = require('../src/main/devdiag');
const brand = require('../scripts/build-brand');

const NOW = 1_800_000_000_000;
const mouseLive = {
  id: '7511:64096:LXD-001', vendorId: 0x1d57, productId: 0xfa60, product: '2.4G Wireless Device', manufacturer: 'LXDDZ', serialNumber: 'LXD-001',
  channels: [{ usagePage: 1, usage: 2, interface: 1, path: '\\\\?\\hid#vid_1d57&pid_fa60&mi_01#x' }, { usagePage: 0x0a, usage: null, interface: 2, path: '\\\\?\\hid#vid_1d57&pid_fa60&mi_02&col03#y' }],
};
const h510Live = {
  id: '1035:2199:', vendorId: 0x040b, productId: 0x0897, product: 'H510-PRO Wireless headset', manufacturer: 'XiiSound Technology Corporation', serialNumber: '',
  channels: [{ usagePage: 0xf100, usage: null, interface: 3 }, { usagePage: 0x0c, usage: 1, interface: 3 }],
};
const keyboard = { id: '6700:17898:', vendorId: 0x1a2c, productId: 0x45ea, product: 'USB Keyboard', channels: [{ usagePage: 1, usage: 6 }] };
const headset = { connected: true, dongle: true, battery: { kind: 'unavailable', label: 'Indisponível' } };
const mouseSaved = (over = {}) => ({
  id: mouseLive.id, driverId: 'beken', product: '2.4G Wireless Device', manufacturer: 'LXDDZ',
  lastReading: { capacity: 95, charging: false }, lastReadingAt: NOW - 60_000, online: true, history: [1, 2, 3], ...over,
});

test('diagnostics: the mouse reading is real only while it is fresh and the mouse answers', () => {
  let [, m] = devdiag.collect({ hidList: [h510Live, mouseLive], saved: { a: mouseSaved() }, headset, now: NOW });
  assert.equal(m.battery.kind, 'real');
  assert.equal(m.battery.label, '95%');
  assert.equal(m.connection, 'Receptor USB 2.4 GHz');
  assert.equal(m.kind, 'Mouse sem fio');
  assert.equal(m.ids, 'VID 1D57 · PID FA60');
  assert.match(m.source, /Nada é enviado ao mouse/);

  [, m] = devdiag.collect({ hidList: [mouseLive], saved: { a: mouseSaved({ online: false }) }, headset, now: NOW });
  assert.equal(m.battery.kind, 'unavailable');
  assert.equal(m.battery.last, '95%', 'last known value kept as history, not as a reading');
  assert.match(m.reason, /desligado/);

  [, m] = devdiag.collect({ hidList: [mouseLive], saved: { a: mouseSaved({ lastReadingAt: NOW - 3 * 3600_000 }) }, headset, now: NOW });
  assert.equal(m.battery.kind, 'unavailable', 'a 3 h old reading is not shown as current');
  assert.match(m.reason, /antiga/);

  [, m] = devdiag.collect({ hidList: [], saved: { a: mouseSaved() }, headset, now: NOW });
  assert.match(m.state, /Receptor não encontrado/);
});

test('diagnostics: the H510-PRO battery stays unavailable, with the reason', () => {
  const [h] = devdiag.collect({ hidList: [h510Live], saved: {}, headset, now: NOW });
  assert.equal(h.battery.kind, 'unavailable');
  assert.match(h.reason, /0xF100/);
  assert.match(h.reason, /não envia comandos/);
  assert.ok(h.interfaces.some((i) => /Fabricante/.test(i)));
  assert.equal(h.canListen, true);
});

test('diagnostics: unmonitored devices are listed, plain keyboards and wired devices are not', () => {
  const list = devdiag.collect({ hidList: [mouseLive, keyboard], saved: {}, headset: null, now: NOW, detectDriver: (d) => (d.vendorId === 0x1d57 ? { id: 'beken' } : null) });
  assert.equal(list.length, 1);
  assert.equal(list[0].monitored, false);
  assert.match(list[0].source, /beken/);
  const wired = { id: 'w', vendorId: 0x1a2c, productId: 0x45ea, product: 'USB Keyboard', channels: [{ usagePage: 1, usage: 6 }, { usagePage: 0x0c, usage: 1 }] };
  assert.equal(devdiag.collect({ hidList: [wired], saved: {}, headset: null, now: NOW }).length, 0);
});

test('diagnostics: the report leaves out serials, device paths, addresses and the user folder', () => {
  const entries = devdiag.collect({ hidList: [h510Live, mouseLive], saved: { a: mouseSaved() }, headset, now: NOW });
  const listen = { name: 'H510', ms: 8000, channels: [{ page: 0xf100, usage: null }], frames: [], errors: ['C:\\Users\\marce\\x failed at \\\\?\\hid#vid_040b'] };
  const text = devdiag.report({ entries, version: '3.1.0', windows: '10.0.19045', apo: 'não instalado', listen, now: NOW });
  assert.doesNotMatch(text, /LXD-001/);
  assert.doesNotMatch(text, /marce/);
  assert.doesNotMatch(text, /\\\\\?\\/);
  assert.match(text, /Nenhum relatório recebido/);
  assert.match(text, /Bateria: 95% \[Leitura real\]/);
  assert.equal(devdiag.sanitize('46:27:6F:7F:87:E3 and 46276F7F87E3'), '<endereço> and <endereço>');
});

test('freshness: older than three polls (at least 10 min) is stale', () => {
  assert.equal(devdiag.freshness(null, NOW, 60), 'none');
  assert.equal(devdiag.freshness(NOW - 9 * 60_000, NOW, 60), 'fresh');
  assert.equal(devdiag.freshness(NOW - 11 * 60_000, NOW, 60), 'stale');
  assert.equal(devdiag.freshness(NOW - 20 * 60_000, NOW, 600), 'fresh');
});

test('passive listening never writes: the module has no write or feature-report call', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'hid', 'passive.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(src, /\.write\(|sendFeatureReport|getFeatureReport/);
  const worker = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'hid', 'hid-worker.js'), 'utf8');
  assert.match(worker, /NO_WRITES = new Set\(\['1035:2199'\]\)/, 'the H510-PRO never gets the scan pings');
});

test('brand: background removal makes the white corners transparent and keeps the tile', () => {
  const w = 40; const h = 40; const px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4; const inside = x >= 6 && x < 34 && y >= 6 && y < 34;
    px[o] = inside ? 0xaf : 255; px[o + 1] = inside ? 0x38 : 255; px[o + 2] = inside ? 0xef : 255; px[o + 3] = 255;
  }
  const img = { w, h, px };
  brand.cutBackground(img);
  assert.equal(px[3], 0, 'corner cleared');
  assert.equal(px[(20 * w + 20) * 4 + 3], 255, 'tile kept');
  const t = brand.trim(img);
  assert.equal(t.w, 28);
  const small = brand.resize(t, 7);
  assert.equal(small.px[(3 * 7 + 3) * 4], 0xaf);
  const round = brand.decodePng(brand.encodePng(small));
  assert.deepEqual(round.px, small.px);
  const icon = brand.ico([{ size: 16, png: brand.encodePng(brand.resize(t, 16)) }, { size: 256, png: brand.encodePng(brand.resize(t, 256)) }]);
  assert.equal(icon.readUInt16LE(2), 1);
  assert.equal(icon.readUInt16LE(4), 2);
  assert.equal(icon[6 + 16], 0, '256 px is stored as 0 in the directory');
});

test('brand: generated assets exist and are small', () => {
  const root = path.join(__dirname, '..');
  for (const [f, max] of [['assets/icon.ico', 400_000], ['assets/tray/cyl.png', 8_000], ['assets/tray/cyl@2x.png', 16_000], ['src/renderer/brand/cyl-logo.png', 200_000], ['src/renderer/brand/cyl-mark.png', 40_000]]) {
    const size = fs.statSync(path.join(root, f)).size;
    assert.ok(size > 0 && size < max, `${f}: ${size} bytes`);
  }
  const tray = brand.decodePng(fs.readFileSync(path.join(root, 'assets/tray/cyl.png')));
  assert.equal(tray.w, 16);
  assert.equal(tray.px[3], 0, 'tray icon corner is transparent');
});
