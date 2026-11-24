// Equalizer APO integration. APO does the real audio processing inside Windows' audio engine, for
// every program; this app only writes its configuration.
//
// What is touched, and how:
//  - Our own file, <APO config>\cyl-audio-hub.txt, holds the whole chain (preamp, 10-band
//    GraphicEQ for the chosen output, optional microphone filters). APO reloads it by itself.
//  - config.txt (APO's main file, which the user may have edited) gets one line, "Include:
//    cyl-audio-hub.txt", appended at the end. Before the first change a copy goes to the app's
//    backup folder; every write is atomic (temporary file + rename), so a crash never leaves a
//    half-written config.
//  - Lines of config.txt are only ever commented out when the user asks for "use only CYL", and
//    then with a marker, so "Remover integração" can put back exactly what was there.
// Turning the EQ off writes an empty chain: our Include stays, and nothing is processed.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { BANDS } = require('./model');

const OWN_FILE = 'cyl-audio-hub.txt';
const INCLUDE_LINE = `Include: ${OWN_FILE}`;
const DISABLED_MARK = '# [CYL desativado] ';
const APO_CLSID = '{EACD2258-FCAC-4FF4-B36D-419E924A6D79}'; // Equalizer APO's audio processing object
const MAX_BACKUPS = 10;

// ---- locating APO ----

