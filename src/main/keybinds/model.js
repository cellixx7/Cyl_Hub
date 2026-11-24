// Keybinds: accelerator parsing, validation and conflict detection. Pure, so it is unit-tested.
//
// Binds are registered with Electron's globalShortcut, which on Windows is RegisterHotKey: Windows
// tells the app when that exact combination is pressed. It is not a keyboard hook, reads no other
// keys and touches no other process, so it is safe next to anti-cheat software such as Vanguard.
// The flip side of RegisterHotKey: a registered combination is consumed, the focused program (the
// game) never sees it. Hence the rules below: a modifier is required, and plain Ctrl+key / Alt+key /
// Shift+key combinations get a warning because games use them (Ctrl is crouch in Valorant).

const MODIFIERS = ['Control', 'Alt', 'Shift', 'Super'];
const MOD_ALIASES = { ctrl: 'Control', control: 'Control', commandorcontrol: 'Control', cmdorctrl: 'Control', alt: 'Alt', option: 'Alt', shift: 'Shift', super: 'Super', meta: 'Super', win: 'Super', cmd: 'Super', command: 'Super' };
const NAMED_KEYS = [
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
  'Space', 'Tab', 'Backspace', 'Delete', 'Insert', 'Return', 'Enter', 'Up', 'Down', 'Left', 'Right',
  'Home', 'End', 'PageUp', 'PageDown', 'Escape', 'Esc', 'VolumeUp', 'VolumeDown', 'VolumeMute',
  'MediaNextTrack', 'MediaPreviousTrack', 'MediaStop', 'MediaPlayPause', 'PrintScreen',
  'num0', 'num1', 'num2', 'num3', 'num4', 'num5', 'num6', 'num7', 'num8', 'num9',
  'numadd', 'numsub', 'nummult', 'numdiv', 'numdec',
  'Plus', '-', '=', ',', '.', '/', ';', "'", '[', ']', '\\', '`',
];
const KEY_LOOKUP = new Map(NAMED_KEYS.map((k) => [k.toLowerCase(), k === 'Enter' ? 'Return' : k === 'Esc' ? 'Escape' : k]));

// Combinations Windows (or the shell) keeps for itself: RegisterHotKey either fails or steals them.
const RESERVED = new Set([
  'Alt+Tab', 'Alt+Shift+Tab', 'Alt+F4', 'Alt+Escape', 'Alt+Space', 'Control+Escape', 'Control+Shift+Escape',
  'Control+Alt+Delete', 'Alt+PrintScreen', 'PrintScreen', 'Control+Alt+Tab', 'Alt+Return',
]);

// Splits "Ctrl + Alt + 1" into a canonical "Control+Alt+1", or returns null when it is not a
// usable combination (no key, two keys, unknown key).
function normalize(accel) {
  if (typeof accel !== 'string' || !accel.trim() || accel.length > 64) return null;
  const parts = accel.split('+').map((s) => s.trim());
  // "Ctrl++" / "Ctrl+Plus": a literal plus key
  const tokens = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '' && i === parts.length - 1 && parts[i - 1] === '') { tokens.push('Plus'); continue; }
    if (parts[i] !== '') tokens.push(parts[i]);
  }
  const mods = new Set();
  let key = null;
  for (const t of tokens) {
    const mod = MOD_ALIASES[t.toLowerCase()];
    if (mod) { mods.add(mod); continue; }
    if (key) return null;
    if (/^[a-z0-9]$/i.test(t)) key = t.toUpperCase();
    else key = KEY_LOOKUP.get(t.toLowerCase()) || null;
    if (!key) return null;
  }
  if (!key) return null;
  return [...MODIFIERS.filter((m) => mods.has(m)), key].join('+');
}

const PT_NAMES = { Control: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Super: 'Win', Return: 'Enter', Escape: 'Esc', Up: '↑', Down: '↓', Left: '←', Right: '→', Space: 'Espaço', Plus: '+' };
const display = (canon) => (canon ? canon.split('+').map((p) => PT_NAMES[p] || p).join(' + ') : '');

