const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const model = require('../src/main/audio/model');
const apoMod = require('../src/main/audio/apo');
const { createAudioManager } = require('../src/main/audio/manager');
const { decide, createAutoSwitch } = require('../src/main/audio/autoswitch');
const { createEngine, enginePath } = require('../src/main/audio/engine');

const R = '{0.0.0.00000000}.{11111111-2222-3333-4444-555555555555}';
const C = '{0.0.1.00000000}.{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}';

// ---------- model ----------

test('starting profiles never clip: preamp covers the loudest band', () => {
  for (const p of model.DEFAULT_PROFILES) {
    assert.equal(p.bands.length, 10, p.id);
    assert.equal(model.clipRisk(p), false, p.id);
  }
  assert.equal(model.safePreamp([0, 0, 5, 0, 0, 0, 0, 0, 0, 0]), -5);
  assert.equal(model.safePreamp([0, 0, 3.2, 0, 0, 0, 0, 0, 0, 0]), -3.5);
  assert.equal(model.safePreamp([-3, -2, 0, 0, 0, 0, 0, 0, 0, 0]), 0);
});

test('the Padrão profile is flat and always exists', () => {
  const a = model.normalizeAudio({ profiles: { valorant: { name: 'x', bands: [1] } } });
  assert.ok(a.profiles.padrao);
  assert.deepEqual(a.profiles.padrao.bands, Array(10).fill(0));
  assert.equal(a.profiles.padrao.preamp, 0);
});

test('normalizeAudio clamps gains, drops bad ids, rules and endpoints', () => {
  const a = model.normalizeAudio({
    activeProfile: 'nope',
    profiles: { ok: { name: '  Meu\u0007 perfil ', bands: [99, -99, 'x', 1.234], preamp: -100 }, 'BAD ID': { name: 'x' } },
    targetRender: 'C:\\Windows\\evil', targetCapture: C,
    autoSwitch: { enabled: true, intervalSec: 1, rules: [{ exe: 'VALORANT-Win64-Shipping.exe', profile: 'ok' }, { exe: 'a;rm -rf', profile: 'ok' }, { exe: 'x', profile: 'missing' }] },
  });
  assert.equal(a.activeProfile, 'padrao');
  assert.equal(a.profiles.ok.name, 'Meu perfil');
  assert.deepEqual(a.profiles.ok.bands.slice(0, 4), [12, -12, 0, 1.2]);
  assert.equal(a.profiles.ok.preamp, model.PREAMP_MIN);
  assert.equal(a.profiles['BAD ID'], undefined);
  assert.equal(a.targetRender, null);
  assert.equal(a.targetCapture, C);
  assert.equal(a.autoSwitch.intervalSec, 5);
  assert.deepEqual(a.autoSwitch.rules, [{ exe: 'valorant-win64-shipping', profile: 'ok' }]);
});

test('export then import round-trips and never overwrites an existing profile', () => {
  const a = model.normalizeAudio(model.DEFAULT_AUDIO());
  const data = JSON.parse(JSON.stringify(model.exportProfiles(a, ['valorant'])));
  assert.equal(data.format, 'cyl-audio-hub.profiles');
  const { audio: b, added } = model.importProfiles(a, data);
  assert.deepEqual(added, ['Valorant — Competitivo']);
  assert.ok(b.profiles['valorant-2']);
  assert.deepEqual(b.profiles['valorant-2'].bands, a.profiles.valorant.bands);
  assert.equal(b.profiles['valorant-2'].builtin, false);
  assert.deepEqual(b.profiles.valorant, a.profiles.valorant);
});

test('import rejects foreign files with a readable message', () => {
  const a = model.normalizeAudio(model.DEFAULT_AUDIO());
  assert.throws(() => model.importProfiles(a, { hello: 1 }), /não é uma exportação/);
  assert.throws(() => model.importProfiles(a, { format: 'cyl-audio-hub.profiles', profiles: [] }), /não contém/);
  assert.throws(() => model.importProfiles(a, { format: 'cyl-audio-hub.profiles', bands: [1, 2], profiles: [{}] }), /bandas/);
});

