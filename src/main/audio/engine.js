// Client for native/AudioEngine.exe in its persistent "serve" mode.
//
// One engine process at most. It starts on the first call and exits after IDLE_MS without calls
// (or when the app quits: closing its stdin ends it), so an idle app in the tray costs nothing
// here. Something that needs it running steadily (the automatic profile switch) holds it with
// keepAlive(true). A call that hangs is rejected after CALL_TIMEOUT_MS and the engine restarted.
// Every argument is sent as data on stdin, never through a shell, and is checked first.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const IDLE_MS = 45 * 1000;
const CALL_TIMEOUT_MS = 8000;

function enginePath() {
  const candidates = [
    process.resourcesPath && path.join(process.resourcesPath, 'native', 'AudioEngine.exe'),
    path.join(__dirname, '..', '..', '..', 'native', 'AudioEngine.exe'),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function createEngine({ exe = enginePath(), log = () => {}, spawnFn = spawn } = {}) {
  let child = null;
  let seq = 0;
  let idleTimer = null;
  let held = false;
  const pending = new Map();

  function failAll(message) {
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error(message)); }
    pending.clear();
  }

  function stop() {
    clearTimeout(idleTimer);
    const c = child;
    child = null;
    if (c) {
      try { c.stdin.end(); } catch (_) {}
      setTimeout(() => { try { c.kill(); } catch (_) {} }, 1500).unref?.();
    }
    failAll('motor de áudio encerrado');
  }

  function armIdle() {
    clearTimeout(idleTimer);
    if (held) return;
    idleTimer = setTimeout(() => { if (!pending.size && !held) stop(); }, IDLE_MS);
    idleTimer.unref?.();
  }

  function start() {
    if (!exe) throw new Error('AudioEngine.exe não encontrado (rode npm start ou npm run dist para compilá-lo)');
    const c = spawnFn(exe, ['serve'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    child = c;
    c.on('error', (e) => { log('ERROR', `audio engine: ${e.message}`); if (child === c) { child = null; failAll(e.message); } });
    c.on('exit', (code) => { if (child === c) { child = null; failAll(`motor de áudio saiu (código ${code})`); } });
    const rl = readline.createInterface({ input: c.stdout });
    rl.on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch (_) { return; }
      const p = pending.get(String(msg.id));
      if (!p) return;
      pending.delete(String(msg.id));
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg);
      else p.reject(new Error(msg.error || 'falha no motor de áudio'));
      armIdle();
    });
  }

  function call(cmd, ...args) {
    for (const a of args) {
      if (typeof a !== 'string' || /[\t\r\n]/.test(a) || a.length > 512) {
        return Promise.reject(new Error('argumento inválido para o motor de áudio'));
      }
    }
    return new Promise((resolve, reject) => {
      try { if (!child) start(); } catch (e) { reject(e); return; }
      clearTimeout(idleTimer);
      const id = String(++seq);
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('o motor de áudio não respondeu a tempo'));
        log('ERROR', `audio engine: timeout on ${cmd}, restarting`);
        stop();
      }, CALL_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write([id, cmd, ...args].join('\t') + '\n');
    });
  }

  const pct = (n) => {
    const v = Number(n);
    if (!Number.isFinite(v) || value === '' || value === null) throw new Error('volume inválido');
    return String(Math.max(0, Math.min(100, Math.round(v * 10) / 10)));
  };

  return {
    available: () => !!exe,
    running: () => !!child,
    keepAlive(on) { held = !!on; if (held) clearTimeout(idleTimer); else armIdle(); },
    stop,
    status: () => call('status').then((r) => r.status),
    procs: () => call('procs').then((r) => r.procs),
    peaks: () => call('peaks').then((r) => r.peaks),
    sessions: () => call('sessions').then((r) => r.sessions),
    setVolume: (id, value) => { try { return call('volume', id, pct(value)); } catch (e) { return Promise.reject(e); } },
    setMute: (id, on) => call('mute', id, on ? '1' : '0'),
    setDefault: (id, roles = 'all') => {
      if (!['all', 'media', 'comm'].includes(roles)) return Promise.reject(new Error('papel inválido'));
      return call('default', id, roles);
    },
  };
}

module.exports = { createEngine, enginePath };
