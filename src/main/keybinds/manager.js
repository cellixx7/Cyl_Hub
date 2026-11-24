// Keybind Manager: (re)registers the enabled binds with globalShortcut and remembers, per bind,
// whether Windows accepted it. One bind that cannot be registered never stops the others.
const model = require('./model');

function createKeybinds({ globalShortcut, run, log = () => {} }) {
  let state = {}; // bind id -> { registered, error, warning }
  let current = [];

  function unregisterAll() {
    for (const b of current) {
      if (state[b.id] && state[b.id].registered) {
        try { globalShortcut.unregister(b.accelerator); } catch (_) {}
      }
    }
    state = {};
  }

  function apply(binds) {
    unregisterAll();
    current = binds.map((b) => ({ ...b }));
    const dup = model.duplicates(current);
    for (const b of current) {
      const res = model.check(b.accelerator);
      const entry = { registered: false, error: null, warning: res.warning || null };
      state[b.id] = entry;
      if (!b.enabled) continue;
      if (!b.accelerator) { entry.error = 'Sem combinação definida.'; continue; }
      if (res.error) { entry.error = res.error; continue; }
      if (dup[b.id]) {
        // The first one keeps the combination; the others show the conflict.
        const first = current.find((o) => o.enabled && o.accelerator === b.accelerator);
        if (first.id !== b.id) { entry.error = dup[b.id]; continue; }
        entry.warning = dup[b.id];
      }
      try {
        const ok = globalShortcut.register(b.accelerator, () => {
          Promise.resolve().then(() => run(b.action)).catch((e) => log('ERROR', `bind ${b.accelerator} -> ${b.action}: ${e && e.message}`));
        });
        if (ok) entry.registered = true;
        else entry.error = 'O Windows recusou: a combinação já está em uso por outro programa ou é reservada.';
      } catch (e) {
        entry.error = `Não foi possível registrar: ${e.message}`;
      }
    }
    const failed = Object.values(state).filter((s) => s.error).length;
    log('INFO', `keybinds: ${Object.values(state).filter((s) => s.registered).length} registered, ${failed} not`);
    return status();
  }

  const status = () => JSON.parse(JSON.stringify(state));

  return { apply, status, unregisterAll, reapply: () => apply(current) };
}

module.exports = { createKeybinds };
