// CYL Audio Hub core: builds the audio, profile and keybind managers on top of Battery Hub's device
// monitoring, owns their IPC, the action registry the binds and tray run, and the power events.
//
// IPC rules: every handler checks its arguments; endpoint ids must be ones the engine reported;
// files are only read or written through dialogs the user answered; nothing from the window is ever
// run as a command.
const { ipcMain, globalShortcut, powerMonitor, dialog, shell, Notification, app } = require('electron');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { createEngine } = require('./audio/engine');
const { createApo } = require('./audio/apo');
const { createAudioManager } = require('./audio/manager');
const { createAutoSwitch } = require('./audio/autoswitch');
const model = require('./audio/model');
const kbModel = require('./keybinds/model');
const { createKeybinds } = require('./keybinds/manager');

const ICON = path.join(__dirname, '..', '..', 'assets', 'icon.png');
const MAX_IMPORT_BYTES = 512 * 1024;

let ctx = null;

function init({ log, getWindow, toggleWindow, showWindow, showSettings, hidClient, trayList }) {
  const notify = (title, body) => {
    try {
      if (Notification.isSupported()) new Notification({ title, body, icon: ICON, silent: true }).show();
    } catch (e) { log('ERROR', `notify: ${e.message}`); }
  };

  const engine = createEngine({ log });
  const apo = createApo({ backupDir: path.join(app.getPath('userData'), 'apo-backups'), log });
  const audio = createAudioManager({ engine, apo, load: store.getAudio, save: store.setAudio, notify, log });
  const autoSwitch = createAutoSwitch({ engine, getAudio: audio.get, activate: (id, opts) => audio.activateProfile(id, opts), log });

  // ---- actions (what a bind or a tray item does) ----
  async function run(action) {
    const a = audio.get();
    if (action === 'eq:toggle') return audio.setEqEnabled(!a.eqEnabled);
    if (action === 'mic:toggle') return audio.toggleMic();
    if (action === 'profile:next') return audio.nextProfile();
    if (action === 'window:toggle') return toggleWindow();
    if (action === 'volume:up') return audio.bumpVolume(5);
    if (action === 'volume:down') return audio.bumpVolume(-5);
    if (action === 'battery:show') {
      const lines = trayList().map((d) => `${d.name}: ${d.offline || d.capacity == null ? 'sem leitura' : `${d.capacity}%${d.charging ? ' (carregando)' : ''}`}`);
      const h = audio.headset({ savedDevices: store.getDevices() });
      lines.unshift(`H510-PRO: ${h.battery.label}`);
      return notify('Bateria dos dispositivos', lines.join('\n'));
    }
    const m = /^profile:([a-z0-9-]+)$/.exec(action);
    if (m) return audio.activateProfile(m[1]);
    throw new Error(`ação desconhecida: ${action}`);
  }

  // ---- binds ----
  const keybinds = createKeybinds({ globalShortcut, run, log });
  const loadBinds = () => kbModel.normalizeBinds(store.getBinds(), audio.get().profiles);
  let binds = loadBinds();
  let bindsSuspended = false;
  const applyBinds = () => (bindsSuspended ? keybinds.status() : keybinds.apply(binds));
  function bindsView() {
    const a = audio.get();
    return {
      binds: binds.map((b) => ({ ...b, display: kbModel.display(b.accelerator) })),
      status: keybinds.status(),
      actions: kbModel.actionList(a.profiles, a.order),
      suspended: bindsSuspended,
    };
  }

  // ---- changes fan out to the window and the tray ----
  let tick = null;
  const changed = () => {
    clearTimeout(tick);
    tick = setTimeout(() => {
      const win = getWindow();
      if (win && !win.isDestroyed()) win.webContents.send('cyl-changed');
    }, 50);
  };
  audio.events.on('changed', changed);
  audio.events.on('status', changed);
  audio.events.on('eq', changed);

  // A profile that was deleted can leave binds pointing at nothing: drop them.
  let autoKey = JSON.stringify(audio.get().autoSwitch);
  audio.events.on('changed', () => {
    const next = kbModel.normalizeBinds(binds, audio.get().profiles);
    if (next.length !== binds.length) { binds = next; store.setBinds(binds); applyBinds(); }
    const key = JSON.stringify(audio.get().autoSwitch);
    if (key !== autoKey) { autoKey = key; autoSwitch.restart(); }
  });

  // ---- IPC ----
  const str = (v, max = 300) => (typeof v === 'string' && v.length <= max ? v : null);
  const knownEndpoint = async (id, flow) => {
    const st = await audio.refresh();
    const d = st && st.devices.find((x) => x.id === id && (!flow || x.flow === flow));
    if (!d) throw new Error('Dispositivo de áudio não encontrado.');
    return d;
  };
  const profileId = (id) => { if (!str(id, 40) || !audio.get().profiles[id]) throw new Error('Perfil inexistente.'); return id; };
  const handle = (ch, fn) => ipcMain.handle(ch, async (evt, ...args) => fn(...args));

  handle('cyl:snapshot', async (opts) => {
    await audio.refresh(!!(opts && opts.force));
    let hidList = null;
    if (opts && opts.hid) hidList = await hidClient.enumerate().catch(() => null);
    return audio.snapshot({ hidList, savedDevices: store.getDevices() });
  });
  handle('cyl:apo-status', async () => {
    const t = audio.targets();
    return apo.status({ renderId: t.render && t.render.id, captureId: t.capture && t.capture.id });
  });
  handle('cyl:apo-apply', () => audio.applyEq());
  handle('cyl:apo-exclusive', async () => { const r = apo.exclusive(); await audio.applyEq(); return r; });
  handle('cyl:apo-remove', () => apo.remove());
  handle('cyl:apo-configurator', async () => {
    const w = apo.info(true);
    if (!w || !fs.existsSync(w.configurator)) throw new Error('Configurator do Equalizer APO não encontrado.');
    const err = await shell.openPath(w.configurator); // fixed path found on disk, never one from the window
    if (err) throw new Error(err);
    return true;
  });
  handle('cyl:eq-enabled', (on) => audio.setEqEnabled(!!on));
  handle('cyl:profile-activate', (id) => audio.activateProfile(profileId(id)));
  handle('cyl:profile-save', (id, patch) => {
    if (!patch || typeof patch !== 'object') throw new Error('Dados inválidos.');
    const { name, bands, preamp, mic, note } = patch;
    const clean = {};
    if (name !== undefined) clean.name = name;
    if (bands !== undefined) clean.bands = bands;
    if (preamp !== undefined) clean.preamp = preamp;
    if (mic !== undefined) clean.mic = mic;
    if (note !== undefined) clean.note = note;
    return audio.saveProfile(profileId(id), clean);
  });
  handle('cyl:profile-create', (fromId, name) => audio.createProfile(profileId(fromId), str(name, 60) || undefined));
  handle('cyl:profile-delete', (id) => audio.deleteProfile(profileId(id)));
  handle('cyl:profile-reset', (id) => audio.resetProfile(profileId(id)));
  handle('cyl:profile-order', (order) => {
    if (!Array.isArray(order)) throw new Error('Ordem inválida.');
    audio.persist({ ...audio.get(), order: order.filter((id) => typeof id === 'string') });
    return audio.get();
  });
  handle('cyl:profile-export', async (ids) => {
    const win = getWindow();
    const res = await dialog.showSaveDialog(win, {
      title: 'Exportar perfis', defaultPath: 'cyl-audio-hub-perfis.json',
      filters: [{ name: 'Perfis do CYL Audio Hub', extensions: ['json'] }],
    });
    if (res.canceled || !res.filePath) return { canceled: true };
    const data = model.exportProfiles(audio.get(), Array.isArray(ids) ? ids : null);
    fs.writeFileSync(res.filePath, JSON.stringify(data, null, 2), 'utf8');
    return { file: res.filePath, count: data.profiles.length };
  });
  handle('cyl:profile-import', async () => {
    const win = getWindow();
    const res = await dialog.showOpenDialog(win, {
      title: 'Importar perfis', properties: ['openFile'],
      filters: [{ name: 'Perfis do CYL Audio Hub', extensions: ['json'] }],
    });
    if (res.canceled || !res.filePaths[0]) return { canceled: true };
    const file = res.filePaths[0];
    if (fs.statSync(file).size > MAX_IMPORT_BYTES) throw new Error('Arquivo grande demais para ser uma exportação de perfis.');
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { throw new Error('O arquivo não é um JSON válido.'); }
    return { added: audio.importData(data) };
  });
  handle('cyl:targets', async (patch) => {
    const p = {};
    if (patch && 'targetRender' in patch) p.targetRender = patch.targetRender ? (await knownEndpoint(patch.targetRender, 'render')).id : null;
    if (patch && 'targetCapture' in patch) p.targetCapture = patch.targetCapture ? (await knownEndpoint(patch.targetCapture, 'capture')).id : null;
    return audio.setTargets(p);
  });
  handle('cyl:volume', async (id, value) => audio.setVolume((await knownEndpoint(id)).id, Number(value)));
  handle('cyl:mute', async (id, on) => audio.setMute((await knownEndpoint(id)).id, !!on));
  handle('cyl:default', async (id, roles) => audio.setDefault((await knownEndpoint(id)).id, ['all', 'media', 'comm'].includes(roles) ? roles : 'all'));
  handle('cyl:mic-toggle', () => audio.toggleMic());
  handle('cyl:audio-settings', (patch) => {
    const a = audio.get();
    const next = { ...a };
    if (patch && 'notifyProfileSwitch' in patch) next.notifyProfileSwitch = !!patch.notifyProfileSwitch;
    if (patch && patch.autoSwitch && typeof patch.autoSwitch === 'object') {
      const as = patch.autoSwitch;
      next.autoSwitch = {
        enabled: 'enabled' in as ? !!as.enabled : a.autoSwitch.enabled,
        intervalSec: 'intervalSec' in as ? as.intervalSec : a.autoSwitch.intervalSec,
        rules: Array.isArray(as.rules) ? as.rules : a.autoSwitch.rules,
      };
    }
    audio.persist(next);
    return audio.get();
  });
  handle('cyl:procs', async () => (await engine.procs()).sort());

  handle('cyl:binds', () => bindsView());
  handle('cyl:binds-set', (list) => {
    if (!Array.isArray(list)) throw new Error('Lista inválida.');
    binds = kbModel.normalizeBinds(list, audio.get().profiles);
    store.setBinds(binds);
    applyBinds();
    return bindsView();
  });
  handle('cyl:binds-reset', () => {
    binds = kbModel.normalizeBinds(kbModel.DEFAULT_BINDS(), audio.get().profiles);
    store.setBinds(binds);
    applyBinds();
    return bindsView();
  });
  handle('cyl:binds-check', (accel) => {
    const canon = kbModel.normalize(str(accel, 64) || '');
    return { canon, display: kbModel.display(canon), ...kbModel.check(canon) };
  });
  // While the window records a new combination the binds step aside, so pressing one that is
  // already bound reaches the window instead of running its action.
  handle('cyl:binds-suspend', (on) => {
    bindsSuspended = !!on;
    if (bindsSuspended) keybinds.unregisterAll();
    else keybinds.apply(binds);
    return bindsView();
  });

  // ---- power: after sleep, rebuild what Windows may have dropped ----
  powerMonitor.on('suspend', () => {
    log('INFO', 'power: suspend');
    autoSwitch.stop();
    engine.stop();
  });
  powerMonitor.on('resume', () => {
    log('INFO', 'power: resume');
    setTimeout(() => {
      engine.stop(); // a fresh COM session: endpoints can be re-created across sleep
      applyBinds();
      autoSwitch.restart();
      audio.refresh(true).then(changed).catch(() => {});
    }, 3000);
  });

  // ---- start ----
  applyBinds();
  autoSwitch.restart();
  // Re-assert our APO chain at start (no write when it is already current); skipped without APO.
  if (apo.info()) audio.applyEq().catch((e) => log('ERROR', `apo at start: ${e.message}`));

  const saveBinds = (list) => { binds = kbModel.normalizeBinds(list, audio.get().profiles); store.setBinds(binds); return applyBinds(); };
  ctx = { engine, apo, audio, autoSwitch, keybinds, run, notify, showWindow, showSettings, saveBinds };
  return ctx;
}

