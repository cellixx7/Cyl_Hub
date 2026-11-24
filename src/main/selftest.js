// End-to-end self test, development only: CYL_SELFTEST=1 runs it once the app is up, writes one
// "SELFTEST" line per check to the log, puts back everything it changed (microphone mute, active
// profile, EQ switch, binds) and quits. It drives the real modules against the real Windows audio
// devices, real RegisterHotKey and real key presses (SendInput), so it needs the PC's desktop.
const { globalShortcut, BrowserWindow } = require('electron');
const { execFile, spawn } = require('child_process');
const store = require('./store');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Presses a key combination through SendInput (the same path as a physical keyboard).
function press(vks) {
  const ps = `
Add-Type -Namespace K -Name I -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra);'
$k = @(${vks.join(',')})
foreach ($v in $k) { [K.I]::keybd_event($v, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 30 }
[array]::Reverse($k)
foreach ($v in $k) { [K.I]::keybd_event($v, 0, 2, [UIntPtr]::Zero); Start-Sleep -Milliseconds 30 }`;
  return new Promise((resolve) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true }, () => resolve()));
}

// Another process holding a hotkey, like a second app would (Ctrl+Alt+Shift+F10).
function holdHotkeyElsewhere(seconds) {
  const ps = `
Add-Type -Namespace K -Name H -MemberDefinition '[DllImport("user32.dll")] public static extern bool RegisterHotKey(System.IntPtr h, int id, uint mods, uint vk);'
$ok = [K.H]::RegisterHotKey([IntPtr]::Zero, 77, 0x7, 0x79)
Write-Output "held=$ok"
Start-Sleep -Seconds ${seconds}`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
  return new Promise((resolve) => child.stdout.on('data', (d) => resolve({ child, held: /held=True/.test(String(d)) })));
}

