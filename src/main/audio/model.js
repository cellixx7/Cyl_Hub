// Audio data model: EQ bands, the starting profiles, and validation for everything that comes in
// from the window or from an imported file. Pure (no Electron), so it is unit-tested directly.
//
// The starting curves are points of departure picked by ear for a closed 53 mm gaming headset, not
// measurements of the H510-PRO: there is no published frequency response for it. Every built-in
// profile can be edited, and "Restaurar padrão" brings back these values.

const BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const GAIN_MIN = -12;
const GAIN_MAX = 12;
const PREAMP_MIN = -24;
const PREAMP_MAX = 6;
const MAX_PROFILES = 50;
const NAME_MAX = 48;

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const round1 = (n) => Math.round(n * 10) / 10;
const num = (v, def) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : def);

// Lowest preamp that keeps a full-scale signal from clipping after the boosts. APO's GraphicEQ
// interpolates between bands, so the peak of the curve is the largest band gain.
function safePreamp(bands) {
  const peak = Math.max(0, ...bands.map((b) => num(b, 0)));
  return peak === 0 ? 0 : -Math.ceil(peak * 2) / 2;
}

// True when preamp + loudest band can push a full-scale signal over 0 dBFS.
function clipRisk(profile) {
  const peak = Math.max(0, ...profile.bands);
  return profile.preamp + peak > 0.05;
}

const DEFAULT_MIC = { filters: false, highpassHz: 80, presenceDb: 0, gainDb: 0 };

function preset(id, name, bands, extra = {}) {
  return {
    id,
    name,
    builtin: true,
    bands,
    preamp: extra.preamp ?? safePreamp(bands),
    mic: extra.mic ? { ...DEFAULT_MIC, ...extra.mic } : null,
    note: extra.note || '',
  };
}

// Valorant: less sub-bass (explosions and the low rumble mask steps), a lift where steps and
// reloads carry their detail (2-4 kHz), a little air at 8 kHz, no surround/crossfeed processing
// at all so Valorant's own HRTF positioning is not processed twice.
const DEFAULT_PROFILES = [
  preset('padrao', 'Padrão', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], {
    note: 'Sem equalização: o áudio passa sem alteração.',
  }),
  preset('valorant', 'Valorant — Competitivo', [-4, -3, -1.5, -0.5, 0, 0.5, 2.5, 3.5, 2, 0], {
    note: 'Menos graves profundos, mais 2–4 kHz (passos e recargas). Desative o HRTF/7.1 de outros softwares para não processar o espaço duas vezes.',
  }),
  preset('musica', 'Música — Equilibrado', [1.5, 1, 0, -0.5, 0, 0, 0, 0.5, 1, 1], {
    note: 'Correção leve, preserva vozes e instrumentos.',
  }),
  preset('musica-graves', 'Música — Graves', [5, 4.5, 3, 1, 0, 0, 0, 0, 0.5, 0.5], {
    note: 'Reforço moderado de graves com preamp negativo para não distorcer.',
  }),
  preset('discord', 'Discord — Comunicação', [-3, -2, -1, 0, 0.5, 1.5, 2.5, 2, 0, -1], {
    note: 'Realça a faixa da voz. No microfone: corta ruído grave abaixo de 100 Hz e realça a presença.',
    mic: { filters: true, highpassHz: 100, presenceDb: 2, gainDb: 0 },
  }),
];

const DEFAULT_AUDIO = () => ({
  eqEnabled: true,
  activeProfile: 'padrao',
  manualProfile: 'padrao', // the last one chosen by hand: the automatic switch returns to it
  profiles: Object.fromEntries(DEFAULT_PROFILES.map((p) => [p.id, JSON.parse(JSON.stringify(p))])),
  order: DEFAULT_PROFILES.map((p) => p.id),
  targetRender: null,  // endpoint id the EQ applies to; null = the H510-PRO if present, else the default output
  targetCapture: null, // endpoint id for the microphone; null = the H510-PRO mic if present, else the default input
  notifyProfileSwitch: true,
  autoSwitch: {
    enabled: false,
    intervalSec: 10,
    // In priority order: the first rule whose program is running wins.
    rules: [{ exe: 'valorant-win64-shipping', profile: 'valorant' }],
  },
});

function cleanName(name, fallback) {
  const s = String(name == null ? '' : name).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, NAME_MAX);
  return s || fallback;
}

function cleanBands(bands) {
  const arr = Array.isArray(bands) ? bands : [];
  return BANDS.map((_, i) => round1(clamp(num(arr[i], 0), GAIN_MIN, GAIN_MAX)));
}

