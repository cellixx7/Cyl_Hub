// Per-device diagnostics for Dispositivos > Diagnóstico: what was detected, how it is connected,
// where its battery figure comes from (or why there is none) and when it was last read.
//
// Everything here is built from what the app already knows (saved devices, the HID list, the
// audio engine status). The report is local only — copied or saved by the user — and leaves out
// serial numbers, device paths, Bluetooth addresses and the Windows user name.
const H510 = { vendorId: 0x040b, productId: 0x0897 };
const KEYBOARD_ONLY = (d) => d.channels.every((c) => c.usagePage === 0x01 && c.usage === 0x06);
const hex4 = (n) => (n == null ? '----' : Number(n).toString(16).toUpperCase().padStart(4, '0'));
const pageName = (p, u) => {
  const names = { 0x01: 'Desktop genérico', 0x0b: 'Telefonia', 0x0c: 'Consumidor (mídia)', 0x0d: 'Digitalizador', 0x0a: 'Ordinal', 0x84: 'Energia', 0x85: 'Bateria' };
  const name = names[p] || (p >= 0xff00 || p === 0xf100 ? 'Fabricante (proprietária)' : 'Outra');
  const usage = p === 0x01 ? { 0x02: 'mouse', 0x06: 'teclado', 0x80: 'controle do sistema' }[u] : null;
  return `0x${hex4(p)}${u != null ? `/0x${Number(u).toString(16).toUpperCase()}` : ''} ${name}${usage ? ` — ${usage}` : ''}`;
};

const KIND_LABEL = { real: 'Leitura real', estimate: 'Estimativa', unavailable: 'Indisponível' };
const DRIVER_INFO = {
  beken: { kind: 'Mouse sem fio', source: 'Leitura real: o receptor Xenta/Beken transmite a carga sozinho a cada ~2 s (quadro 03 55|E5 40 estado nível). Nada é enviado ao mouse.' },
  system: { kind: 'Dispositivo Bluetooth', source: 'Leitura real informada pelo Windows (serviço de bateria Bluetooth).' },
};

function connectionOf(d) {
  if (String(d.id || '').startsWith('bt:') || d.driverId === 'system') return 'Bluetooth';
  if (/2\.4\s*g/i.test(`${d.product} ${d.manufacturer}`) || d.driverId === 'beken') return 'Receptor USB 2.4 GHz';
  return 'USB';
}