async function run({ ctx, log, showWindow, getWindow, quit }) {
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push(ok);
    log('SELFTEST', `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  };
  const { audio, keybinds } = ctx;
  const savedAudio = JSON.parse(JSON.stringify(audio.get()));
  const savedBinds = store.getBinds();
  let micBefore = null;
  try {
    // ---- devices ----
    const st = await audio.refresh(true);
    check('engine status', !!(st && st.devices && st.devices.length), `${st ? st.devices.length : 0} endpoints`);
    const t = audio.targets();
    check('H510-PRO output found', !!(t.render && /H510/i.test(t.render.name)), t.render && t.render.name);
    check('H510-PRO microphone found', !!(t.capture && /H510/i.test(t.capture.name)), t.capture && t.capture.name);
    const hid = await require('./hid/hid-client').enumerate().catch(() => null);
    const h = audio.headset({ hidList: hid, savedDevices: store.getDevices() });
    check('2.4 GHz receiver seen over HID', h.dongle === true);
    check('battery shown as unavailable, not invented', h.battery.kind === 'unavailable' && h.battery.label === 'Indisponível');

    // ---- microphone mute (put back afterwards) ----
    if (t.capture) {
      micBefore = t.capture.mute;
      const after = await audio.toggleMic();
      const real = (await audio.refresh(true)) && audio.targets().capture.mute;
      check('mic mute toggles the Windows endpoint', after === !micBefore && real === !micBefore);
      await audio.toggleMic();
      check('mic mute restored', audio.targets().capture.mute === micBefore);
    }

    // ---- volume: set to the value it already has (no audible change) ----
    if (t.render) {
      const v = Math.round(t.render.volume);
      await audio.setVolume(t.render.id, v);
      check('output volume write', Math.round(audio.targets().render.volume) === v, `${v}%`);
    }

    // ---- profiles + EQ (APO missing on this PC: reported, nothing written) ----
    const r1 = await audio.activateProfile('valorant');
    check('profile switch', audio.get().activeProfile === 'valorant');
    check('APO state reported honestly', r1.installed === !!ctx.apo.info(true), `installed=${r1.installed}`);
    await audio.setEqEnabled(!savedAudio.eqEnabled);
    check('EQ toggle', audio.get().eqEnabled === !savedAudio.eqEnabled);

    // ---- binds: real RegisterHotKey + real key press ----
    const before = audio.get().eqEnabled;
    let st2 = keybinds.apply([{ id: 't1', action: 'eq:toggle', accelerator: 'Control+Alt+Shift+F9', enabled: true }]);
    check('bind registered with Windows', st2.t1.registered && globalShortcut.isRegistered('Control+Alt+Shift+F9'));
    await press([0x11, 0x12, 0x10, 0x78]); // Ctrl Alt Shift F9
    for (let i = 0; i < 30 && audio.get().eqEnabled === before; i++) await wait(100);
    check('bind fires on a real key press', audio.get().eqEnabled === !before);

    // works with the window hidden
    const win = getWindow();
    if (win && !win.isDestroyed()) win.close(); // close-to-tray
    await wait(500);
    const b2 = audio.get().eqEnabled;
    await press([0x11, 0x12, 0x10, 0x78]);
    for (let i = 0; i < 30 && audio.get().eqEnabled === b2; i++) await wait(100);
    check('bind fires with the window closed to the tray', audio.get().eqEnabled === !b2);

    // a combination another program holds is refused, the others still register
    const other = await holdHotkeyElsewhere(8);
    st2 = keybinds.apply([
      { id: 't2', action: 'mic:toggle', accelerator: 'Control+Alt+Shift+F10', enabled: true },
      { id: 't3', action: 'eq:toggle', accelerator: 'Control+Alt+Shift+F9', enabled: true },
    ]);
    check('helper process holds Ctrl+Alt+Shift+F10', other.held);
    check('busy combination reported, not registered', !st2.t2.registered && /em uso/.test(st2.t2.error || ''), st2.t2.error);
    check('other binds unaffected by the failure', st2.t3.registered);
    other.child.kill();

    // ---- sleep / resume path (events emitted by hand: a real sleep can't be scripted here) ----
    const { powerMonitor } = require('electron');
    ctx.saveBinds([{ id: 't4', action: 'eq:toggle', accelerator: 'Control+Alt+Shift+F9', enabled: true }]);
    powerMonitor.emit('suspend');
    check('engine stopped on suspend', !ctx.engine.running());
    powerMonitor.emit('resume');
    await wait(4000);
    check('binds registered again after resume', globalShortcut.isRegistered('Control+Alt+Shift+F9'));
    check('audio status after resume', !!(await audio.refresh(true)));

    // ---- hidden window frees its renderer ----
    const renderers = () => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length;
    log('SELFTEST', 'waiting 32 s for the hidden window to be freed…');
    await wait(32000);
    check('hidden window destroyed after 30 s (renderer freed)', !getWindow() || getWindow().isDestroyed(), `${renderers()} window(s) left`);
    showWindow();
    for (let i = 0; i < 80 && !(getWindow() && getWindow().isVisible()); i++) await wait(100);
    check('window restored from the tray path', !!(getWindow() && getWindow().isVisible()));

    // ---- permissions: the window may open the microphone (mic test) but not the camera ----
    const wc = getWindow().webContents;
    const mic = await wc.executeJavaScript(`navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => { s.getTracks().forEach((t) => t.stop()); return 'ok'; }, (e) => e.name)`);
    check('microphone allowed for the app window', mic === 'ok', mic);
    const cam = await wc.executeJavaScript(`navigator.mediaDevices.getUserMedia({ video: true }).then((s) => { s.getTracks().forEach((t) => t.stop()); return 'ok'; }, (e) => e.name)`);
    check('camera refused', cam !== 'ok', cam);
  } catch (e) {
    check('self test crashed', false, e && e.stack);
  } finally {
    audio.persist(savedAudio);
    await audio.applyEq().catch(() => {});
    try { ctx.saveBinds(Array.isArray(savedBinds) ? savedBinds : require('./keybinds/model').DEFAULT_BINDS()); } catch (e) { log('ERROR', `selftest restore binds: ${e.message}`); }
    if (micBefore !== null) {
      await audio.refresh(true);
      const c = audio.targets().capture;
      if (c && c.mute !== micBefore) await audio.setMute(c.id, micBefore);
    }
    const failed = results.filter((x) => !x).length;
    log('SELFTEST', `DONE ${results.length - failed}/${results.length} passed`);
    if (process.env.CYL_SELFTEST !== 'keep') quit();
  }
}

module.exports = { run };
