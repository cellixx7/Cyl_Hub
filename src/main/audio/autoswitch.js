// Automatic profile switch: every `intervalSec` (5 s minimum, 10 s by default) the audio engine
// lists the names of the running processes (a system snapshot, the same one Task Manager uses: no
// handle is opened on any process, a game included), and the first rule, in the user's priority
// order, whose program is running picks the profile. When none matches, the profile chosen by hand
// comes back. Off by default; while off, nothing runs.

// rules: [{ exe, profile }] in priority order; procs: lower-case names without ".exe".
function decide(rules, procs, manualProfile) {
  const running = new Set(procs);
  const hit = rules.find((r) => running.has(r.exe));
  return hit ? { profile: hit.profile, rule: hit } : { profile: manualProfile, rule: null };
}

function createAutoSwitch({ engine, getAudio, activate, log = () => {} }) {
  let timer = null;
  let busy = false;
  let lastRule = null;

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const audio = getAudio();
      if (!audio.autoSwitch.enabled) return;
      const procs = await engine.procs();
      const { profile, rule } = decide(audio.autoSwitch.rules, procs, audio.manualProfile);
      const ruleKey = rule ? rule.exe : null;
      // Act only on a change of matching rule: a profile the user picks by hand while a game runs
      // stays until the game closes (or another rule takes over).
      if (ruleKey !== lastRule) {
        lastRule = ruleKey;
        if (profile !== audio.activeProfile) await activate(profile, { auto: true, reason: rule ? rule.exe : null });
      }
    } catch (e) {
      log('ERROR', `autoswitch: ${e && e.message}`);
    } finally {
      busy = false;
    }
  }

  function stop() {
    clearInterval(timer);
    timer = null;
    engine.keepAlive(false);
  }

  function restart() {
    stop();
    const audio = getAudio();
    if (!audio.autoSwitch.enabled || !audio.autoSwitch.rules.length) { lastRule = null; return; }
    engine.keepAlive(true); // one engine process kept for the interval instead of one per tick
    timer = setInterval(tick, audio.autoSwitch.intervalSec * 1000);
    tick();
  }

  return { restart, stop, tick, running: () => !!timer };
}

module.exports = { decide, createAutoSwitch };
