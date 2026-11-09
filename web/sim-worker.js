// Runs the engine-sim WASM build off the main thread.
// Audio goes straight to the AudioWorklet through a MessagePort; state and
// geometry go to the page about 60 times a second.
/* global EngineSimModule */
const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
importScripts('engine.js?v=' + VERSION);

const SAMPLE_RATE = 44100;
// Queued audio: ~70 ms normally, more on the light levels to ride out CPU hiccups.
const leadTarget = () => Math.round(SAMPLE_RATE * (level >= 2 ? 0.12 : 0.07));
const STATE_INTERVAL = 1000 / 60;

let M = null;
let audioPort = null;
let loaded = false;
let running = false;
let written = 0;
let consumed = 0;
let lastTick = 0;
let lastState = 0;
let scope = new Float32Array(2048);
let scopePos = 0;
let api = null;
let gen = 0;

// Quality levels: simulation frequency scale (relative to the engine script), fluid sub-steps,
// and impulse-response length (convolution cost).
const LEVELS = [
  { name: 'High', fs: 1.0, fluid: 8, ir: 10000 },
  { name: 'Medium', fs: 0.5, fluid: 8, ir: 6000 },
  { name: 'Low', fs: 0.25, fluid: 8, ir: 3000 },
  { name: 'Very low', fs: 0.15, fluid: 8, ir: 1500 },
  { name: 'Ultra low', fs: 0.1, fluid: 6, ir: 800 },
];
let qualityMode = 'auto';   // 'auto' or a level index
let level = 1;
let load = 0;               // processing time / simulated time (1.0 = just real time)
let lastLevelChange = 0;
let underruns = 0;
let underrunsSeen = 0;
let lastDowngrade = -1e9;

function applyLevel(l, reason) {
  level = Math.max(0, Math.min(LEVELS.length - 1, l));
  const L = LEVELS[level];
  if (M && loaded) {
    M._es_set_quality(L.fs, L.fluid);
    M._es_set_ir_limit(L.ir);
  }
  lastLevelChange = performance.now();
  load = 0.5;
  send({ type: 'quality', mode: qualityMode, level, name: L.name, reason: reason || '' });
}

function autoQuality(now, spentMs, simMs) {
  if (simMs <= 0) return;
  const since = now - lastLevelChange;
  if (since < 1000) { underrunsSeen = underruns; return; }  // switching itself causes a spike
  load = load * 0.97 + 0.03 * (spentMs / simMs);
  if (qualityMode !== 'auto') { underrunsSeen = underruns; return; }
  // Audio gaps are the clearest sign the CPU can't keep up.
  const newGaps = underruns - underrunsSeen;
  underrunsSeen = underruns;
  if (since > 1500 && level < LEVELS.length - 1 && (load > 0.75 || (newGaps > 0 && since > 2500))) {
    lastDowngrade = now;
    applyLevel(level + 1, 'cpu');
  } else if (load < 0.28 && since > 8000 && now - lastDowngrade > 30000 && level > 0) {
    applyLevel(level - 1, 'headroom');
  }
}

function send(msg, transfer) { postMessage(msg, transfer || []); }

function listEngines() {
  const out = [];
  const walk = (dir) => {
    for (const name of M.FS.readdir(dir)) {
      if (name === '.' || name === '..') continue;
      const p = dir + '/' + name;
      const st = M.FS.stat(p);
      if (M.FS.isDir(st.mode)) walk(p);
      else if (name.endsWith('.mr')) {
        const text = M.FS.readFile(p, { encoding: 'utf8' });
        if (/public\s+node\s+main\b/.test(text)) {
          const m = text.match(/name:\s*"([^"]+)"/);
          out.push({ path: p.replace('/assets/', ''), label: m ? m[1] : name });
        }
      }
    }
  };
  walk('/assets/engines');
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

function loadEngine(importPath, standalone) {
  // A standalone script already calls main() itself (like assets/main.mr).
  let mainFile = 'web_main.mr';
  if (standalone) {
    mainFile = importPath;
  } else {
    const main =
      'import "engine_sim.mr"\n' +
      'import "themes/default.mr"\n' +
      `import "${importPath}"\n\n` +
      'use_default_theme()\nmain()\n';
    M.FS.writeFile('/assets/web_main.mr', main);
  }
  try { M.FS.unlink('/assets/error_log.log'); } catch (e) { /* none */ }
  let ok = 0;
  let err = '';
  try {
    ok = api.load(mainFile);
    err = M.UTF8ToString(api.error());
  } catch (e) {
    err = 'Engine crashed while loading: ' + e;
    send({ type: 'fatal', error: err });
    return;
  }
  loaded = !!ok;
  gen++;
  const info = ok ? JSON.parse(M.UTF8ToString(api.info())) : null;
  if (ok) applyLevel(level, 'load');
  send({ type: 'loaded', ok: !!ok, error: err, info, path: importPath, gen });
}