// Problems that stop a bind from being saved (error) or that the user should know about (warning).
function check(canon) {
  if (!canon) return { error: 'Combinação inválida. Use um modificador (Ctrl, Alt, Shift) e uma tecla.' };
  const parts = canon.split('+');
  const mods = parts.slice(0, -1);
  const key = parts[parts.length - 1];
  if (RESERVED.has(canon)) return { error: 'Combinação reservada pelo Windows.' };
  if (mods.includes('Super')) return { error: 'Combinações com a tecla Windows são reservadas pelo sistema na maioria dos casos. Use Ctrl, Alt ou Shift.' };
  const mediaKey = /^(Volume|Media)/.test(key) || /^F(1[3-9]|2[0-4])$/.test(key);
  if (!mods.length && !mediaKey) return { error: 'Atalho sem modificador seria capturado em qualquer programa (inclusive no jogo). Adicione Ctrl, Alt ou Shift.' };
  if (!mods.length && mediaKey) return { warning: 'Teclas de mídia sem modificador deixam de funcionar nos outros programas enquanto o bind estiver ativo.' };
  if (mods.length === 1 && /^([A-Z0-9]|Space|Tab|F[1-9]|F1[0-2])$/.test(key)) {
    return { warning: `${display(mods[0])} + tecla comum é usado por jogos (no Valorant, Ctrl agacha). Enquanto o bind estiver ativo o jogo não recebe essa combinação. Prefira Ctrl + Alt + tecla.` };
  }
  return {};
}

// ---- actions ----

const STATIC_ACTIONS = [
  { id: 'eq:toggle', label: 'Ativar/desativar equalizador', category: 'Equalizador' },
  { id: 'mic:toggle', label: 'Silenciar/ativar microfone', category: 'Microfone' },
  { id: 'profile:next', label: 'Próximo perfil', category: 'Perfis' },
  { id: 'battery:show', label: 'Mostrar bateria dos dispositivos', category: 'Dispositivos' },
  { id: 'window:toggle', label: 'Abrir/ocultar CYL Audio Hub', category: 'Aplicativo' },
  { id: 'volume:up', label: 'Aumentar volume do headset (+5%)', category: 'Volume' },
  { id: 'volume:down', label: 'Diminuir volume do headset (−5%)', category: 'Volume' },
];

function actionList(profiles, order) {
  const list = [...STATIC_ACTIONS];
  for (const id of order) {
    if (profiles[id]) list.push({ id: `profile:${id}`, label: `Ativar perfil ${profiles[id].name}`, category: 'Perfis' });
  }
  return list;
}

function validAction(action, profiles) {
  if (STATIC_ACTIONS.some((a) => a.id === action)) return true;
  const m = /^profile:([a-z0-9-]+)$/.exec(action || '');
  return !!(m && profiles[m[1]]);
}

// The examples from the spec, all off until the user turns them on.
const DEFAULT_BINDS = () => [
  { id: 'b1', action: 'profile:valorant', accelerator: 'Control+Alt+1', enabled: false },
  { id: 'b2', action: 'profile:musica', accelerator: 'Control+Alt+2', enabled: false },
  { id: 'b3', action: 'profile:discord', accelerator: 'Control+Alt+3', enabled: false },
  { id: 'b4', action: 'eq:toggle', accelerator: 'Control+Alt+E', enabled: false },
  { id: 'b5', action: 'mic:toggle', accelerator: 'Control+Alt+M', enabled: false },
  { id: 'b6', action: 'battery:show', accelerator: 'Control+Alt+B', enabled: false },
  { id: 'b7', action: 'window:toggle', accelerator: 'Control+Alt+H', enabled: false },
];

const MAX_BINDS = 40;

function normalizeBinds(raw, profiles) {
  const list = Array.isArray(raw) ? raw : DEFAULT_BINDS();
  const seen = new Set();
  const out = [];
  for (const b of list) {
    if (!b || typeof b !== 'object' || out.length >= MAX_BINDS) continue;
    const id = typeof b.id === 'string' && /^[a-z0-9-]{1,24}$/.test(b.id) && !seen.has(b.id) ? b.id : null;
    if (!id) continue;
    seen.add(id);
    if (!validAction(b.action, profiles)) continue;
    out.push({ id, action: b.action, accelerator: normalize(b.accelerator) || '', enabled: !!b.enabled });
  }
  return out;
}

// Map bind id -> conflict message, for enabled binds that share a combination.
function duplicates(binds) {
  const byAccel = new Map();
  for (const b of binds) {
    if (!b.enabled || !b.accelerator) continue;
    if (!byAccel.has(b.accelerator)) byAccel.set(b.accelerator, []);
    byAccel.get(b.accelerator).push(b.id);
  }
  const out = {};
  for (const [, ids] of byAccel) if (ids.length > 1) for (const id of ids) out[id] = 'Mesma combinação de outro bind ativo.';
  return out;
}

module.exports = { normalize, display, check, actionList, validAction, DEFAULT_BINDS, normalizeBinds, duplicates, STATIC_ACTIONS, RESERVED };