// ---------- Equalizer APO ----------

const flat = { name: 'Padrão', preamp: 0, bands: Array(10).fill(0), mic: null };
const valorant = { name: 'Valorant', preamp: -3.5, bands: [-4, -3, -1.5, -0.5, 0, 0.5, 2.5, 3.5, 2, 0], mic: null };

test('render: EQ scoped to the chosen output by endpoint GUID, scope reset at the end', () => {
  const txt = apoMod.render({ enabled: true, profile: valorant, renderId: R, captureId: C });
  assert.match(txt, /^Device: \{11111111-2222-3333-4444-555555555555\}\r$/m);
  assert.match(txt, /^Preamp: -3\.5 dB\r$/m);
  assert.match(txt, /^GraphicEQ: 31 -4; 62 -3; 125 -1\.5; 250 -0\.5; 500 0; 1000 0\.5; 2000 2\.5; 4000 3\.5; 8000 2; 16000 0\r$/m);
  assert.match(txt.trimEnd(), /Device: all$/);
  assert.doesNotMatch(txt, /Copy:|Delay:|Channel:/); // no surround / crossfeed processing
});

test('render: disabled or flat writes no filters at all', () => {
  assert.doesNotMatch(apoMod.render({ enabled: false, profile: valorant, renderId: R }), /GraphicEQ|Preamp|Filter/);
  assert.doesNotMatch(apoMod.render({ enabled: true, profile: flat, renderId: R }), /GraphicEQ|Preamp|Filter/);
});

test('render: microphone chain goes to the capture endpoint only when its filters are on', () => {
  const p = { ...flat, mic: { filters: true, highpassHz: 100, presenceDb: 2, gainDb: 3 } };
  const txt = apoMod.render({ enabled: true, profile: p, renderId: R, captureId: C });
  assert.match(txt, /Device: \{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\}\r\nPreamp: 3 dB\r\nFilter: ON HP Fc 100 Hz\r\nFilter: ON PK Fc 3500 Hz Gain 2 dB Q 1\.0/);
  const off = apoMod.render({ enabled: true, profile: { ...p, mic: { ...p.mic, filters: false } }, renderId: R, captureId: C });
  assert.doesNotMatch(off, /HP Fc/);
});

function fakeApoDir(configText) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cyl-apo-'));
  const configDir = path.join(root, 'config');
  fs.mkdirSync(configDir);
  fs.writeFileSync(path.join(configDir, 'config.txt'), configText);
  const backupDir = path.join(root, 'backups');
  const apo = apoMod.createApo({ backupDir, locateFn: () => ({ configDir, installDir: root, configurator: path.join(root, 'Configurator.exe') }) });
  return { root, configDir, backupDir, apo, read: () => fs.readFileSync(path.join(configDir, 'config.txt'), 'utf8') };
}

test('apply appends one Include after a backup, keeps the user config, and is idempotent', () => {
  const original = 'Preamp: -6 dB\r\nInclude: example.txt\r\n# comment\r\n';
  const t = fakeApoDir(original);
  const r1 = t.apo.apply({ enabled: true, profile: valorant, renderId: R, captureId: C });
  assert.equal(r1.ok, true);
  assert.ok(r1.backupFile && fs.readFileSync(r1.backupFile, 'utf8') === original);
  assert.equal(t.read(), `${original}Include: cyl-audio-hub.txt\r\n`);
  assert.match(fs.readFileSync(path.join(t.configDir, 'cyl-audio-hub.txt'), 'utf8'), /GraphicEQ/);
  const r2 = t.apo.apply({ enabled: false, profile: valorant, renderId: R });
  assert.equal(r2.backupFile, null);
  assert.equal(t.read().match(/cyl-audio-hub/g).length, 1);
  assert.doesNotMatch(fs.readFileSync(path.join(t.configDir, 'cyl-audio-hub.txt'), 'utf8'), /GraphicEQ/);
  assert.deepEqual(fs.readdirSync(t.configDir).filter((f) => f.includes('tmp')), []); // no temp file left
});

