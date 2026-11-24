const test = require('node:test');
const assert = require('node:assert/strict');
const kb = require('../src/main/keybinds/model');
const { createKeybinds } = require('../src/main/keybinds/manager');
const { normalizeAudio, DEFAULT_AUDIO } = require('../src/main/audio/model');

const profiles = normalizeAudio(DEFAULT_AUDIO()).profiles;

test('normalize writes one canonical form', () => {
  assert.equal(kb.normalize('ctrl + alt + 1'), 'Control+Alt+1');
  assert.equal(kb.normalize('Alt+Ctrl+e'), 'Control+Alt+E');
  assert.equal(kb.normalize('CommandOrControl+Shift+F5'), 'Control+Shift+F5');
  assert.equal(kb.normalize('Ctrl+Alt+num1'), 'Control+Alt+num1');
  assert.equal(kb.normalize('Ctrl+Alt+Enter'), 'Control+Alt+Return');
  assert.equal(kb.normalize('Ctrl++'), 'Control+Plus');
  assert.equal(kb.normalize('Ctrl+A+B'), null);
  assert.equal(kb.normalize('Ctrl+Alt'), null);
  assert.equal(kb.normalize('Ctrl+Banana'), null);
  assert.equal(kb.normalize(''), null);
});

test('check blocks reserved, Windows-key and modifier-less combinations', () => {
  assert.match(kb.check(kb.normalize('Alt+Tab')).error, /reservada/);
  assert.match(kb.check(kb.normalize('Ctrl+Alt+Delete')).error, /reservada/);
  assert.match(kb.check(kb.normalize('Win+E')).error, /Windows/);
  assert.match(kb.check(kb.normalize('M')).error, /modificador/);
  assert.match(kb.check(null).error, /inválida/);
  assert.deepEqual(kb.check(kb.normalize('Ctrl+Alt+M')), {});
  assert.match(kb.check(kb.normalize('Ctrl+Alt+Q')).warning, /ABNT2/);
});

test('check warns about combinations games use', () => {
  assert.match(kb.check(kb.normalize('Ctrl+W')).warning, /Valorant/);
  assert.match(kb.check(kb.normalize('Shift+1')).warning, /jogos/);
  assert.match(kb.check('VolumeMute').warning, /mídia/);
  assert.equal(kb.check(kb.normalize('Ctrl+Shift+F9')).warning, undefined);
});

test('default binds are the spec examples, all off', () => {
  const list = kb.normalizeBinds(kb.DEFAULT_BINDS(), profiles);
  assert.equal(list.length, 7);
  assert.ok(list.every((b) => !b.enabled));
  assert.deepEqual(list.map((b) => b.accelerator), ['Control+Alt+1', 'Control+Alt+2', 'Control+Alt+3', 'Control+Alt+E', 'Control+Alt+M', 'Control+Alt+B', 'Control+Alt+H']);
});

test('normalizeBinds drops binds to unknown actions or deleted profiles', () => {
  const list = kb.normalizeBinds([
    { id: 'a', action: 'profile:valorant', accelerator: 'Ctrl+Alt+1', enabled: true },
    { id: 'b', action: 'profile:gone', accelerator: 'Ctrl+Alt+2', enabled: true },
    { id: 'c', action: 'shell:exec', accelerator: 'Ctrl+Alt+3', enabled: true },
    { id: 'a', action: 'eq:toggle', accelerator: 'Ctrl+Alt+4', enabled: true },
  ], profiles);
  assert.deepEqual(list.map((b) => b.id), ['a']);
});

function fakeShortcut({ taken = [] } = {}) {
  const reg = new Map();
  return {
    reg,
    register: (acc, fn) => { if (taken.includes(acc) || reg.has(acc)) return false; reg.set(acc, fn); return true; },
    unregister: (acc) => reg.delete(acc),
  };
}

test('manager registers enabled binds, reports the ones Windows refuses, and keeps the rest', async () => {
  const gs = fakeShortcut({ taken: ['Control+Alt+E'] });
  const ran = [];
  const m = createKeybinds({ globalShortcut: gs, run: (a) => ran.push(a) });
  const st = m.apply([
    { id: 'a', action: 'mic:toggle', accelerator: 'Control+Alt+M', enabled: true },
    { id: 'b', action: 'eq:toggle', accelerator: 'Control+Alt+E', enabled: true },
    { id: 'c', action: 'profile:next', accelerator: 'Control+Alt+N', enabled: false },
    { id: 'd', action: 'window:toggle', accelerator: 'Alt+Tab', enabled: true },
  ]);
  assert.equal(st.a.registered, true);
  assert.match(st.b.error, /em uso por outro programa/);
  assert.equal(st.c.registered, false);
  assert.equal(st.c.error, null);
  assert.match(st.d.error, /reservada/);
  assert.deepEqual([...gs.reg.keys()], ['Control+Alt+M']);
  gs.reg.get('Control+Alt+M')();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(ran, ['mic:toggle']);
});

test('a duplicated combination: the first bind keeps it, the second shows the conflict', () => {
  const gs = fakeShortcut();
  const m = createKeybinds({ globalShortcut: gs, run: () => {} });
  const st = m.apply([
    { id: 'a', action: 'mic:toggle', accelerator: 'Control+Alt+M', enabled: true },
    { id: 'b', action: 'eq:toggle', accelerator: 'Control+Alt+M', enabled: true },
  ]);
  assert.equal(st.a.registered, true);
  assert.match(st.a.warning, /Mesma combinação/);
  assert.equal(st.b.registered, false);
  assert.match(st.b.error, /Mesma combinação/);
});

test('reapply after sleep frees and registers again; unregisterAll leaves nothing behind', () => {
  const gs = fakeShortcut();
  const m = createKeybinds({ globalShortcut: gs, run: () => {} });
  m.apply([{ id: 'a', action: 'mic:toggle', accelerator: 'Control+Alt+M', enabled: true }]);
  m.reapply();
  assert.equal(gs.reg.size, 1);
  m.unregisterAll();
  assert.equal(gs.reg.size, 0);
});

test('an action that throws is logged, not crashing the shortcut callback', async () => {
  const gs = fakeShortcut();
  const logs = [];
  const m = createKeybinds({ globalShortcut: gs, run: () => { throw new Error('boom'); }, log: (t, msg) => logs.push(msg) });
  m.apply([{ id: 'a', action: 'mic:toggle', accelerator: 'Control+Alt+M', enabled: true }]);
  gs.reg.get('Control+Alt+M')();
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(logs.some((l) => /boom/.test(l)));
});