function cleanMic(mic) {
  if (!mic || typeof mic !== 'object') return null;
  return {
    filters: !!mic.filters,
    highpassHz: Math.round(clamp(num(mic.highpassHz, 80), 20, 300)),
    presenceDb: round1(clamp(num(mic.presenceDb, 0), -6, 9)),
    gainDb: round1(clamp(num(mic.gainDb, 0), -12, 20)),
  };
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

function slug(name) {
  return String(name).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'perfil';
}

function uniqueId(base, taken) {
  let id = ID_RE.test(base) ? base : slug(base);
  if (!taken.has(id)) return id;
  for (let i = 2; ; i++) if (!taken.has(`${id}-${i}`)) return `${id}-${i}`;
}

function cleanProfile(p, id) {
  const bands = cleanBands(p && p.bands);
  return {
    id,
    name: cleanName(p && p.name, 'Perfil'),
    builtin: !!(p && p.builtin),
    bands,
    preamp: round1(clamp(num(p && p.preamp, safePreamp(bands)), PREAMP_MIN, PREAMP_MAX)),
    mic: cleanMic(p && p.mic),
    note: cleanName(p && p.note, '').slice(0, 300),
  };
}

const EXE_RE = /^[a-z0-9 ._()+-]{1,64}$/;
function cleanExe(exe) {
  const s = String(exe || '').trim().toLowerCase().replace(/\.exe$/, '');
  return EXE_RE.test(s) ? s : null;
}

// Brings a stored (or partly written) audio state to a valid one; unknown keys are dropped.
function normalizeAudio(raw) {
  const def = DEFAULT_AUDIO();
  const a = raw && typeof raw === 'object' ? raw : {};
  const profiles = {};
  const src = a.profiles && typeof a.profiles === 'object' ? a.profiles : def.profiles;
  for (const [id, p] of Object.entries(src)) {
    if (!ID_RE.test(id) || Object.keys(profiles).length >= MAX_PROFILES) continue;
    profiles[id] = cleanProfile(p, id);
  }
  if (!profiles.padrao) profiles.padrao = cleanProfile(def.profiles.padrao, 'padrao');
  const order = [...new Set([...(Array.isArray(a.order) ? a.order : []), ...Object.keys(profiles)])].filter((id) => profiles[id]);
  const pick = (id) => (profiles[id] ? id : 'padrao');
  const as = a.autoSwitch && typeof a.autoSwitch === 'object' ? a.autoSwitch : def.autoSwitch;
  const rules = (Array.isArray(as.rules) ? as.rules : [])
    .map((r) => ({ exe: cleanExe(r && r.exe), profile: r && r.profile }))
    .filter((r) => r.exe && profiles[r.profile])
    .slice(0, 30);
  const endpoint = (v) => (typeof v === 'string' && v.length < 300 && /^\{[0-9.]+\}\.\{[0-9a-fA-F-]{36}\}$/.test(v) ? v : null);
  return {
    eqEnabled: a.eqEnabled === undefined ? def.eqEnabled : !!a.eqEnabled,
    activeProfile: pick(a.activeProfile),
    manualProfile: pick(a.manualProfile || a.activeProfile),
    profiles,
    order,
    targetRender: endpoint(a.targetRender),
    targetCapture: endpoint(a.targetCapture),
    notifyProfileSwitch: a.notifyProfileSwitch === undefined ? true : !!a.notifyProfileSwitch,
    autoSwitch: {
      enabled: !!as.enabled,
      intervalSec: Math.round(clamp(num(as.intervalSec, 10), 5, 300)),
      rules,
    },
  };
}

// ---- export / import ----
const EXPORT_FORMAT = 'cyl-audio-hub.profiles';

function exportProfiles(audio, ids) {
  const list = (ids && ids.length ? ids : audio.order).filter((id) => audio.profiles[id]);
  return {
    format: EXPORT_FORMAT,
    version: 1,
    bands: BANDS,
    profiles: list.map((id) => {
      const { builtin, ...rest } = audio.profiles[id];
      return rest;
    }),
  };
}

// Returns { audio, added: [names] }. Imported profiles never replace existing ones: a clashing id
// gets a new one. Throws with a readable message on anything that is not our export format.
function importProfiles(audio, data) {
  if (!data || typeof data !== 'object' || data.format !== EXPORT_FORMAT) throw new Error('Arquivo não é uma exportação de perfis do CYL Audio Hub.');
  if (!Array.isArray(data.profiles) || !data.profiles.length) throw new Error('O arquivo não contém perfis.');
  if (Array.isArray(data.bands) && data.bands.join() !== BANDS.join()) throw new Error('As bandas do arquivo não são as 10 bandas deste equalizador.');
  const next = JSON.parse(JSON.stringify(audio));
  const taken = new Set(Object.keys(next.profiles));
  const added = [];
  for (const p of data.profiles.slice(0, MAX_PROFILES)) {
    if (taken.size >= MAX_PROFILES) break;
    const id = uniqueId(String((p && p.id) || slug((p && p.name) || 'perfil')), taken);
    taken.add(id);
    next.profiles[id] = { ...cleanProfile(p, id), builtin: false };
    next.order.push(id);
    added.push(next.profiles[id].name);
  }
  return { audio: normalizeAudio(next), added };
}

function defaultProfile(id) {
  const p = DEFAULT_PROFILES.find((d) => d.id === id);
  return p ? JSON.parse(JSON.stringify(p)) : null;
}

module.exports = {
  BANDS, GAIN_MIN, GAIN_MAX, PREAMP_MIN, PREAMP_MAX, MAX_PROFILES,
  DEFAULT_PROFILES, DEFAULT_AUDIO, DEFAULT_MIC,
  safePreamp, clipRisk, normalizeAudio, cleanProfile, cleanExe, uniqueId, slug,
  exportProfiles, importProfiles, defaultProfile,
};