test('status reports the other active lines that would stack with our chain', () => {
  const t = fakeApoDir('Preamp: -6 dB\nInclude: example.txt\n');
  t.apo.apply({ enabled: true, profile: valorant, renderId: R });
  const st = t.apo.status({});
  assert.equal(st.installed, true);
  assert.equal(st.included, true);
  assert.deepEqual(st.otherLines, ['Preamp: -6 dB', 'Include: example.txt']);
});

test('exclusive comments the other lines with a marker; remove restores exactly the original', () => {
  const original = 'Preamp: -6 dB\nInclude: example.txt\n# keep\n';
  const t = fakeApoDir(original);
  t.apo.apply({ enabled: true, profile: valorant, renderId: R });
  t.apo.exclusive();
  assert.match(t.read(), /^# \[CYL desativado\] Preamp: -6 dB$/m);
  assert.match(t.read(), /^Include: cyl-audio-hub\.txt/m);
  assert.deepEqual(t.apo.status({}).otherLines, []);
  t.apo.remove();
  assert.equal(t.read(), original);
  assert.equal(fs.existsSync(path.join(t.configDir, 'cyl-audio-hub.txt')), false);
  assert.ok(fs.readdirSync(t.backupDir).length >= 3);
});

test('APO missing: apply reports not installed and touches nothing', () => {
  const apo = apoMod.createApo({ backupDir: path.join(os.tmpdir(), 'cyl-none'), locateFn: () => null });
  assert.deepEqual(apo.apply({ enabled: true, profile: valorant, renderId: R }), { ok: false, installed: false });
  assert.deepEqual(apo.status(), { installed: false });
});

test('locate finds APO from the registry path, then Program Files, else null', () => {
  const exists = (p) => p === path.join('X:\\APO\\config', 'config.txt');
  assert.equal(apoMod.locate({ env: {}, exists, reg: () => 'X:\\APO\\config' }).configDir, 'X:\\APO\\config');
  assert.equal(apoMod.locate({ env: {}, exists: () => false, reg: () => null }), null);
  const pf = apoMod.locate({ env: { ProgramFiles: 'P:\\PF' }, exists: (p) => p === path.join('P:\\PF', 'EqualizerAPO', 'config', 'config.txt'), reg: () => null });
  assert.equal(pf.configDir, path.join('P:\\PF', 'EqualizerAPO', 'config'));
});

test('installedOnEndpoint reads the endpoint FxProperties and looks for the APO CLSID', () => {
  const seen = [];
  const reg = (exe, args) => { seen.push(args[1]); return `x ${apoMod.APO_CLSID} y`; };
  assert.equal(apoMod.installedOnEndpoint(R, { reg }), true);
  assert.match(seen[0], /MMDevices\\Audio\\Render\\\{11111111-2222-3333-4444-555555555555\}\\FxProperties$/);
  assert.equal(apoMod.installedOnEndpoint(C, { reg: () => 'nothing' }), false);
  assert.equal(apoMod.installedOnEndpoint('bad', { reg }), null);
});

// ---------- audio manager (fake engine, temp APO) ----------

function fakeEngine(devices) {
  const calls = [];
  const st = () => ({
    devices,
    defaultRender: devices.find((d) => d.flow === 'render') || null,
    defaultCapture: devices.find((d) => d.flow === 'capture') || null,
    zeus: { connected: devices.some((d) => d.zeus), render: devices.find((d) => d.zeus && d.flow === 'render') || null, capture: devices.find((d) => d.zeus && d.flow === 'capture') || null },
  });
  return {
    calls,
    available: () => true,
    running: () => true,
    keepAlive: () => {},
    status: async () => { calls.push(['status']); return JSON.parse(JSON.stringify(st())); },
    procs: async () => [],
    setMute: async (id, on) => { calls.push(['mute', id, on]); devices.find((d) => d.id === id).mute = on; },
    setVolume: async (id, v) => { calls.push(['volume', id, v]); devices.find((d) => d.id === id).volume = v; },
    setDefault: async (id, roles) => { calls.push(['default', id, roles]); },
  };
}

const devs = () => [
  { id: '{0.0.0.00000000}.{99999999-2222-3333-4444-555555555555}', flow: 'render', name: 'Monitor', zeus: false, volume: 50, mute: false },
  { id: R, flow: 'render', name: 'Fones de ouvido (H510-PRO Wireless headset)', zeus: true, volume: 40, mute: false },
  { id: C, flow: 'capture', name: 'Microfone (H510-PRO Wireless headset)', zeus: true, volume: 100, mute: false },
];

function manager(extra = {}) {
  const t = fakeApoDir('');
  let saved = extra.saved || null;
  const notes = [];
  const engine = fakeEngine(devs());
  const m = createAudioManager({ engine, apo: t.apo, load: () => saved, save: (v) => { saved = v; }, notify: (a, b) => notes.push(`${a}: ${b}`) });
  return { m, t, engine, notes, saved: () => saved };
}

test('manager targets the H510-PRO by default and switching a profile rewrites the APO chain', async () => {
  const { m, t, notes, saved } = manager();
  await m.refresh();
  assert.equal(m.targets().render.id, R);
  assert.equal(m.targets().capture.id, C);
  await m.activateProfile('valorant');
  assert.equal(saved().activeProfile, 'valorant');
  assert.equal(saved().manualProfile, 'valorant');
  assert.match(fs.readFileSync(path.join(t.configDir, 'cyl-audio-hub.txt'), 'utf8'), /Device: \{11111111/);
  assert.match(notes[0], /Valorant/);
  await m.setEqEnabled(false);
  assert.doesNotMatch(fs.readFileSync(path.join(t.configDir, 'cyl-audio-hub.txt'), 'utf8'), /GraphicEQ/);
});

test('an automatic switch does not change the manual profile', async () => {
  const { m, saved } = manager();
  await m.activateProfile('musica');
  await m.activateProfile('valorant', { auto: true, reason: 'valorant-win64-shipping' });
  assert.equal(saved().activeProfile, 'valorant');
  assert.equal(saved().manualProfile, 'musica');
});

test('toggleMic flips the mute of the H510-PRO microphone', async () => {
  const { m, engine } = manager();
  assert.equal(await m.toggleMic(), true);
  assert.deepEqual(engine.calls.find((c) => c[0] === 'mute'), ['mute', C, true]);
  assert.equal(await m.toggleMic(), false);
});

test('profiles: duplicate, rename, reset and delete (the active one falls back to Padrão)', async () => {
  const { m } = manager();
  const copy = m.createProfile('valorant', 'Valorant Noite');
  assert.equal(copy.id, 'valorant-noite');
  assert.deepEqual(copy.bands, m.get().profiles.valorant.bands);
  await m.saveProfile(copy.id, { name: 'Noite', bands: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1] });
  assert.equal(m.get().profiles[copy.id].name, 'Noite');
  await m.saveProfile('valorant', { bands: Array(10).fill(3) });
  await m.resetProfile('valorant');
  assert.deepEqual(m.get().profiles.valorant.bands, model.defaultProfile('valorant').bands);
  await m.activateProfile(copy.id);
  await m.deleteProfile(copy.id);
  assert.equal(m.get().activeProfile, 'padrao');
  await assert.rejects(() => m.deleteProfile('padrao'), /não pode ser excluído/);
});

test('headset battery is "Indisponível" unless a battery card for the receiver has a reading', () => {
  const { m } = manager();
  assert.equal(m.headset().battery.kind, 'unavailable');
  const card = { id: '1035:2199:x', product: 'H510-PRO Wireless headset', lastReading: { capacity: 70 }, lastReadingAt: 1 };
  const withCard = m.headset({ savedDevices: { a: { ...card, id: '040b:0897' } } });
  assert.equal(withCard.battery.kind, 'real');
  assert.equal(withCard.battery.label, '70%');
  assert.equal(m.headset({ hidList: [{ vendorId: 0x040b, productId: 0x0897 }] }).dongle, true);
  assert.equal(m.headset({ hidList: [] }).dongle, false);
});

// ---------- automatic switch ----------

test('decide: first rule in priority order wins, else the manual profile', () => {
  const rules = [{ exe: 'valorant-win64-shipping', profile: 'valorant' }, { exe: 'discord', profile: 'discord' }];
  assert.equal(decide(rules, ['discord', 'valorant-win64-shipping'], 'musica').profile, 'valorant');
  assert.equal(decide(rules, ['discord'], 'musica').profile, 'discord');
  assert.equal(decide(rules, ['explorer'], 'musica').profile, 'musica');
});

test('autoswitch acts on rule changes only, so a manual pick during a game stays', async () => {
  let procs = ['explorer'];
  let a = model.normalizeAudio({ ...model.DEFAULT_AUDIO(), activeProfile: 'musica', manualProfile: 'musica', autoSwitch: { enabled: true, intervalSec: 60, rules: [{ exe: 'valorant-win64-shipping', profile: 'valorant' }] } });
  const switched = [];
  const engine = { procs: async () => procs, keepAlive: () => {} };
  const s = createAutoSwitch({ engine, getAudio: () => a, activate: async (id) => { switched.push(id); a = { ...a, activeProfile: id }; } });
  await s.tick();
  assert.deepEqual(switched, []);
  procs = ['explorer', 'valorant-win64-shipping'];
  await s.tick();
  assert.deepEqual(switched, ['valorant']);
  a = { ...a, activeProfile: 'discord' }; // user picks by hand while the game runs
  await s.tick();
  assert.deepEqual(switched, ['valorant']);
  procs = ['explorer'];
  await s.tick();
  assert.deepEqual(switched, ['valorant', 'musica']);
  s.stop();
});

// ---------- engine client ----------

test('engine client refuses arguments that could break the line protocol', async () => {
  const e = createEngine({ exe: 'nope.exe', spawnFn: () => { throw new Error('should not spawn'); } });
  await assert.rejects(() => e.setMute('id\twith tab', true), /inválido/);
  await assert.rejects(() => e.setDefault('x', 'everything'), /inválido/);
  await assert.rejects(() => e.setVolume('x', 'abc'), /inválido/);
});

test('engine client sends a valid volume as a clamped number on one protocol line', async () => {
  const { PassThrough } = require('stream');
  const { EventEmitter } = require('events');
  const lines = [];
  const spawnFn = () => {
    const c = new EventEmitter();
    c.stdout = new PassThrough();
    c.stdin = new PassThrough();
    c.stdin.on('data', (d) => {
      for (const l of String(d).split('\n').filter(Boolean)) {
        lines.push(l);
        c.stdout.write(`{"id":"${l.split('\t')[0]}","ok":true}\n`);
      }
    });
    c.kill = () => {};
    return c;
  };
  const e = createEngine({ exe: 'fake.exe', spawnFn });
  await e.setVolume('dev', 55.55);
  await e.setVolume('dev', 140);
  await e.setVolume('dev', 0);
  assert.deepEqual(lines.map((l) => l.split('\t').slice(1)), [['volume', 'dev', '55.6'], ['volume', 'dev', '100'], ['volume', 'dev', '0']]);
  e.stop();
});

test('engine client reports a missing AudioEngine.exe clearly', async () => {
  const e = createEngine({ exe: null });
  assert.equal(e.available(), false);
  await assert.rejects(() => e.status(), /AudioEngine\.exe não encontrado/);
});

const realExe = enginePath();
test('real AudioEngine.exe: one process answers several calls, then stops cleanly', { skip: !realExe && 'AudioEngine.exe not built' }, async () => {
  const e = createEngine({ exe: realExe });
  const st = await e.status();
  assert.ok(Array.isArray(st.devices));
  assert.ok('zeus' in st);
  const procs = await e.procs();
  assert.ok(procs.includes('node') || procs.includes('node.exe'));
  assert.equal(e.running(), true);
  await assert.rejects(() => e.setMute('{0.0.0.00000000}.{00000000-0000-0000-0000-000000000000}', true));
  e.stop();
  assert.equal(e.running(), false);
});