// The main tray icon's menu, built fresh each time it opens.
async function trayMenu({ devices, quit }) {
  const { audio, run, showWindow, showSettings } = ctx;
  await Promise.race([audio.refresh(), new Promise((r) => setTimeout(r, 700))]);
  const a = audio.get();
  const t = audio.targets();
  const h = audio.headset({ savedDevices: store.getDevices() });
  const lastEq = audio.lastApply();
  const safe = (fn) => () => Promise.resolve().then(fn).catch((e) => ctx.notify('CYL Audio Hub', e.message));
  const items = [
    { label: 'Abrir CYL Audio Hub', click: () => showWindow() },
    { type: 'separator' },
    { label: `Perfil ativo: ${a.profiles[a.activeProfile].name}`, enabled: false },
    {
      label: 'Alternar perfil',
      submenu: a.order.map((id) => ({ label: a.profiles[id].name, type: 'radio', checked: id === a.activeProfile, click: safe(() => run(`profile:${id}`)) })),
    },
    { type: 'separator' },
    { label: `Headset: ${h.connected ? 'conectado' : 'não detectado'} · bateria ${h.battery.label.toLowerCase()}`, enabled: false },
    ...devices.map((d) => ({ label: `${d.name}: ${d.offline || d.capacity == null ? 'sem leitura' : `${d.capacity}%${d.charging ? ' (carregando)' : ''}`}`, enabled: false })),
    { type: 'separator' },
    { label: 'Microfone silenciado', type: 'checkbox', checked: !!(t.capture && t.capture.mute), enabled: !!t.capture, click: safe(() => run('mic:toggle')) },
    { label: lastEq.installed === false ? 'Equalização ativa (Equalizer APO ausente)' : 'Equalização ativa', type: 'checkbox', checked: a.eqEnabled, click: safe(() => run('eq:toggle')) },
    { type: 'separator' },
    { label: 'Configurações', click: () => showSettings() },
    { label: 'Sair do CYL Audio Hub', click: () => quit() },
  ];
  return items;
}

function shutdown() {
  if (!ctx) return;
  try { globalShortcut.unregisterAll(); } catch (_) {}
  ctx.autoSwitch.stop();
  ctx.engine.stop();
}

module.exports = { init, trayMenu, shutdown, get: () => ctx };
