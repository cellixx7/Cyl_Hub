// Read-only listening for the device diagnostics: opens the vendor collections of one device and
// records the input reports the device sends by itself for a few seconds. Nothing is ever written
// to the device, and no report is requested from it — no output reports, no feature reports — so
// this is safe on hardware whose protocol is unknown (the H510-PRO receiver).
const session = require('./session');

const MAX_MS = 15000;
const MAX_FRAMES = 40;
const SLICE_MS = 100;
// Mouse movement, keys and media keys aren't listened to: they would catch what the user types.
const isVendorChannel = (c) => c.usagePage !== 0x01 && c.usagePage !== 0x0c && c.usagePage !== 0x0d;

async function listen(logicalDevice, ms = 8000) {
  const duration = Math.max(1000, Math.min(MAX_MS, Number(ms) || 8000));
  const channels = logicalDevice.channels.filter(isVendorChannel);
  const frames = [];
  const errors = [];
  const deadline = Date.now() + duration;
  const opened = [];
  for (const c of channels) {
    try { opened.push({ c, dev: await session.acquire(c.path) }); } catch (e) { errors.push(`0x${c.usagePage.toString(16)}: ${e.message}`); }
  }
  while (Date.now() < deadline && opened.length && frames.length < MAX_FRAMES) {
    for (const { c, dev } of opened) {
      try {
        const f = await session.read(c.path, dev, SLICE_MS);
        if (f && f.length) frames.push({ t: duration - (deadline - Date.now()), page: c.usagePage, hex: Buffer.from(f).toString('hex') });
      } catch (e) {
        if (!/timeout/i.test(e.message) && !errors.includes(e.message)) errors.push(e.message);
      }
    }
  }
  return { ms: duration, channels: channels.map((c) => ({ page: c.usagePage, usage: c.usage, iface: c.interface })), frames, errors };
}

module.exports = { listen, isVendorChannel };
