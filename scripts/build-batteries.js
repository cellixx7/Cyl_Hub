// Builds the app's two small native helpers from their C# source with the C# compiler that ships
// with Windows, so there is nothing to install and no prebuilt binary in the repository:
//   src/main/system-batteries.exe  <- src/main/batteries/SystemBatteries.cs (Bluetooth / Xbox batteries)
//   native/AudioEngine.exe         <- native/AudioEngine.cs (WASAPI: devices, volume, mute, default)
// Runs before `npm start` and `npm run dist`. Not on Windows, or without the compiler, it skips:
// the app then uses the PowerShell script for batteries, and the audio pages say the engine is missing.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CSC = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const TARGETS = [
  { src: path.join(ROOT, 'src', 'main', 'batteries', 'SystemBatteries.cs'), out: path.join(ROOT, 'src', 'main', 'system-batteries.exe'), platform: 'anycpu' },
  // x64 on purpose: the engine's PROPVARIANT layout is the 64-bit one.
  { src: path.join(ROOT, 'native', 'AudioEngine.cs'), out: path.join(ROOT, 'native', 'AudioEngine.exe'), platform: 'x64' },
];

if (process.platform !== 'win32' || !fs.existsSync(CSC)) {
  console.log('build-batteries: no Windows C# compiler here, skipping (the PowerShell script is used instead)');
  process.exit(0);
}
for (const t of TARGETS) {
  if (fs.existsSync(t.out) && fs.statSync(t.out).mtimeMs >= fs.statSync(t.src).mtimeMs) continue;
  execFileSync(CSC, ['/nologo', '/optimize+', '/target:exe', `/platform:${t.platform}`, `/out:${t.out}`, t.src], { stdio: 'inherit' });
  console.log(`Wrote ${path.relative(ROOT, t.out)} (${Math.round(fs.statSync(t.out).size / 1024)} KB)`);
}