function regValue(key, name) {
  try {
    const out = execFileSync('reg.exe', ['query', key, '/v', name], { encoding: 'utf8', windowsHide: true, timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(new RegExp(`${name}\\s+REG_\\w+\\s+(.+)`));
    return m ? m[1].trim() : null;
  } catch (_) {
    return null;
  }
}

// Where APO keeps its config, or null when it is not installed. Read once per call site: the
// answer only changes when the user installs or removes APO.
function locate({ env = process.env, exists = fs.existsSync, reg = regValue } = {}) {
  const fromReg = reg('HKLM\\SOFTWARE\\EqualizerAPO', 'ConfigPath');
  const candidates = [
    fromReg,
    path.join(env.ProgramFiles || 'C:\\Program Files', 'EqualizerAPO', 'config'),
    path.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'EqualizerAPO', 'config'),
  ].filter(Boolean);
  const configDir = candidates.find((d) => exists(path.join(d, 'config.txt')));
  if (!configDir) return null;
  return { configDir, installDir: path.dirname(configDir), configurator: path.join(path.dirname(configDir), 'Configurator.exe') };
}

// Whether APO is installed on one endpoint (chosen in APO's Configurator). Reads the endpoint's
// FxProperties; nothing is changed. Returns true / false, or null when it could not be read.
function installedOnEndpoint(endpointId, { reg = execFileSync } = {}) {
  const m = /^\{0\.0\.(0|1)\.[0-9]+\}\.(\{[0-9a-fA-F-]{36}\})$/.exec(endpointId || '');
  if (!m) return null;
  const flow = m[1] === '0' ? 'Render' : 'Capture';
  try {
    const out = reg('reg.exe', ['query', `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio\\${flow}\\${m[2]}\\FxProperties`],
      { encoding: 'utf8', windowsHide: true, timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.toUpperCase().includes(APO_CLSID);
  } catch (_) {
    return null;
  }
}

// ---- rendering our chain ----

const fmt = (n) => (Math.round(n * 100) / 100).toFixed(2).replace(/\.?0+$/, '') || '0';
const guidOf = (endpointId) => {
  const m = /\.(\{[0-9a-fA-F-]{36}\})$/.exec(endpointId || '');
  return m ? m[1] : null;
};

// state: { enabled, profile: {name, preamp, bands, mic}, renderId, captureId }
function render({ enabled, profile, renderId, captureId }) {
  const lines = [
    '# Gerado pelo CYL Audio Hub. Este arquivo é reescrito pelo app:',
    '# edite os perfis no CYL Audio Hub, não aqui.',
  ];
  if (!enabled || !profile) {
    lines.push('# Equalização desativada no CYL Audio Hub: nada é processado.');
    return lines.join('\r\n') + '\r\n';
  }
  lines.push(`# Perfil: ${String(profile.name).replace(/[\r\n]/g, ' ')}`);
  const out = guidOf(renderId);
  const flat = profile.bands.every((b) => b === 0) && profile.preamp === 0;
  if (!flat) {
    // Scoped to the chosen output, so other outputs (the monitor's speakers) stay untouched.
    lines.push(out ? `Device: ${out}` : 'Device: all');
    lines.push(`Preamp: ${fmt(profile.preamp)} dB`);
    lines.push(`GraphicEQ: ${BANDS.map((f, i) => `${f} ${fmt(profile.bands[i])}`).join('; ')}`);
  }
  const mic = profile.mic;
  const inp = guidOf(captureId);
  if (mic && mic.filters && inp) {
    lines.push(`Device: ${inp}`);
    if (mic.gainDb) lines.push(`Preamp: ${fmt(mic.gainDb)} dB`);
    if (mic.highpassHz) lines.push(`Filter: ON HP Fc ${Math.round(mic.highpassHz)} Hz`);
    if (mic.presenceDb) lines.push(`Filter: ON PK Fc 3500 Hz Gain ${fmt(mic.presenceDb)} dB Q 1.0`);
  }
  // Leave no device scope behind for anything APO reads after this file.
  lines.push('Device: all');
  return lines.join('\r\n') + '\r\n';
}

// ---- file operations ----

function atomicWrite(file, text) {
  const tmp = `${file}.cyl-tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
}

function backup(configFile, backupDir) {
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(backupDir, `config.txt.${stamp}.bak`);
  fs.copyFileSync(configFile, dest);
  const all = fs.readdirSync(backupDir).filter((f) => /^config\.txt\..+\.bak$/.test(f)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - MAX_BACKUPS))) {
    try { fs.unlinkSync(path.join(backupDir, old)); } catch (_) {}
  }
  return dest;
}

const lineIsOurs = (l) => l.trim().toLowerCase() === INCLUDE_LINE.toLowerCase();
const isActive = (l) => { const t = l.trim(); return t && !t.startsWith('#') && !lineIsOurs(l); };

// Lines of config.txt, besides ours, that APO would still apply on top of our chain.
function otherActiveLines(text) {
  return text.split(/\r?\n/).filter(isActive);
}

function friendlyError(e, dir) {
  if (e && (e.code === 'EACCES' || e.code === 'EPERM')) {
    return new Error(`Sem permissão para gravar em ${dir}. Reinstale o Equalizer APO (ele dá permissão de escrita à pasta config) ou ajuste as permissões da pasta.`);
  }
  return e;
}

function createApo({ backupDir, locateFn = locate, log = () => {} }) {
  let where = null;
  let checkedAt = 0;

  function info(force) {
    if (force || !checkedAt || Date.now() - checkedAt > 60 * 1000) { where = locateFn(); checkedAt = Date.now(); }
    return where;
  }

  function status({ renderId, captureId } = {}) {
    const w = info(true);
    if (!w) return { installed: false };
    const cfg = path.join(w.configDir, 'config.txt');
    let text = '';
    try { text = fs.readFileSync(cfg, 'utf8'); } catch (_) {}
    return {
      installed: true,
      configDir: w.configDir,
      configurator: fs.existsSync(w.configurator) ? w.configurator : null,
      included: text.split(/\r?\n/).some(lineIsOurs),
      otherLines: otherActiveLines(text).slice(0, 20),
      onRender: renderId ? installedOnEndpoint(renderId) : null,
      onCapture: captureId ? installedOnEndpoint(captureId) : null,
    };
  }

  // Writes our chain and makes sure config.txt includes it. Returns what was done.
  function apply(chain) {
    const w = info();
    if (!w) return { ok: false, installed: false };
    const cfg = path.join(w.configDir, 'config.txt');
    try {
      const own = path.join(w.configDir, OWN_FILE);
      const body = render(chain);
      let old = null;
      try { old = fs.readFileSync(own, 'utf8'); } catch (_) {}
      if (old !== body) atomicWrite(own, body); // unchanged: no write, so APO doesn't reload for nothing
      const text = fs.readFileSync(cfg, 'utf8');
      let backupFile = null;
      if (!text.split(/\r?\n/).some(lineIsOurs)) {
        backupFile = backup(cfg, backupDir);
        // Keep the file's own line endings (APO's installer writes CRLF; a hand-edited file may be LF).
        const eol = text.includes('\r\n') || !text.includes('\n') ? '\r\n' : '\n';
        const sep = text.length && !text.endsWith('\n') ? eol : '';
        atomicWrite(cfg, `${text}${sep}${INCLUDE_LINE}${eol}`);
        log('INFO', `apo: added include to ${cfg} (backup ${backupFile})`);
      }
      return { ok: true, installed: true, backupFile };
    } catch (e) {
      throw friendlyError(e, w.configDir);
    }
  }

  // Comments out every other active line of config.txt (marked, so remove() restores them).
  function exclusive() {
    const w = info(true);
    if (!w) throw new Error('Equalizer APO não está instalado.');
    const cfg = path.join(w.configDir, 'config.txt');
    try {
      const text = fs.readFileSync(cfg, 'utf8');
      const backupFile = backup(cfg, backupDir);
      const eol = text.includes('\r\n') ? '\r\n' : '\n';
      const next = text.split(/\r?\n/).map((l) => (isActive(l) ? DISABLED_MARK + l : l)).join(eol);
      atomicWrite(cfg, next);
      return { ok: true, backupFile };
    } catch (e) {
      throw friendlyError(e, w.configDir);
    }
  }

  // Undoes everything this app did to APO: drops our Include, restores lines it commented out,
  // deletes our own file. Other edits the user made in the meantime are kept.
  function remove() {
    const w = info(true);
    if (!w) return { ok: true, installed: false };
    const cfg = path.join(w.configDir, 'config.txt');
    try {
      const text = fs.readFileSync(cfg, 'utf8');
      const backupFile = backup(cfg, backupDir);
      const eol = text.includes('\r\n') ? '\r\n' : '\n';
      const next = text.split(/\r?\n/)
        .filter((l) => !lineIsOurs(l))
        .map((l) => (l.startsWith(DISABLED_MARK) ? l.slice(DISABLED_MARK.length) : l))
        .join(eol);
      atomicWrite(cfg, next);
      try { fs.unlinkSync(path.join(w.configDir, OWN_FILE)); } catch (_) {}
      return { ok: true, backupFile };
    } catch (e) {
      throw friendlyError(e, w.configDir);
    }
  }

  return { info, status, apply, exclusive, remove };
}

module.exports = { createApo, locate, render, installedOnEndpoint, otherActiveLines, INCLUDE_LINE, OWN_FILE, DISABLED_MARK, APO_CLSID };
