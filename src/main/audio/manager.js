// Audio Manager: one place that knows the audio state and changes it. The window, the tray menu,
// the keybinds and the automatic switch all go through here, so they never disagree.
//
// Nothing here polls on its own. The device status is read when something needs it (a page of the
// window asks, the tray menu opens, a bind runs) and cached for STATUS_TTL_MS.
const { EventEmitter } = require('events');
const model = require('./model');

const STATUS_TTL_MS = 2500;
const H510_HID = { vendorId: 0x040b, productId: 0x0897 };

function createAudioManager({ engine, apo, load, save, notify = () => {}, log = () => {} }) {
  const events = new EventEmitter();
  let audio = model.normalizeAudio(load());
  let status = null;
  let statusAt = 0;
  let statusError = null;
  let inflight = null;
  let lastApply = { ok: false, installed: null, error: null };

  const get = () => audio;
  function persist(next) {
    audio = model.normalizeAudio(next);
    save(audio);
    events.emit('changed');
    return audio;
  }

  // ---- device status ----

  async function refresh(force = false) {
    if (!force && status && Date.now() - statusAt < STATUS_TTL_MS) return status;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        if (!engine.available()) throw new Error('Motor de áudio (AudioEngine.exe) ausente.');
        const before = JSON.stringify(summary(status));
        status = await engine.status();
        statusAt = Date.now();
        statusError = null;
        if (JSON.stringify(summary(status)) !== before) events.emit('status');
      } catch (e) {
        statusError = e.message;
        if (!status) status = null;
      } finally {
        inflight = null;
      }
      return status;
    })();
    return inflight;
  }

  // What the tray menu cares about, to tell when it has to be rebuilt.
  function summary(st) {
    if (!st) return null;
    const t = targets(st);
    return { r: t.render && t.render.id, c: t.capture && t.capture.id, m: t.capture && t.capture.mute, z: st.zeus && st.zeus.connected };
  }

  function targets(st = status) {
    if (!st) return { render: null, capture: null };
    const find = (id, flow) => (id ? st.devices.find((d) => d.id === id && d.flow === flow) : null);
    const render = find(audio.targetRender, 'render') || (st.zeus && st.zeus.render) || st.defaultRender || null;
    const capture = find(audio.targetCapture, 'capture') || (st.zeus && st.zeus.capture) || st.defaultCapture || null;
    return { render, capture };
  }

  // ---- EQ through Equalizer APO ----

  async function applyEq() {
    await refresh();
    const t = targets();
    const profile = audio.profiles[audio.activeProfile];
    try {
      const res = apo.apply({
        enabled: audio.eqEnabled,
        profile,
        renderId: (t.render && t.render.id) || audio.targetRender,
        captureId: (t.capture && t.capture.id) || audio.targetCapture,
      });
      lastApply = { ok: !!res.ok, installed: res.installed, error: null, at: Date.now() };
    } catch (e) {
      lastApply = { ok: false, installed: true, error: e.message, at: Date.now() };
      log('ERROR', `apo apply: ${e.message}`);
    }
    events.emit('eq');
    return lastApply;
  }

  async function activateProfile(id, { auto = false, reason = null } = {}) {
    if (!audio.profiles[id]) throw new Error('Perfil inexistente.');
    const changed = audio.activeProfile !== id;
    persist({ ...audio, activeProfile: id, manualProfile: auto ? audio.manualProfile : id });
    const res = await applyEq();
    if (changed && audio.notifyProfileSwitch) {
      const why = auto && reason ? ` (automático: ${reason})` : '';
      notify('Perfil de áudio', `${audio.profiles[id].name}${why}${res.installed === false ? ' — Equalizer APO não instalado: a curva não está sendo aplicada.' : ''}`);
    }
    return res;
  }

  function nextProfile() {
    const i = audio.order.indexOf(audio.activeProfile);
    return activateProfile(audio.order[(i + 1) % audio.order.length]);
  }

  async function setEqEnabled(on) {
    persist({ ...audio, eqEnabled: !!on });
    const res = await applyEq();
    if (audio.notifyProfileSwitch) notify('Equalizador', on ? `Ativado — ${audio.profiles[audio.activeProfile].name}` : 'Desativado');
    return res;
  }

  // ---- profiles ----

  function saveProfile(id, patch) {
    if (!audio.profiles[id]) throw new Error('Perfil inexistente.');
    const cur = audio.profiles[id];
    const next = model.cleanProfile({ ...cur, ...patch, builtin: cur.builtin }, id);
    persist({ ...audio, profiles: { ...audio.profiles, [id]: next } });
    if (id === audio.activeProfile) return applyEq().then(() => audio.profiles[id]);
    return Promise.resolve(audio.profiles[id]);
  }

  function createProfile(fromId, name) {
    if (Object.keys(audio.profiles).length >= model.MAX_PROFILES) throw new Error(`Limite de ${model.MAX_PROFILES} perfis.`);
    const src = audio.profiles[fromId] || audio.profiles.padrao;
    const id = model.uniqueId(model.slug(name || `${src.name} cópia`), new Set(Object.keys(audio.profiles)));
    const p = model.cleanProfile({ ...src, name: name || `${src.name} (cópia)`, builtin: false }, id);
    const order = [...audio.order];
    order.splice(order.indexOf(src.id) + 1, 0, id);
    persist({ ...audio, profiles: { ...audio.profiles, [id]: p }, order });
    return audio.profiles[id];
  }

  async function deleteProfile(id) {
    if (id === 'padrao') throw new Error('O perfil Padrão não pode ser excluído.');
    if (!audio.profiles[id]) return audio;
    const { [id]: _drop, ...profiles } = audio.profiles;
    const wasActive = audio.activeProfile === id;
    persist({ ...audio, profiles, order: audio.order.filter((x) => x !== id), activeProfile: wasActive ? 'padrao' : audio.activeProfile });
    if (wasActive) await applyEq();
    return audio;
  }

  function resetProfile(id) {
    const def = model.defaultProfile(id);
    if (def) return saveProfile(id, def);
    return saveProfile(id, { bands: model.BANDS.map(() => 0), preamp: 0 });
  }

  function importData(data) {
    const { audio: next, added } = model.importProfiles(audio, data);
    persist(next);
    return added;
  }

  // ---- outputs / microphone ----

  async function setVolume(id, value) {
    await engine.setVolume(id, value);
    return refresh(true);
  }

  async function setMute(id, on) {
    await engine.setMute(id, on);
    return refresh(true);
  }

  async function toggleMic() {
    await refresh(true);
    const { capture } = targets();
    if (!capture) throw new Error('Nenhum microfone encontrado.');
    await engine.setMute(capture.id, !capture.mute);
    await refresh(true);
    const muted = targets().capture && targets().capture.mute;
    notify('Microfone', muted ? 'Silenciado' : 'Ativado');
    return muted;
  }

  async function bumpVolume(delta) {
    await refresh(true);
    const { render } = targets();
    if (!render) throw new Error('Nenhuma saída de áudio encontrada.');
    await engine.setVolume(render.id, Math.max(0, Math.min(100, Number(render.volume) + delta)));
    return refresh(true);
  }

  async function setDefault(id, roles) {
    await engine.setDefault(id, roles);
    return refresh(true);
  }

  function setTargets(patch) {
    const next = { ...audio };
    if ('targetRender' in patch) next.targetRender = patch.targetRender || null;
    if ('targetCapture' in patch) next.targetCapture = patch.targetCapture || null;
    persist(next);
    return applyEq();
  }

  // ---- what the window and the tray show ----

  // hidList: the HID devices present (from the HID worker), to tell whether the 2.4 GHz receiver is
  // plugged in even when Windows has no audio endpoint for it yet. savedDevices: battery cards.
  function headset({ hidList = null, savedDevices = {} } = {}) {
    const z = status && status.zeus;
    const dongle = hidList ? hidList.some((d) => d.vendorId === H510_HID.vendorId && d.productId === H510_HID.productId) : null;
    // A battery card for the receiver (set up by the user through "Adicionar dispositivo") is the
    // only source of a real reading; the H510-PRO's receiver offers none on its own (see docs).
    const card = Object.values(savedDevices).find((d) => /040b/i.test(String(d.id)) || /h510/i.test(String(d.product || '')));
    let battery = { kind: 'unavailable', label: 'Indisponível', detail: 'O receptor 2.4 GHz do H510-PRO não informa a carga por HID (só tem um canal de comandos não documentado).' };
    if (card && card.lastReading && card.lastReading.capacity != null && card.online !== false) {
      battery = { kind: 'real', label: `${card.lastReading.capacity}%`, detail: 'Leitura do dispositivo.', charging: !!card.lastReading.charging, at: card.lastReadingAt };
    }
    return {
      name: 'Redragon Zeus Pro H510-PRO',
      connected: !!(z && z.connected),
      dongle,
      render: z && z.render,
      capture: z && z.capture,
      mode: z && z.render ? z.render.mode : null,
      battery,
    };
  }

  function snapshot(extra) {
    return {
      audio,
      status,
      statusError,
      targets: targets(),
      eq: lastApply,
      headset: headset(extra),
      engine: { available: engine.available(), running: engine.running() },
    };
  }

  return {
    events, get, persist, refresh, targets, applyEq, activateProfile, nextProfile, setEqEnabled,
    saveProfile, createProfile, deleteProfile, resetProfile, importData,
    setVolume, setMute, toggleMic, bumpVolume, setDefault, setTargets, headset, snapshot,
    lastApply: () => lastApply,
  };
}

module.exports = { createAudioManager, H510_HID };
