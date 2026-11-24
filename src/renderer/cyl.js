// CYL Audio Hub pages: Visão geral, Equalizador, Microfone, Perfis, Binds and the audio part of
// Dispositivos. Talks to the main process only through window.cyl (preload.js).
//
// Rendering rules: names that come from devices or the user are set with textContent, never as
// HTML. Nothing here runs while the window is hidden: the refresh timer checks document.hidden, the
// microphone test stops when the page or the window goes away, and the window itself is freed by
// the main process 30 s after it is closed to the tray.
(function () {
  const api = window.cyl;
  if (!api) return;
  const $ = (id) => document.getElementById(id);
  const BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const CYL_VIEWS = ['overview', 'equalizer', 'mic', 'profiles', 'binds', 'dashboard'];
  const POLL_MS = 3000;

  let view = 'overview';
  let snap = null;
  let apo = null;
  let apoAt = 0;
  let bindsView = null;

  // ---------- small helpers ----------

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function button(text, cls, onClick) {
    const b = el('button', cls || 'btn btn-ghost', text);
    b.addEventListener('click', onClick);
    return b;
  }
  const fmtDb = (n) => `${n > 0 ? '+' : ''}${Number(n).toFixed(1).replace('.0', '').replace('.', ',')}`;
  const fmtHz = (f) => (f >= 1000 ? `${f / 1000}k` : String(f));
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  const STROKE_ICONS = {
    home: '<path d="M3 9.5 10 3l7 6.5"/><path d="M5 8v8.5h3.5V12h3v4.5H15V8"/>',
    eq: '<path d="M5 3v14M10 3v14M15 3v14"/><circle cx="5" cy="12" r="1.8" fill="currentColor"/><circle cx="10" cy="6.5" r="1.8" fill="currentColor"/><circle cx="15" cy="13.5" r="1.8" fill="currentColor"/>',
    layers: '<path d="m10 3 7 3.5-7 3.5-7-3.5z"/><path d="m3 10 7 3.5 7-3.5"/><path d="m3 13.5 7 3.5 7-3.5"/>',
  };
  document.querySelectorAll('[data-cyl-icon]').forEach((e) => {
    e.innerHTML = `<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${STROKE_ICONS[e.dataset.cylIcon] || ''}</svg>`;
  });

  // ---------- toast + modal ----------

  const toastHost = el('div', 'cyl-toasts');
  document.body.appendChild(toastHost);
  function toast(msg, tone = 'info') {
    const t = el('div', `cyl-toast cyl-toast-${tone}`, msg);
    toastHost.appendChild(t);
    setTimeout(() => t.remove(), tone === 'error' ? 6000 : 3200);
  }
  async function guarded(fn, okMsg) {
    try {
      const r = await fn();
      if (okMsg) toast(okMsg, 'ok');
      return r;
    } catch (e) {
      toast(String(e && e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error');
      return undefined;
    }
  }

  // A small in-window dialog (Electron has no window.prompt). Resolves to the text, true, or null.
  function modal({ title, text, input, okLabel = 'OK', danger = false }) {
    return new Promise((resolve) => {
      const scrim = el('div', 'cyl-modal-scrim');
      const box = el('div', 'cyl-modal');
      box.setAttribute('role', 'dialog');
      box.appendChild(el('h3', null, title));
      if (text) box.appendChild(el('p', 'cyl-muted', text));
      let field = null;
      if (input !== undefined) {
        field = el('input', 'text-input cyl-text');
        field.value = input || '';
        field.maxLength = 48;
        field.setAttribute('data-no-translate', '');
        box.appendChild(field);
      }
      const row = el('div', 'cyl-modal-actions');
      const close = (v) => { scrim.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
      const ok = () => close(field ? (field.value.trim() || null) : true);
      const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } if (e.key === 'Enter') { e.preventDefault(); ok(); } };
      row.append(button('Cancelar', 'btn btn-ghost', () => close(null)), button(okLabel, danger ? 'btn btn-danger' : 'btn btn-primary', ok));
      box.appendChild(row);
      scrim.appendChild(box);
      document.body.appendChild(scrim);
      document.addEventListener('keydown', onKey, true);
      (field || row.lastChild).focus();
      if (field) field.select();
    });
  }

  // ---------- data ----------

  const audio = () => snap && snap.audio;
  const active = () => audio() && audio().profiles[audio().activeProfile];
  const devicesOf = (flow) => (snap && snap.status ? snap.status.devices.filter((d) => d.flow === flow) : []);

  async function load(force = false) {
    const wantHid = view === 'dashboard' || view === 'overview';
    const next = await guarded(() => api.snapshot({ force, hid: wantHid }));
    if (!next) return;
    snap = next;
    if (view === 'equalizer' || view === 'mic' || view === 'overview') await loadApo();
    render();
  }

  async function loadApo(force = false) {
    if (!force && apo && Date.now() - apoAt < 30000) return apo;
    apo = await guarded(() => api.apoStatus());
    apoAt = Date.now();
    return apo;
  }

  function render() {
    if (!snap) return;
    if (view === 'overview') renderOverview();
    if (view === 'dashboard') renderDevicesAudio();
    if (view === 'equalizer') renderEq();
    if (view === 'mic') renderMic();
    if (view === 'profiles') renderProfiles();
  }

  // ---------- Visão geral ----------

  const MODE = { '24ghz': '2.4 GHz', bluetooth: 'Bluetooth', usb: 'USB' };
  const KIND = { real: 'Leitura real', estimate: 'Estimativa' };

  function eqStatusText() {
    const a = audio();
    const t = snap.targets;
    if (apo && apo.installed === false) return 'Equalizer APO não instalado: a curva não está sendo aplicada. Veja a página Equalizador.';
    if (snap.eq && snap.eq.error) return `Erro ao aplicar: ${snap.eq.error}`;
    if (!a.eqEnabled) return 'Desligado: o áudio passa sem alteração.';
    if (apo && apo.installed && apo.onRender === false) return 'O Equalizer APO não está instalado nesta saída. Abra o Configurator na página Equalizador.';
    return `Aplicando “${active().name}” em ${t.render ? t.render.name : 'todas as saídas'}.`;
  }

  let volDragging = false;
  function renderOverview() {
    const h = snap.headset;
    const conn = $('ov-conn');
    conn.textContent = h.connected ? 'Conectado' : (h.dongle === false ? 'Receptor 2.4 GHz não encontrado' : 'Não detectado');
    conn.className = `cyl-chip ${h.connected ? 'ok' : 'off'}`;
    const mode = MODE[h.mode];
    $('ov-mode').hidden = !mode || !h.connected;
    $('ov-mode').textContent = mode || '';
    $('ov-battery').textContent = h.battery.label;
    $('ov-battery-kind').textContent = KIND[h.battery.kind] || '';
    $('ov-battery-kind').hidden = !KIND[h.battery.kind];
    $('ov-battery-detail').textContent = h.battery.detail;

    const a = audio();
    const chips = $('ov-profiles');
    chips.textContent = '';
    for (const id of a.order) {
      const b = button(a.profiles[id].name, `cyl-pchip${id === a.activeProfile ? ' active' : ''}`, () => guarded(() => api.activateProfile(id)));
      b.setAttribute('data-no-translate', '');
      chips.appendChild(b);
    }
    $('ov-auto').textContent = a.autoSwitch.enabled ? 'Troca automática ligada' : '';
    $('ov-eq').classList.toggle('on', a.eqEnabled);
    $('ov-eq-status').textContent = eqStatusText();

    const cap = snap.targets.capture;
    const mic = $('ov-mic');
    mic.disabled = !cap;
    mic.textContent = !cap ? 'Sem microfone' : cap.mute ? 'Ativar microfone' : 'Silenciar';
    mic.classList.toggle('cyl-muted-btn', !!(cap && cap.mute));
    $('ov-mic-name').textContent = cap ? `${cap.name}${cap.mute ? ' — silenciado' : ''}` : '';

    const out = snap.targets.render;
    const vol = $('ov-vol');
    vol.disabled = !out;
    if (out && !volDragging) { vol.value = Math.round(out.volume); $('ov-vol-value').textContent = `${Math.round(out.volume)}%`; }
    $('ov-out-name').textContent = out ? out.name : (snap.statusError || 'Nenhuma saída de áudio');
    renderBatteries();
  }

  async function renderBatteries() {
    const saved = await window.batteryHub.listSavedDevices();
    const host = $('ov-batteries');
    host.textContent = '';
    const list = Object.values(saved).filter((d) => !d.hidden);
    if (!list.length) { host.appendChild(el('p', 'cyl-muted', 'Nenhum dispositivo com bateria monitorado. Adicione em Dispositivos.')); return; }
    for (const d of list) {
      const row = el('div', 'cyl-mini-row');
      const name = el('span', null, d.customName || d.product || 'Dispositivo');
      name.setAttribute('data-no-translate', '');
      const r = d.lastReading;
      const value = d.online === false || !r ? 'sem leitura' : `${r.capacity}%${r.charging ? ' · carregando' : ''}`;
      row.append(name, el('strong', null, value));
      host.appendChild(row);
    }
  }

  $('ov-eq').addEventListener('click', () => guarded(() => api.setEqEnabled(!audio().eqEnabled)));
  $('ov-mic').addEventListener('click', () => guarded(() => api.toggleMic()));
  $('ov-devices').addEventListener('click', () => window.switchView('dashboard'));
  const sendVolume = debounce((id, v) => guarded(() => api.setVolume(id, v)), 120);
  $('ov-vol').addEventListener('input', (e) => {
    volDragging = true;
    $('ov-vol-value').textContent = `${e.target.value}%`;
    const out = snap && snap.targets.render;
    if (out) sendVolume(out.id, Number(e.target.value));
  });
  $('ov-vol').addEventListener('change', () => { setTimeout(() => { volDragging = false; }, 400); });

  // ---------- Dispositivos: audio panel ----------

  function renderDevicesAudio() {
    const h = snap.headset;
    const parts = [];
    parts.push(h.dongle === true ? 'Receptor 2.4 GHz (USB 040B:0897) conectado' : h.dongle === false ? 'Receptor 2.4 GHz (USB 040B:0897) não encontrado' : 'Receptor: verificando');
    parts.push(h.connected ? 'saída e microfone disponíveis no Windows' : 'sem dispositivo de áudio no Windows');
    parts.push(`bateria: ${h.battery.label.toLowerCase()}`);
    $('dev-h510').textContent = parts.join(' · ');
    const chip = $('dev-h510-chip');
    chip.textContent = h.connected ? 'Conectado' : 'Desconectado';
    chip.className = `cyl-chip ${h.connected ? 'ok' : 'off'}`;

    const host = $('dev-endpoints');
    host.textContent = '';
    const st = snap.status;
    if (!st) { host.appendChild(el('p', 'cyl-muted cyl-pad', snap.statusError || 'Motor de áudio indisponível.')); return; }
    for (const d of st.devices) {
      const row = el('div', 'settings-row');
      const label = el('div', 'settings-label');
      const t = el('span', 'settings-title', d.name);
      t.setAttribute('data-no-translate', '');
      const isDef = (d.flow === 'render' ? st.defaultRender : st.defaultCapture);
      const def = isDef && isDef.id === d.id;
      label.append(t, el('span', 'settings-hint', `${d.flow === 'render' ? 'Saída' : 'Entrada'} · volume ${Math.round(d.volume)}%${d.mute ? ' · silenciado' : ''}${def ? ' · padrão do Windows' : ''}`));
      row.appendChild(label);
      if (!def) row.appendChild(button('Definir como padrão', 'btn btn-ghost', () => guarded(() => api.setDefault(d.id, 'all'), 'Dispositivo padrão alterado.').then(() => load(true))));
      else row.appendChild(el('span', 'cyl-chip ok', 'Padrão'));
      host.appendChild(row);
    }
  }
  $('add-device-btn').addEventListener('click', () => window.switchView('discover'));

  // ---------- Equalizador ----------

  const bandInputs = [];
  (function buildBands() {
    const host = $('eq-bands');
    BANDS.forEach((f, i) => {
      const col = el('div', 'cyl-band');
      const out = el('output', null, '0');
      const input = el('input', 'cyl-vrange');
      Object.assign(input, { type: 'range', min: -12, max: 12, step: 0.5 });
      input.setAttribute('aria-label', `${f} Hz`);
      const lab = el('label', null, fmtHz(f));
      col.append(out, input, lab);
      host.appendChild(col);
      bandInputs.push({ input, out });
      input.addEventListener('input', () => { out.textContent = fmtDb(input.value); eqEdited(); });
      input.addEventListener('dblclick', () => { input.value = 0; out.textContent = '0'; eqEdited(); });
    });
  })();

  function eqValues() {
    return { bands: bandInputs.map((b) => Number(b.input.value)), preamp: Number($('eq-preamp').value) };
  }
  function drawCurve(bands) {
    const pts = bands.map((g, i) => `${(i / (bands.length - 1)) * 100},${20 - (g / 12) * 18}`).join(' ');
    $('eq-curve-line').setAttribute('points', pts);
  }
  function showClip({ bands, preamp }) {
    $('eq-clip').hidden = !(preamp + Math.max(0, ...bands) > 0.05);
  }
  const saveEq = debounce(async (id) => {
    $('eq-save-state').textContent = 'Salvando…';
    const r = await guarded(() => api.saveProfile(id, eqValues()));
    $('eq-save-state').textContent = r ? 'Salvo e aplicado.' : 'Não foi possível salvar.';
  }, 250);
  function eqEdited() {
    const v = eqValues();
    $('eq-preamp-value').textContent = fmtDb(v.preamp);
    drawCurve(v.bands);
    showClip(v);
    eqDirty = true;
    saveEq(audio().activeProfile);
  }
  let eqDirty = false;
  let eqShownId = null;
  $('eq-preamp').addEventListener('input', eqEdited);

  function renderEq() {
    const a = audio();
    const p = active();
    const sel = $('eq-profile');
    sel.textContent = '';
    for (const id of a.order) { const o = el('option', null, a.profiles[id].name); o.value = id; sel.appendChild(o); }
    sel.value = a.activeProfile;
    $('eq-enabled').classList.toggle('on', a.eqEnabled);
    // Don't pull the sliders from under the user while they are dragging.
    if (!eqDirty || eqShownId !== p.id) {
      p.bands.forEach((g, i) => { bandInputs[i].input.value = g; bandInputs[i].out.textContent = fmtDb(g); });
      $('eq-preamp').value = p.preamp;
      $('eq-preamp-value').textContent = fmtDb(p.preamp);
      drawCurve(p.bands);
      showClip(p);
      eqShownId = p.id;
    }
    eqDirty = false;
    $('eq-delete').disabled = p.id === 'padrao';
    $('eq-note').textContent = p.note ? `${p.note} Os valores iniciais são pontos de partida, não uma medição do H510-PRO.` : '';
    document.querySelector('.cyl-eq-card').classList.toggle('cyl-dim', !a.eqEnabled);

    const tsel = $('eq-target');
    tsel.textContent = '';
    const auto = el('option', null, `Automático${snap.targets.render ? ` (${snap.targets.render.name})` : ''}`);
    auto.value = '';
    tsel.appendChild(auto);
    for (const d of devicesOf('render')) { const o = el('option', null, d.name); o.value = d.id; tsel.appendChild(o); }
    tsel.value = a.targetRender || '';
    renderApo();
  }

  function renderApo() {
    const banner = $('apo-banner');
    const panel = $('apo-panel');
    panel.textContent = '';
    if (!apo) { banner.hidden = true; return; }
    const row = (title, hint, ...controls) => {
      const r = el('div', 'settings-row');
      const l = el('div', 'settings-label');
      l.append(el('span', 'settings-title', title), el('span', 'settings-hint', hint));
      r.append(l, ...controls);
      panel.appendChild(r);
      return r;
    };
    if (!apo.installed) {
      banner.hidden = false;
      banner.className = 'cyl-banner warn';
      banner.textContent = 'Equalizer APO não está instalado: o equalizador não está processando o áudio. Os perfis ficam salvos e passam a valer assim que ele for instalado.';
      row('1. Baixe e instale o Equalizer APO', 'Gratuito e de código aberto (GPL). É uma dependência do CYL Audio Hub: roda dentro do áudio do Windows e não tem janela para ficar aberta.',
        button('Abrir página oficial', 'btn btn-primary', () => window.batteryHub.openExternal('https://sourceforge.net/projects/equalizerapo/')));
      row('2. No Configurator do instalador', 'Em "Playback devices" marque "Fones de ouvido (H510-PRO Wireless headset)". Para os filtros do microfone, marque também "Microfone (H510-PRO…)" em "Capture devices". Não marque outros aprimoramentos.');
      row('3. Reinicie o Windows', 'O APO só passa a processar o áudio depois de reiniciar.');
      row('4. Volte aqui', 'O CYL detecta o APO e aplica o perfil ativo sozinho. Não é preciso usar o Editor do APO.',
        button('Verificar novamente', 'btn btn-ghost', async () => { await loadApo(true); await guarded(() => api.apoApply()); load(true); }));
      return;
    }
    banner.hidden = !(apo.onRender === false || apo.otherLines.length);
    banner.className = 'cyl-banner warn';
    banner.textContent = apo.onRender === false
      ? 'O Equalizer APO está instalado, mas não na saída equalizada. Abra o Configurator e marque o dispositivo.'
      : apo.otherLines.length ? 'O config.txt do APO tem outras linhas ativas, que somam efeito à curva do CYL.' : '';
    const yesNo = (v) => (v === true ? 'sim' : v === false ? 'não' : 'não confirmado');
    row('Integração', apo.included ? `Ativa: config.txt inclui cyl-audio-hub.txt (${apo.configDir}).` : 'Ainda não aplicada.',
      button('Aplicar agora', 'btn btn-ghost', () => guarded(() => api.apoApply(), 'Configuração aplicada.').then(() => loadApo(true)).then(render)));
    row('APO na saída', `Instalado no dispositivo equalizado: ${yesNo(apo.onRender)}. No microfone: ${yesNo(apo.onCapture)}.`,
      ...(apo.configurator ? [button('Abrir Configurator', 'btn btn-ghost', () => guarded(() => api.apoConfigurator()))] : []));
    if (apo.otherLines.length) {
      const r = row('Outras linhas no config.txt', apo.otherLines.join('  ·  '),
        button('Usar só o CYL', 'btn btn-ghost', async () => {
          if (!await modal({ title: 'Usar só o CYL?', text: 'As outras linhas ativas do config.txt serão comentadas (com backup e marcadas), para não somar com a curva do CYL. "Remover integração" as restaura.', okLabel: 'Comentar linhas' })) return;
          await guarded(() => api.apoExclusive(), 'Outras linhas desativadas (backup feito).');
          await loadApo(true); render();
        }));
      r.querySelector('.settings-hint').setAttribute('data-no-translate', '');
    }
    row('Remover integração', 'Tira o Include do config.txt, restaura linhas que o CYL comentou e apaga cyl-audio-hub.txt. Um backup é feito antes.',
      button('Remover', 'btn btn-danger', async () => {
        if (!await modal({ title: 'Remover a integração com o APO?', text: 'O equalizador do CYL deixa de ser aplicado até você clicar em "Aplicar agora".', okLabel: 'Remover', danger: true })) return;
        await guarded(() => api.apoRemove(), 'Integração removida.');
        await loadApo(true); render();
      }));
  }

  $('eq-profile').addEventListener('change', (e) => guarded(() => api.activateProfile(e.target.value)));
  $('eq-enabled').addEventListener('click', () => guarded(() => api.setEqEnabled(!audio().eqEnabled)));
  $('eq-target').addEventListener('change', (e) => guarded(() => api.setTargets({ targetRender: e.target.value || null }), 'Saída equalizada alterada.'));
  $('eq-autopreamp').addEventListener('click', () => {
    const peak = Math.max(0, ...eqValues().bands);
    $('eq-preamp').value = peak === 0 ? 0 : -Math.ceil(peak * 2) / 2;
    eqEdited();
  });
  $('eq-reset').addEventListener('click', async () => {
    const p = active();
    if (!await modal({ title: `Restaurar “${p.name}”?`, text: p.builtin ? 'Volta aos valores iniciais deste perfil.' : 'Zera todas as bandas e o preamp.', okLabel: 'Restaurar' })) return;
    eqShownId = null;
    guarded(() => api.resetProfile(p.id), 'Perfil restaurado.');
  });
  async function duplicate(fromId) {
    const src = audio().profiles[fromId];
    const name = await modal({ title: 'Salvar como novo perfil', text: `Cópia de “${src.name}”.`, input: `${src.name} (cópia)`, okLabel: 'Criar' });
    if (!name) return;
    const p = await guarded(() => api.createProfile(fromId, name));
    if (p) await guarded(() => api.activateProfile(p.id), `Perfil “${p.name}” criado.`);
  }
  async function rename(id) {
    const name = await modal({ title: 'Renomear perfil', input: audio().profiles[id].name, okLabel: 'Renomear' });
    if (name) guarded(() => api.saveProfile(id, { name }), 'Perfil renomeado.');
  }
  async function remove(id) {
    const p = audio().profiles[id];
    if (!await modal({ title: `Excluir “${p.name}”?`, text: 'Binds e regras ligados a este perfil também são removidos.', okLabel: 'Excluir', danger: true })) return;
    guarded(() => api.deleteProfile(id), 'Perfil excluído.');
  }
  async function doExport(ids) {
    const r = await guarded(() => api.exportProfiles(ids));
    if (r && !r.canceled) toast(`${r.count} perfil(is) exportado(s).`, 'ok');
  }
  async function doImport() {
    const r = await guarded(() => api.importProfiles());
    if (r && !r.canceled) toast(`Importado(s): ${r.added.join(', ')}`, 'ok');
  }
  $('eq-duplicate').addEventListener('click', () => duplicate(audio().activeProfile));
  $('eq-rename').addEventListener('click', () => rename(audio().activeProfile));
  $('eq-delete').addEventListener('click', () => remove(audio().activeProfile));
  $('eq-export').addEventListener('click', () => doExport([audio().activeProfile]));
  $('eq-import').addEventListener('click', doImport);

  // ---------- Microfone ----------

  let micDragging = false;
  function renderMic() {
    const st = snap.status;
    const cap = snap.targets.capture;
    const sel = $('mic-device');
    sel.textContent = '';
    const auto = el('option', null, `Automático${cap ? ` (${cap.name})` : ''}`);
    auto.value = '';
    sel.appendChild(auto);
    for (const d of devicesOf('capture')) { const o = el('option', null, d.name); o.value = d.id; sel.appendChild(o); }
    sel.value = audio().targetCapture || '';
    $('mic-conn').textContent = cap ? `Conectado${MODE[cap.mode] ? ` · ${MODE[cap.mode]}` : ''}${cap.mute ? ' · silenciado' : ''}` : (snap.statusError || 'Nenhum microfone encontrado.');
    const isDef = cap && st && st.defaultCapture && st.defaultCapture.id === cap.id;
    const isComm = cap && st && st.defaultCommCapture && st.defaultCommCapture.id === cap.id;
    $('mic-default-hint').textContent = !cap ? '—' : `Padrão: ${isDef ? 'sim' : 'não'} · Padrão de comunicação (Discord, chamadas): ${isComm ? 'sim' : 'não'}`;
    $('mic-default-all').disabled = !cap || isDef;
    $('mic-default-comm').disabled = !cap || isComm;
    const vol = $('mic-volume');
    vol.disabled = !cap;
    if (cap && !micDragging) { vol.value = Math.round(cap.volume); $('mic-volume-value').textContent = `${Math.round(cap.volume)}%`; }
    const mute = $('mic-mute');
    mute.disabled = !cap;
    mute.textContent = !cap ? 'Sem microfone' : cap.mute ? 'Ativar microfone' : 'Silenciar microfone';
    mute.className = cap && cap.mute ? 'btn btn-danger' : 'btn btn-ghost';

    const p = active();
    const mic = p.mic || { filters: false, highpassHz: 80, presenceDb: 0, gainDb: 0 };
    $('mic-profile-name').textContent = p.name;
    $('mic-filters').classList.toggle('on', !!mic.filters);
    for (const r of document.querySelectorAll('[data-mic-dep]')) r.classList.toggle('disabled', !mic.filters);
    if (document.activeElement !== $('mic-hp')) $('mic-hp').value = mic.highpassHz;
    if (document.activeElement !== $('mic-presence')) $('mic-presence').value = mic.presenceDb;
    if (document.activeElement !== $('mic-gain')) $('mic-gain').value = mic.gainDb;
    let hint = 'Processados pelo Equalizer APO no microfone: valem para Discord e jogos.';
    if (apo && !apo.installed) hint = 'Precisa do Equalizer APO instalado no microfone (veja Equalizador). Sem ele, os filtros ficam só salvos.';
    else if (apo && apo.onCapture === false) hint = 'O Equalizer APO não está instalado neste microfone: marque-o no Configurator.';
    else if (!audio().eqEnabled) hint = 'Com a equalização desligada, os filtros do microfone também ficam desligados.';
    $('mic-filters-hint').textContent = hint;
  }

  function saveMic(patch) {
    const p = active();
    const mic = { ...(p.mic || { filters: false, highpassHz: 80, presenceDb: 0, gainDb: 0 }), ...patch };
    return guarded(() => api.saveProfile(p.id, { mic }));
  }
  $('mic-filters').addEventListener('click', () => saveMic({ filters: !(active().mic && active().mic.filters) }));
  for (const [id, key] of [['mic-hp', 'highpassHz'], ['mic-presence', 'presenceDb'], ['mic-gain', 'gainDb']]) {
    $(id).addEventListener('change', (e) => saveMic({ [key]: Number(e.target.value) }));
  }
  $('mic-device').addEventListener('change', (e) => { stopTest(); guarded(() => api.setTargets({ targetCapture: e.target.value || null }), 'Microfone alterado.'); });
  $('mic-default-all').addEventListener('click', () => guarded(() => api.setDefault(snap.targets.capture.id, 'all'), 'Definido como padrão.').then(() => load(true)));
  $('mic-default-comm').addEventListener('click', () => guarded(() => api.setDefault(snap.targets.capture.id, 'comm'), 'Definido como padrão de comunicação.').then(() => load(true)));
  $('mic-mute').addEventListener('click', () => guarded(() => api.toggleMic()).then(() => load(true)));
  const sendMicVolume = debounce((id, v) => guarded(() => api.setVolume(id, v)), 120);
  $('mic-volume').addEventListener('input', (e) => {
    micDragging = true;
    $('mic-volume-value').textContent = `${e.target.value}%`;
    if (snap.targets.capture) sendMicVolume(snap.targets.capture.id, Number(e.target.value));
  });
  $('mic-volume').addEventListener('change', () => { setTimeout(() => { micDragging = false; }, 400); });

  // Mic test: Chromium opens the same Windows endpoint (matched by name), so the meter shows what
  // Discord would receive from it, before the APO filters. Raw: no echo cancel / AGC / denoise.
  const test = { stream: null, ctx: null, analyser: null, raf: 0, monitor: null, recorder: null, clip: null, peak: 0 };

  async function openMic() {
    const cap = snap.targets.capture;
    const raw = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    let stream = await navigator.mediaDevices.getUserMedia({ audio: raw });
    if (cap) {
      const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
      const match = inputs.find((d) => d.label === cap.name) || inputs.find((d) => d.label.includes(cap.name) || cap.name.includes(d.label));
      const current = stream.getAudioTracks()[0].getSettings().deviceId;
      if (match && match.deviceId !== current) {
        stream.getTracks().forEach((t) => t.stop());
        stream = await navigator.mediaDevices.getUserMedia({ audio: { ...raw, deviceId: { exact: match.deviceId } } });
      }
      if (!match) toast('Não achei este microfone no navegador interno; o teste usa o microfone padrão.', 'info');
    }
    return stream;
  }

  async function startTest() {
    if (test.stream) { stopTest(); return; }
    try {
      test.stream = await openMic();
    } catch (e) {
      toast(`Não foi possível abrir o microfone: ${e.message}`, 'error');
      return;
    }
    test.ctx = new AudioContext();
    const src = test.ctx.createMediaStreamSource(test.stream);
    test.analyser = test.ctx.createAnalyser();
    test.analyser.fftSize = 1024;
    src.connect(test.analyser);
    test.src = src;
    if ($('mic-monitor').classList.contains('on')) setMonitor(true);
    const buf = new Float32Array(test.analyser.fftSize);
    const meter = $('mic-meter');
    const peakEl = $('mic-meter-peak');
    const loop = () => {
      test.analyser.getFloatTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
      const db = peak > 0 ? 20 * Math.log10(peak) : -100;
      const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
      meter.style.width = `${pct}%`;
      meter.classList.toggle('hot', db > -3);
      test.peak = Math.max(pct, test.peak - 0.6);
      peakEl.style.left = `${test.peak}%`;
      test.raf = requestAnimationFrame(loop);
    };
    loop();
    $('mic-test-start').textContent = 'Parar teste';
    $('mic-record').disabled = false;
    $('mic-test-state').textContent = `Teste ativo: ${test.stream.getAudioTracks()[0].label}. Fale normalmente: a barra deve ficar no meio, sem chegar ao vermelho.`;
  }

  function setMonitor(on) {
    if (!test.ctx) return;
    if (on && !test.monitor) {
      test.monitor = test.ctx.createGain();
      test.monitor.gain.value = 0.8;
      test.src.connect(test.monitor).connect(test.ctx.destination);
    } else if (!on && test.monitor) {
      try { test.monitor.disconnect(); test.src.disconnect(test.monitor); } catch (_) {}
      test.monitor = null;
    }
  }

  function stopTest() {
    cancelAnimationFrame(test.raf);
    if (test.recorder && test.recorder.state === 'recording') test.recorder.stop();
    if (test.stream) test.stream.getTracks().forEach((t) => t.stop());
    if (test.ctx) test.ctx.close().catch(() => {});
    Object.assign(test, { stream: null, ctx: null, analyser: null, raf: 0, monitor: null, src: null, peak: 0 });
    $('mic-meter').style.width = '0%';
    $('mic-meter-peak').style.left = '0%';
    $('mic-test-start').textContent = 'Iniciar teste';
    $('mic-record').disabled = true;
    $('mic-test-state').textContent = 'O microfone só é aberto enquanto o teste estiver ativo nesta página.';
  }

  $('mic-test-start').addEventListener('click', startTest);
  $('mic-monitor').addEventListener('click', () => {
    const on = !$('mic-monitor').classList.contains('on');
    $('mic-monitor').classList.toggle('on', on);
    setMonitor(on);
  });
  $('mic-record').addEventListener('click', () => {
    if (!test.stream) return;
    const chunks = [];
    const rec = new MediaRecorder(test.stream);
    test.recorder = rec;
    rec.ondataavailable = (e) => chunks.push(e.data);
    rec.onstop = () => {
      if (test.clip) URL.revokeObjectURL(test.clip);
      test.clip = URL.createObjectURL(new Blob(chunks, { type: rec.mimeType }));
      $('mic-play').disabled = false;
      $('mic-record').textContent = 'Gravar 5 s';
      $('mic-record').disabled = !test.stream;
    };
    rec.start();
    $('mic-record').disabled = true;
    $('mic-record').textContent = 'Gravando…';
    setTimeout(() => { if (rec.state === 'recording') rec.stop(); }, 5000);
  });
  $('mic-play').addEventListener('click', () => { if (test.clip) new Audio(test.clip).play().catch((e) => toast(e.message, 'error')); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopTest(); });

  // ---------- Perfis ----------

  function miniCurve(bands) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 100 24');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('class', 'cyl-mini-curve');
    const line = document.createElementNS(ns, 'polyline');
    line.setAttribute('points', bands.map((g, i) => `${(i / 9) * 100},${12 - (g / 12) * 11}`).join(' '));
    svg.appendChild(line);
    return svg;
  }

  function renderProfiles() {
    const a = audio();
    const host = $('pf-list');
    host.textContent = '';
    a.order.forEach((id, idx) => {
      const p = a.profiles[id];
      const item = el('div', `list-item cyl-profile${id === a.activeProfile ? ' active' : ''}`);
      const info = el('div', 'list-item-info');
      const title = el('div', 'list-item-title');
      const name = el('span', null, p.name);
      name.setAttribute('data-no-translate', '');
      title.appendChild(name);
      if (id === a.activeProfile) title.appendChild(el('span', 'badge', 'Ativo'));
      const rules = a.autoSwitch.rules.filter((r) => r.profile === id).map((r) => r.exe);
      const sub = [`Preamp ${fmtDb(p.preamp)} dB`, p.mic && p.mic.filters ? 'filtros de microfone' : null, rules.length ? `automático: ${rules.join(', ')}` : null].filter(Boolean).join(' · ');
      info.append(title, el('div', 'list-item-sub', sub));
      const actions = el('div', 'cyl-inline');
      if (id !== a.activeProfile) actions.appendChild(button('Ativar', 'btn btn-primary cyl-sm', () => guarded(() => api.activateProfile(id))));
      actions.append(
        button('Editar EQ', 'btn btn-ghost cyl-sm', async () => { await guarded(() => api.activateProfile(id)); window.switchView('equalizer'); }),
        button('Renomear', 'btn btn-ghost cyl-sm', () => rename(id)),
        button('Duplicar', 'btn btn-ghost cyl-sm', () => duplicate(id)),
      );
      if (p.builtin) actions.appendChild(button('Restaurar', 'btn btn-ghost cyl-sm', () => guarded(() => api.resetProfile(id), 'Perfil restaurado.')));
      if (id !== 'padrao') actions.appendChild(button('Excluir', 'btn btn-ghost cyl-sm', () => remove(id)));
      const move = (d) => { const o = [...a.order]; const j = idx + d; [o[idx], o[j]] = [o[j], o[idx]]; guarded(() => api.orderProfiles(o)); };
      const up = button('↑', 'btn btn-ghost cyl-sm', () => move(-1)); up.disabled = idx === 0; up.title = 'Mover para cima';
      const down = button('↓', 'btn btn-ghost cyl-sm', () => move(1)); down.disabled = idx === a.order.length - 1; down.title = 'Mover para baixo';
      actions.append(up, down);
      item.append(miniCurve(p.bands), info, actions);
      host.appendChild(item);
    });

    $('as-enabled').classList.toggle('on', a.autoSwitch.enabled);
    if (document.activeElement !== $('as-interval')) $('as-interval').value = a.autoSwitch.intervalSec;
    $('as-notify').classList.toggle('on', a.notifyProfileSwitch);
    const psel = $('as-profile');
    const keep = psel.value;
    psel.textContent = '';
    for (const id of a.order) { const o = el('option', null, a.profiles[id].name); o.value = id; psel.appendChild(o); }
    psel.value = a.profiles[keep] ? keep : (a.profiles.valorant ? 'valorant' : a.order[0]);

    const rules = $('as-rules');
    rules.textContent = '';
    a.autoSwitch.rules.forEach((r, i) => {
      const row = el('div', 'settings-row cyl-rule');
      const label = el('div', 'settings-label');
      const t = el('span', 'settings-title', `${i + 1}. ${r.exe}`);
      t.setAttribute('data-no-translate', '');
      label.append(t, el('span', 'settings-hint', i === 0 ? 'Maior prioridade' : 'Prioridade menor que a de cima'));
      const sel = el('select', 'select');
      sel.setAttribute('data-no-translate', '');
      for (const id of a.order) { const o = el('option', null, a.profiles[id].name); o.value = id; sel.appendChild(o); }
      sel.value = r.profile;
      const setRules = (list) => guarded(() => api.audioSettings({ autoSwitch: { rules: list } }));
      sel.addEventListener('change', () => setRules(a.autoSwitch.rules.map((x, j) => (j === i ? { ...x, profile: sel.value } : x))));
      const swap = (d) => { const l = [...a.autoSwitch.rules]; [l[i], l[i + d]] = [l[i + d], l[i]]; setRules(l); };
      const up = button('↑', 'btn btn-ghost btn-icon', () => swap(-1)); up.disabled = i === 0;
      const down = button('↓', 'btn btn-ghost btn-icon', () => swap(1)); down.disabled = i === a.autoSwitch.rules.length - 1;
      const del = button('Remover', 'btn btn-ghost', () => setRules(a.autoSwitch.rules.filter((_, j) => j !== i)));
      const ctl = el('div', 'cyl-inline');
      ctl.append(sel, up, down, del);
      row.append(label, ctl);
      rules.appendChild(row);
    });
    if (!a.autoSwitch.rules.length) rules.appendChild(el('p', 'cyl-muted cyl-pad', 'Nenhuma regra.'));
  }

  $('pf-import').addEventListener('click', doImport);
  $('pf-export').addEventListener('click', () => doExport(null));
  $('as-enabled').addEventListener('click', () => guarded(() => api.audioSettings({ autoSwitch: { enabled: !audio().autoSwitch.enabled } })));
  $('as-notify').addEventListener('click', () => guarded(() => api.audioSettings({ notifyProfileSwitch: !audio().notifyProfileSwitch })));
  $('as-interval').addEventListener('change', (e) => guarded(() => api.audioSettings({ autoSwitch: { intervalSec: Number(e.target.value) } })));
  let procsLoaded = false;
  $('as-exe').addEventListener('focus', async () => {
    if (procsLoaded) return;
    procsLoaded = true;
    const list = await guarded(() => api.processes());
    const dl = $('as-procs');
    for (const n of list || []) { const o = el('option'); o.value = n; dl.appendChild(o); }
  });
  $('as-add').addEventListener('click', () => {
    const exe = $('as-exe').value.trim().toLowerCase().replace(/\.exe$/, '');
    if (!exe) { toast('Digite o nome do programa.', 'error'); return; }
    if (audio().autoSwitch.rules.some((r) => r.exe === exe)) { toast('Já existe uma regra para este programa.', 'error'); return; }
    const rules = [...audio().autoSwitch.rules, { exe, profile: $('as-profile').value }];
    guarded(() => api.audioSettings({ autoSwitch: { rules } })).then((a) => {
      if (a && !a.autoSwitch.rules.some((r) => r.exe === exe)) toast('Nome de programa inválido.', 'error');
      else $('as-exe').value = '';
    });
  });

  // ---------- Binds ----------

  const DEFAULT_ACCEL = { b1: 'Control+Alt+1', b2: 'Control+Alt+2', b3: 'Control+Alt+3', b4: 'Control+Alt+E', b5: 'Control+Alt+M', b6: 'Control+Alt+B', b7: 'Control+Alt+H' };
  const CODE_KEYS = {
    Space: 'Space', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert', Enter: 'Return', NumpadEnter: 'Return',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec',
    Minus: '-', Equal: '=', Comma: ',', Period: '.', Semicolon: ';', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Backquote: '`', Quote: "'",
    AudioVolumeUp: 'VolumeUp', AudioVolumeDown: 'VolumeDown', AudioVolumeMute: 'VolumeMute',
    MediaPlayPause: 'MediaPlayPause', MediaTrackNext: 'MediaNextTrack', MediaTrackPrevious: 'MediaPreviousTrack', MediaStop: 'MediaStop',
  };
  function keyFromCode(code) {
    let m;
    if ((m = /^Key([A-Z])$/.exec(code))) return m[1];
    if ((m = /^Digit([0-9])$/.exec(code))) return m[1];
    if ((m = /^Numpad([0-9])$/.exec(code))) return `num${m[1]}`;
    if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
    return CODE_KEYS[code] || null;
  }

  let recording = null; // { id, button, onKey }
  function stopRecording(cancelled) {
    if (!recording) return;
    document.removeEventListener('keydown', recording.onKey, true);
    window.removeEventListener('blur', recording.onBlur);
    recording = null;
    api.suspendBinds(false).then((v) => { bindsView = v; renderBinds(); });
    if (cancelled) toast('Gravação cancelada.');
  }
  function record(bind, btn) {
    if (recording) stopRecording(true);
    btn.textContent = 'Pressione a combinação… (Esc cancela)';
    btn.classList.add('cyl-recording');
    const onKey = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey) { stopRecording(true); return; }
      if (['Control', 'Alt', 'Shift', 'Meta', 'AltGraph'].includes(e.key)) return; // wait for the key itself
      const key = keyFromCode(e.code);
      if (!key) { toast('Esta tecla não pode ser usada em um atalho.', 'error'); return; }
      const accel = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super', key].filter(Boolean).join('+');
      const res = await api.checkBind(accel);
      if (res.error) { toast(res.error, 'error'); return; }
      const binds = bindsView.binds.map((b) => (b.id === bind.id ? { ...b, accelerator: res.canon, enabled: true } : b));
      bindsView = await guarded(() => api.setBinds(binds)) || bindsView;
      stopRecording(false);
      if (res.warning) toast(res.warning, 'info');
    };
    const onBlur = () => stopRecording(true);
    recording = { id: bind.id, onKey, onBlur };
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    api.suspendBinds(true);
  }

  async function loadBinds() {
    bindsView = await guarded(() => api.binds());
    renderBinds();
  }

  function renderBinds() {
    if (!bindsView || recording) return;
    const host = $('bd-list');
    host.textContent = '';
    const head = el('div', 'cyl-bind cyl-bind-head');
    ['Categoria', 'Ação', 'Combinação', 'Estado', 'Redefinir · Remover'].forEach((t) => head.appendChild(el('span', null, t)));
    host.appendChild(head);
    const actions = bindsView.actions;
    const save = (list) => guarded(() => api.setBinds(list)).then((v) => { if (v) { bindsView = v; renderBinds(); } });
    for (const b of bindsView.binds) {
      const st = bindsView.status[b.id] || {};
      const action = actions.find((a) => a.id === b.action);
      const row = el('div', 'cyl-bind');
      row.appendChild(el('span', 'cyl-muted', action ? action.category : '—'));
      const sel = el('select', 'select');
      sel.setAttribute('data-no-translate', '');
      for (const a of actions) { const o = el('option', null, a.label); o.value = a.id; sel.appendChild(o); }
      sel.value = b.action;
      sel.addEventListener('change', () => save(bindsView.binds.map((x) => (x.id === b.id ? { ...x, action: sel.value } : x))));
      row.appendChild(sel);
      const combo = button(b.display || 'Definir', 'btn btn-ghost cyl-combo', () => record(b, combo));
      combo.setAttribute('data-no-translate', '');
      row.appendChild(combo);

      const stateCell = el('div', 'cyl-bind-state');
      const tg = el('button', `toggle${b.enabled ? ' on' : ''}`);
      tg.setAttribute('role', 'switch');
      tg.setAttribute('aria-label', 'Ativo');
      tg.appendChild(el('span', 'toggle-knob'));
      tg.addEventListener('click', () => save(bindsView.binds.map((x) => (x.id === b.id ? { ...x, enabled: !x.enabled } : x))));
      let label; let tone;
      if (!b.enabled) { label = 'Inativo'; tone = 'off'; }
      else if (st.registered) { label = st.warning ? 'Ativo · atenção' : 'Ativo'; tone = st.warning ? 'warn' : 'ok'; }
      else { label = 'Não registrado'; tone = 'err'; }
      if (bindsView.suspended) { label = 'Pausado'; tone = 'off'; }
      const chip = el('span', `cyl-chip ${tone}`, label);
      const msg = st.error || st.warning;
      if (msg && b.enabled) chip.title = msg;
      stateCell.append(tg, chip);
      row.appendChild(stateCell);

      const tools = el('div', 'cyl-inline');
      tools.append(
        button('↺', 'btn btn-ghost cyl-sm', () => save(bindsView.binds.map((x) => (x.id === b.id ? { ...x, accelerator: DEFAULT_ACCEL[b.id] || '' } : x)))),
        button('✕', 'btn btn-ghost cyl-sm', () => save(bindsView.binds.filter((x) => x.id !== b.id))),
      );
      tools.children[0].title = 'Redefinir combinação';
      tools.children[0].setAttribute('aria-label', 'Redefinir combinação');
      tools.children[1].title = 'Remover bind';
      tools.children[1].setAttribute('aria-label', 'Remover bind');
      row.appendChild(tools);
      host.appendChild(row);
      if (msg && b.enabled) {
        const note = el('div', `cyl-bind-msg ${st.error ? 'err' : 'warn'}`, msg);
        host.appendChild(note);
      }
    }
    if (!bindsView.binds.length) host.appendChild(el('p', 'cyl-muted cyl-pad', 'Nenhum bind. Clique em "Novo bind".'));
  }

  $('bd-add').addEventListener('click', async () => {
    if (!bindsView) return;
    const used = new Set(bindsView.binds.map((b) => b.id));
    let n = 1; while (used.has(`u${n}`)) n++;
    const v = await guarded(() => api.setBinds([...bindsView.binds, { id: `u${n}`, action: 'mic:toggle', accelerator: '', enabled: false }]));
    if (!v) return;
    bindsView = v;
    renderBinds();
    const rowBtn = [...document.querySelectorAll('#bd-list .cyl-combo')].pop();
    if (rowBtn) record(bindsView.binds[bindsView.binds.length - 1], rowBtn);
  });
  $('bd-reset').addEventListener('click', async () => {
    if (!await modal({ title: 'Restaurar binds padrão?', text: 'Os binds atuais são substituídos pelos exemplos (Ctrl + Alt + 1, 2, 3, E, M, B, H), todos desativados.', okLabel: 'Restaurar' })) return;
    bindsView = await guarded(() => api.resetBinds(), 'Binds restaurados.') || bindsView;
    renderBinds();
  });

  // ---------- navigation + refresh ----------

  window.cylView = (next) => {
    if (view === 'mic' && next !== 'mic') stopTest();
    if (view === 'binds' && next !== 'binds') stopRecording(false);
    view = next;
    if (next === 'binds') { loadBinds(); return; }
    if (CYL_VIEWS.includes(next)) load();
  };
  api.onChanged(() => { if (CYL_VIEWS.includes(view)) load(); if (view === 'binds') loadBinds(); });
  api.onNavigate((v) => window.switchView(v));
  setInterval(() => {
    if (document.hidden || !['overview', 'mic', 'dashboard'].includes(view)) return;
    load();
  }, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && CYL_VIEWS.includes(view)) load(true); });
  load(true);
})();