function tick() {
  if (!running) return;
  const now = performance.now();
  const dt = Math.min(0.1, Math.max(0.001, (now - lastTick) / 1000));
  lastTick = now;

  if (loaded) {
    const lead = written - consumed;
    const want = Math.max(0, Math.min(6000, leadTarget() - lead));
    let n = 0;
    try {
      const f0 = performance.now();
      n = api.frame(dt, dt, want);
      const sp = api.statePtr() >> 3;
      const simMs = (M.HEAPF64[sp + 20] / M.HEAPF64[sp + 17]) * 1000 / Math.max(1e-6, M.HEAPF64[sp + 40]);
      autoQuality(now, performance.now() - f0, simMs);
    } catch (e) {
      loaded = false;
      send({ type: 'fatal', error: 'Simulation crashed: ' + e });
    }
    if (n > 0) {
      const ptr = api.audioPtr() >> 1;
      const chunk = M.HEAP16.slice(ptr, ptr + n);
      for (let i = 0; i < n; i += 2) {
        scope[scopePos] = chunk[i] / 32768;
        scopePos = (scopePos + 1) % scope.length;
      }
      written += n;
      if (audioPort) audioPort.postMessage(chunk, [chunk.buffer]);
    }

    if (now - lastState >= STATE_INTERVAL) {
      lastState = now;
      const sp = api.statePtr() >> 3;
      const state = M.HEAPF64.slice(sp, sp + 64);
      const fp = api.framePtr() >> 3;
      const frame = M.HEAPF64.slice(fp, fp + api.frameLen());
      const sc = new Float32Array(scope.length);
      sc.set(scope.subarray(scopePos));
      sc.set(scope.subarray(0, scopePos), scope.length - scopePos);
      send({ type: 'state', gen, load, underruns, state, frame, scope: sc, audioLead: (written - consumed) / SAMPLE_RATE },
        [state.buffer, frame.buffer, sc.buffer]);
    }
  }
  const spent = performance.now() - now;
  setTimeout(tick, Math.max(0, 6 - spent));
}

onmessage = async (ev) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'init': {
      audioPort = msg.port || null;
      if (audioPort) {
        audioPort.onmessage = (e) => {
          if (e.data && e.data.consumed !== undefined) consumed = e.data.consumed;
          if (e.data && e.data.underruns !== undefined) underruns = e.data.underruns;
          if (e.data && e.data.reset) { written = 0; consumed = 0; }
        };
      }
      M = await EngineSimModule({ locateFile: (p) => p + '?v=' + VERSION });
      api = {
        load: M.cwrap('es_load', 'number', ['string']),
        error: M._es_error, info: M._es_info,
        frame: M._es_frame, audioPtr: M._es_audio_ptr,
        statePtr: M._es_state_ptr, framePtr: M._es_frame_ptr, frameLen: M._es_frame_len,
      };
      M.FS.chdir('/assets');
      // Let uploaded scripts in /assets/user import "themes/…", "engines/…" etc.
      for (const d of ['themes', 'engines', 'part-library', 'sound-library']) {
        try { M.FS.stat('/es/' + d); } catch (e) {
          try { M.FS.stat('/assets/' + d); M.FS.symlink('/assets/' + d, '/es/' + d); } catch (e2) { /* missing */ }
        }
      }
      send({ type: 'ready', engines: listEngines() });
      break;
    }
    case 'load':
      loadEngine(msg.path);
      break;
    case 'loadSource': {
      try { M.FS.mkdir('/assets/user'); } catch (e) { /* exists */ }
      const safe = msg.name.replace(/[^A-Za-z0-9_.-]/g, '_');
      M.FS.writeFile('/assets/user/' + safe, msg.text);
      const standalone = /^\s*main\s*\(\s*\)/m.test(msg.text);
      loadEngine('user/' + safe, standalone);
      break;
    }
    case 'start':
      if (!running) { running = true; lastTick = performance.now(); tick(); }
      break;
    case 'quality':
      qualityMode = msg.mode;
      applyLevel(msg.mode === 'auto' ? level : msg.mode, 'user');
      break;
    case 'audioReset':
      written = consumed = 0;
      break;
    case 'call': {
      // Generic control call: { fn: 'es_set_throttle', args: [0.5] }
      if (!M) return;
      const f = M['_' + msg.fn];
      if (f) f(...msg.args);
      break;
    }
  }
};