function ago(ms) {
  if (ms == null) return null;
  const m = Math.round(ms / 60000);
  if (m < 1) return 'agora há pouco';
  if (m < 60) return `há ${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `há ${h} h` : `há ${Math.round(h / 24)} dias`;
}

// A reading is "old" when it is older than three polls (or 10 min, whichever is longer).
function freshness(at, now, pollSec) {
  if (!at) return 'none';
  const limit = Math.max(3 * (pollSec || 60) * 1000, 10 * 60000);
  return now - at > limit ? 'stale' : 'fresh';
}

function savedEntry(d, live, now, pollSec) {
  const info = DRIVER_INFO[d.driverId] || { kind: 'Dispositivo HID', source: `Leitura real pelo driver “${d.driverId || 'genérico'}” do Battery Hub.` };
  const r = d.lastReading;
  const fresh = freshness(d.lastReadingAt, now, pollSec);
  const connected = d.online !== false && (!live || true);
  let state = connected ? 'Conectado' : 'Desligado, em repouso ou fora de alcance';
  if (live === false && !String(d.id).startsWith('bt:')) state = 'Receptor não encontrado (desconectado do USB)';
  let battery;
  if (r && r.capacity != null && connected && fresh === 'fresh') {
    battery = { kind: 'real', label: `${r.capacity}%`, charging: !!r.charging };
  } else if (r && r.capacity != null) {
    battery = { kind: 'unavailable', label: 'Sem leitura atual', last: `${r.capacity}%` };
  } else {
    battery = { kind: 'unavailable', label: 'Indisponível' };
  }
  let reason = null;
  if (battery.kind !== 'real') {
    if (!connected) reason = 'O dispositivo não respondeu na última consulta: costuma estar desligado, em repouso ou longe do receptor. A última leitura conhecida é mantida só como histórico.';
    else if (fresh === 'stale') reason = 'A última leitura é antiga; aguardando uma nova transmissão do dispositivo.';
    else reason = d.lastError ? `Erro na leitura: ${d.lastError}` : 'O dispositivo ainda não enviou uma leitura.';
  }
  return {
    key: d.id,
    name: d.customName || d.product || 'Dispositivo',
    product: [d.manufacturer, d.product].filter(Boolean).join(' '),
    kind: info.kind,
    connection: connectionOf(d),
    state,
    connected,
    battery,
    source: info.source,
    lastReadingAt: d.lastReadingAt || null,
    lastReadingAgo: ago(d.lastReadingAt ? now - d.lastReadingAt : null),
    history: Array.isArray(d.history) ? d.history.length : 0,
    reason,
    ids: d.vendorId != null ? `VID ${hex4(d.vendorId)} · PID ${hex4(d.productId)}` : idsFromKey(d.id),
    interfaces: live && live.channels ? live.channels.map((c) => pageName(c.usagePage, c.usage)) : [],
    monitored: true,
  };
}

function idsFromKey(id) {
  const m = /^(\d+):(\d+):/.exec(String(id || ''));
  if (m) return `VID ${hex4(+m[1])} · PID ${hex4(+m[2])}`;
  const bt = /VID&0001([0-9a-f]{4})_PID&([0-9a-f]{4})/i.exec(String(id || ''));
  return bt ? `Bluetooth VID ${bt[1].toUpperCase()} · PID ${bt[2].toUpperCase()}` : '—';
}

function h510Entry(headset, live) {
  const b = headset.battery || { kind: 'unavailable', label: 'Indisponível' };
  return {
    key: 'h510',
    name: 'Redragon Zeus Pro H510-PRO',
    product: live ? [live.manufacturer, live.product].filter(Boolean).join(' ') : 'H510-PRO Wireless headset',
    kind: 'Headset sem fio',
    connection: 'Receptor USB 2.4 GHz',
    state: headset.connected ? 'Conectado (saída e microfone ativos no Windows)' : headset.dongle ? 'Receptor conectado, headset sem áudio no Windows' : 'Receptor não encontrado',
    connected: !!headset.connected,
    battery: b,
    source: b.kind === 'real' ? 'Leitura real do dispositivo.' : 'Nenhuma fonte de carga disponível.',
    lastReadingAt: b.at || null,
    lastReadingAgo: null,
    history: 0,
    reason: b.kind === 'real' ? null
      : 'O receptor (chip XiiSound/Weltrend, USB 040B:0897) não expõe bateria ao Windows nem em relatório HID padrão: tem só um canal proprietário (página 0xF100) sem relatórios de feature, que não transmite nada sozinho. Não há protocolo público para esse modelo, e o app não envia comandos desconhecidos ao headset.',
    ids: `VID ${hex4(H510.vendorId)} · PID ${hex4(H510.productId)}`,
    interfaces: live ? live.channels.map((c) => pageName(c.usagePage, c.usage)) : [],
    monitored: true,
    canListen: !!live,
  };
}

// hidList: logical devices from the HID worker (or null when it couldn't be read).
function collect({ hidList, saved = {}, headset, now = Date.now(), pollSec = 60, detectDriver = null }) {
  const list = Array.isArray(hidList) ? hidList : [];
  const entries = [];
  const liveH510 = list.find((d) => d.vendorId === H510.vendorId && d.productId === H510.productId);
  if (headset) entries.push(h510Entry(headset, liveH510));
  const savedIds = new Set();
  for (const d of Object.values(saved)) {
    if (d.hidden) continue;
    savedIds.add(d.id);
    const live = String(d.id).startsWith('bt:') ? null : (hidList ? (list.find((x) => x.id === d.id) || false) : null);
    entries.push(savedEntry(d, live, now, pollSec));
  }
  // Connected HID products nobody is monitoring yet (plain keyboards are left out).
  for (const d of list) {
    if (savedIds.has(d.id) || d === liveH510 || KEYBOARD_ONLY(d)) continue;
    const driver = detectDriver ? detectDriver(d) : null;
    const supported = driver && driver.id !== 'generic';
    // Wired peripherals have no battery: only list what has a driver or looks wireless.
    if (!supported && !/wireless|2.4s*g|receiver|dongle|bluetooth/i.test(`${d.product} ${d.manufacturer}`)) continue;
    entries.push({
      key: d.id,
      name: d.product || 'Dispositivo HID',
      product: [d.manufacturer, d.product].filter(Boolean).join(' '),
      kind: d.channels.some((c) => c.usagePage === 1 && c.usage === 2) ? 'Mouse ou receptor' : 'Dispositivo HID',
      connection: connectionOf(d),
      state: 'Conectado, não monitorado',
      connected: true,
      battery: { kind: 'unavailable', label: 'Não monitorado' },
      source: supported ? `Há um driver compatível (“${driver.id}”): adicione em Dispositivos > Adicionar dispositivo.` : 'Nenhum driver de bateria conhecido para este produto.',
      lastReadingAt: null,
      lastReadingAgo: null,
      history: 0,
      reason: supported ? 'Ainda não adicionado ao monitoramento.' : 'O produto não tem um formato de bateria conhecido pelo app.',
      ids: `VID ${hex4(d.vendorId)} · PID ${hex4(d.productId)}`,
      interfaces: d.channels.map((c) => pageName(c.usagePage, c.usage)),
      monitored: false,
    });
  }
  return entries;
}

function sanitize(text) {
  return String(text)
    .replace(/[a-z]:[\\/]users[\\/][^\\/\s"']+/gi, '~')
    .replace(/\\\\\?\\[^\s"']+/g, '<caminho do dispositivo>')
    .replace(/\b[0-9a-f]{2}([:-][0-9a-f]{2}){5}\b/gi, '<endereço>')
    .replace(/\b[0-9a-f]{12}\b/gi, '<endereço>');
}

function report({ entries, version, windows, apo, listen = null, now = Date.now() }) {
  const lines = [
    `CYL Audio Hub ${version} — relatório de dispositivos`,
    `Gerado em ${new Date(now).toISOString()} · Windows ${windows}`,
    `Equalizer APO: ${apo}`,
    '',
  ];
  for (const e of entries) {
    lines.push(`## ${e.name}${e.product && e.product !== e.name ? ` (${e.product})` : ''}`);
    lines.push(`Tipo: ${e.kind} · Conexão: ${e.connection} · ${e.ids}`);
    lines.push(`Estado: ${e.state}`);
    lines.push(`Bateria: ${e.battery.label} [${KIND_LABEL[e.battery.kind] || e.battery.kind}]${e.battery.charging ? ' · carregando' : ''}${e.battery.last ? ` · última conhecida ${e.battery.last}` : ''}`);
    lines.push(`Fonte: ${e.source}`);
    if (e.lastReadingAt) lines.push(`Última leitura: ${new Date(e.lastReadingAt).toISOString()} (${ago(now - e.lastReadingAt)}) · histórico: ${e.history} pontos`);
    if (e.reason) lines.push(`Motivo: ${e.reason}`);
    if (e.interfaces.length) lines.push(`Interfaces HID: ${e.interfaces.join('; ')}`);
    lines.push('');
  }
  if (listen) {
    lines.push(`## Escuta passiva — ${listen.name} (${Math.round(listen.ms / 1000)} s, somente leitura)`);
    lines.push(`Canais: ${listen.channels.map((c) => pageName(c.page, c.usage)).join('; ') || 'nenhum canal de fabricante'}`);
    if (!listen.frames.length) lines.push('Nenhum relatório recebido: o dispositivo não transmitiu nada sozinho nesse intervalo.');
    for (const f of listen.frames) lines.push(`+${String(f.t).padStart(5)} ms  0x${hex4(f.page)}  ${f.hex}`);
    if (listen.errors.length) lines.push(`Erros: ${listen.errors.join('; ')}`);
    lines.push('');
  }
  return sanitize(lines.join('\n'));
}

module.exports = { collect, report, sanitize, freshness, connectionOf, pageName, KIND_LABEL };
