// Mede o consumo real do app: RAM (working set e memória privada) e CPU de toda a árvore de
// processos (main, renderer, GPU, utilitários, e o motor de áudio se estiver aberto).
//
//   node scripts/bench.js            -> mede uma instância que já está rodando, por 60 s
//   node scripts/bench.js --launch   -> encerra nada; abre o app (com janela), mede, e depois
//                                      mede de novo em segundo plano (janela oculta)
//
// Nada é estimado: os números vêm de Win32_Process (WorkingSetSize, PrivatePageCount,
// UserModeTime + KernelModeTime). CPU % é normalizado pelo número de núcleos lógicos, como o
// Gerenciador de Tarefas mostra.
const { execFileSync, spawn } = require('child_process');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const CORES = os.cpus().length;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : def; };

// Every process whose executable is this app's electron.exe, plus AudioEngine.exe from this repo.
function snapshot() {
  const ps = `
$root = '${ROOT.replace(/'/g, "''")}'
Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, 'OrdinalIgnoreCase') } |
  ForEach-Object { '{0}|{1}|{2}|{3}|{4}|{5}' -f $_.ProcessId, $_.Name, $_.WorkingSetSize, $_.PrivatePageCount, ($_.UserModeTime + $_.KernelModeTime), (($_.CommandLine -replace '.*--type=(\\S+).*', '$1') -replace '^".*', 'main') }`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true });
  return out.trim().split(/\r?\n/).filter(Boolean).map((l) => {
    const [pid, name, ws, priv, cpu, type] = l.split('|');
    return { pid: +pid, name, ws: +ws, priv: +priv, cpu100ns: +cpu, type: name === 'electron.exe' ? type : name };
  });
}

async function measure(label, seconds) {
  const a = snapshot();
  const t0 = process.hrtime.bigint();
  const samples = [];
  for (let s = 0; s < seconds; s += 5) { await sleep(5000); samples.push(snapshot()); }
  const b = samples[samples.length - 1];
  const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const cpuOf = (list) => list.reduce((n, p) => n + p.cpu100ns, 0);
  // Only processes alive at both ends count toward CPU (a process that exited mid-window would
  // otherwise make the delta negative).
  const alive = b.filter((p) => a.some((q) => q.pid === p.pid));
  const before = a.filter((p) => alive.some((q) => q.pid === p.pid));
  const cpuMs = (cpuOf(alive) - cpuOf(before)) / 1e4;
  const peakWs = Math.max(...samples.map((l) => l.reduce((n, p) => n + p.ws, 0)));
  const res = {
    label,
    seconds: Math.round(wallMs / 1000),
    processes: b.length,
    workingSetMB: +(b.reduce((n, p) => n + p.ws, 0) / 1048576).toFixed(1),
    peakWorkingSetMB: +(peakWs / 1048576).toFixed(1),
    privateMB: +(b.reduce((n, p) => n + p.priv, 0) / 1048576).toFixed(1),
    cpuPercent: +((cpuMs / wallMs) * 100 / CORES).toFixed(3),
    cpuMsTotal: Math.round(cpuMs),
    byType: b.map((p) => `${p.type}:${(p.ws / 1048576).toFixed(0)}MB`).join(' '),
  };
  console.log(JSON.stringify(res));
  return res;
}

async function launch(extra) {
  const t0 = Date.now();
  const child = spawn(ELECTRON, [ROOT, ...extra], { detached: true, stdio: 'ignore', env: { ...process.env, CYL_BENCH: '1' } });
  child.unref();
  // Wait until the main process tree is up (renderer present when a window is shown).
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    const list = snapshot();
    if (extra.includes('--show') ? list.some((p) => p.type === 'renderer') : list.length > 0) break;
  }
  return Date.now() - t0;
}

function kill() {
  for (const p of snapshot()) { try { process.kill(p.pid); } catch (_) {} }
}

(async () => {
  const secs = opt('--seconds', 60);
  if (!args.includes('--launch')) { await measure('running', secs); return; }
  if (snapshot().length) { console.error('Já existe uma instância deste app rodando; feche-a antes de usar --launch.'); process.exit(1); }
  const startMs = await launch(['--show']);
  console.log(JSON.stringify({ label: 'startup-to-renderer-ms', value: startMs }));
  await sleep(10000);
  await measure('window-open-idle', secs);
  kill();
  await sleep(3000);
  await launch(['--hidden']);
  await sleep(15000);
  await measure('background-hidden', secs);
  if (!args.includes('--keep')) kill();
})().catch((e) => { console.error(e); process.exit(1); });
