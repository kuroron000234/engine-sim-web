'use strict';
// Engine Simulator Web — UI, rendering and input.
// The simulation itself runs in sim-worker.js (WebAssembly build of engine-sim).

const $ = (id) => document.getElementById(id);
const TAU = Math.PI * 2;
const VERSION = (document.currentScript && new URL(document.currentScript.src).searchParams.get('v')) || 'dev';

// ---------- Units ----------
const U = {
  rpm: (radps) => radps * 60 / TAU,
  mph: (mps) => mps / 0.44704,
  kmh: (mps) => mps * 3.6,
  inHg: (pa) => pa / 3386.3886666666713,
  kPa: (pa) => pa / 1000,
  lbft: (nm) => nm / (0.3048 * 4.44822),
  hp: (w) => w / 745.699872,
  kW: (w) => w / 1000,
  scfm: (molps) => molps / (0.002641 * 453.59237 / 60),
  liters: (m3) => m3 * 1000,
  ci: (m3) => m3 / Math.pow(0.0254, 3),
  K2C: (k) => k - 273.15,
};
const ATM = 101325;

// ---------- State ----------
const S = {
  worker: null,
  audioCtx: null,
  audioNode: null,
  ready: false,
  started: false,
  engines: [],
  info: null,
  state: null,
  frame: null,
  scope: null,
  audioLead: 0,
  metric: false,
  layer0: 0,
  displayAngle: 0,
  view: null,
  dynoCurve: new Map(),
  scopeTab: 'wave',
  colors: null,
  fps: 60,
  lastLoadPath: null,
  quality: { mode: 'auto', level: 1, name: 'Medium' },
  load: 0,
  dirty: true,
};

const keys = new Set();
const ctl = {
  throttleSlider: 0,
  fineThrottle: 0,
  clutchSlider: 1,
  targetClutch: 1,
  starterBtn: false,
  clutchBtn: false,
  last: {},
};

function call(fn, ...args) {
  if (S.worker) S.worker.postMessage({ type: 'call', fn, args });
}
// Send only when a value changes.
function setCtl(name, fn, ...args) {
  const key = args.join(',');
  if (ctl.last[name] === key) return;
  ctl.last[name] = key;
  call(fn, ...args);
}

function log(msg, isError) {
  const el = $('log');
  el.textContent = msg;
  el.classList.toggle('error', !!isError);
}

// ---------- Colors ----------
function hex(c) { return '#' + c.toString(16).padStart(6, '0'); }
function rgb(c) { return [(c >> 16) & 255, (c >> 8) & 255, c & 255]; }
function css(a) { return `rgb(${a[0] | 0},${a[1] | 0},${a[2] | 0})`; }
function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
function setColors(list) {
  const [bg, fg, shadow, h1, h2, pink, red, orange, yellow, blue, green] = list.map(rgb);
  S.colors = { bg, fg, shadow, h1, h2, pink, red, orange, yellow, blue, green };
}
setColors([0x0E1012, 0xFFFFFF, 0x0E1012, 0xEF4545, 0xFFFFFF, 0xF394BE, 0xEE4445, 0xF4802A, 0xFDBD2E, 0x77CEE0, 0xBDD869]);
function tint(col, layers) {
  let r = col;
  for (let i = 0; i < layers; ++i) r = mix(S.colors.bg, r, 0.3);
  return r;
}

// ---------- Worker / audio ----------
async function boot() {
  S.worker = new Worker('sim-worker.js?v=' + VERSION);
  S.worker.onmessage = onWorkerMessage;
  S.worker.onerror = (e) => log('Worker error: ' + (e.message || e), true);
  S.channel = new MessageChannel();
  S.worker.postMessage({ type: 'init', port: S.channel.port1 }, [S.channel.port1]);
}

async function startAudio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  let ctx;
  try { ctx = new AC({ sampleRate: 44100, latencyHint: 'interactive' }); }
  catch (e) { ctx = new AC({ latencyHint: 'interactive' }); }
  await ctx.audioWorklet.addModule('audio-worklet.js?v=' + VERSION);
  const node = new AudioWorkletNode(ctx, 'engine-sim-output', { numberOfInputs: 0, outputChannelCount: [2] });
  node.connect(ctx.destination);
  // The worker streams audio straight into the worklet.
  node.port.postMessage({ type: 'port', port: S.channel.port2 }, [S.channel.port2]);
  await ctx.resume();
  S.audioCtx = ctx;
  S.audioNode = node;
}

function onWorkerMessage(ev) {
  const m = ev.data;
  if (m.type === 'ready') {
    S.engines = m.engines;
    const sel = $('engine-select');
    sel.innerHTML = '';
    let lastGroup = null, group = null;
    for (const e of m.engines) {
      const g = e.path.split('/')[1];
      if (g !== lastGroup) {
        group = document.createElement('optgroup');
        group.label = g;
        sel.appendChild(group);
        lastGroup = g;
      }
      const o = document.createElement('option');
      o.value = e.path;
      o.textContent = e.label + '  (' + e.path.split('/').pop().replace('.mr', '') + ')';
      group.appendChild(o);
    }
    sel.disabled = false;
    let q = 'auto';
    try { q = localStorage.getItem('esw-quality') || 'auto'; } catch (e) { /* no storage */ }
    $('quality-select').value = q;
    S.worker.postMessage({ type: 'quality', mode: q === 'auto' ? 'auto' : Number(q) });
    let initial = 'engines/atg-video-2/01_subaru_ej25_eh.mr';
    try { initial = localStorage.getItem('esw-engine') || initial; } catch (e) { /* no storage */ }
    if (!m.engines.some((e) => e.path === initial)) initial = m.engines[0].path;
    sel.value = initial;
    loadEngine(initial);
    $('start-btn').disabled = false;
    $('start-btn').textContent = 'Start';
  } else if (m.type === 'loaded') {
    if (!m.ok) {
      log('Could not load engine:\n' + m.error, true);
      S.info = null;
      return;
    }
    S.info = m.info;
    S.gen = m.gen;
    S.state = null;
    S.frame = null;
    S.layer0 = 0;
    S.dynoCurve.clear();
    ctl.last = {};
    setColors(m.info.colors);
    S.metric = m.info.units.speed !== 'mph';
    updateUnitsBtn();
    computeView();
    renderSpecs();
    log(m.error ? m.error : 'Loaded ' + m.info.name + '. Press A for ignition, hold S to start.', !!m.error);
  } else if (m.type === 'state') {
    if (m.gen !== S.gen || !S.info) return;
    S.state = m.state;
    S.frame = m.frame;
    S.scope = m.scope;
    S.audioLead = m.audioLead;
    S.load = m.load;
    S.dirty = true;
    S.panelDirty = true;
    onState();
  } else if (m.type === 'quality') {
    S.quality = m;
    if (m.reason === 'cpu' || m.reason === 'headroom') log('Auto quality: ' + m.name + (m.reason === 'cpu' ? ' (CPU busy)' : ''));
  } else if (m.type === 'fatal') {
    log(m.error + '\nReloading simulator…', true);
    restartWorker();
  }
}

function restartWorker() {
  if (S.worker) S.worker.terminate();
  S.info = null;
  S.ready = false;
  boot().then(() => {
    if (S.started) {
      if (S.audioNode) S.audioNode.port.postMessage({ type: 'port', port: S.channel.port2 }, [S.channel.port2]);
      S.worker.postMessage({ type: 'start' });
    }
  });
}

function loadEngine(path) {
  S.lastLoadPath = path;
  log('Compiling ' + path + ' …');
  S.worker.postMessage({ type: 'load', path });
  try { localStorage.setItem('esw-engine', path); } catch (e) { /* no storage */ }
}

// ---------- Info panels ----------
function renderSpecs() {
  const i = S.info;
  $('engine-name').textContent = i.name;
  const disp = `${U.liters(i.displacement).toFixed(2)} L / ${U.ci(i.displacement).toFixed(0)} ci`;
  $('engine-specs').innerHTML =
    `${i.cylinders.length} cylinders · ${i.banks.length} bank${i.banks.length > 1 ? 's' : ''}<br>` +
    `${disp}<br>Redline ${Math.round(U.rpm(i.redline))} rpm · ${i.gearCount} gears`;
}

function updateUnitsBtn() { $('units-btn').textContent = S.metric ? 'Metric' : 'Imperial'; }

let perfAcc = 0;
function onState() {
  const st = S.state;
  // Button states
  $('btn-ignition').classList.toggle('on', st[12] > 0);
  $('btn-starter').classList.toggle('on', st[11] > 0);
  $('btn-dyno').classList.toggle('on', st[13] > 0);
  $('btn-hold').classList.toggle('on', st[14] > 0);
  $('btn-clutch').classList.toggle('warn', st[10] < 0.5);
  $('throttle-val').textContent = Math.round(st[26] * 100) + '%';

  // Dyno curve
  if (st[13] > 0 && st[5] > 0) {
    const rpm = U.rpm(st[0]);
    const bucket = Math.round(rpm / 50) * 50;
    S.dynoCurve.set(bucket, { t: st[5], p: st[6] });
  }

  const now = performance.now();
  if (now - perfAcc > 250) {
    perfAcc = now;
    const rows = [
      ['Sim frequency', `${Math.round(st[17])} Hz`],
      ['Fluid steps', `${st[41]}`],
      ['Steps / frame', `${st[20]}`],
      ['Physics / frame', `${(st[21] / 1000).toFixed(2)} ms`],
      ['Input latency', `${(st[18] * 1000).toFixed(0)} / ${(st[19] * 1000).toFixed(0)} ms`],
      ['Audio queue', `${(S.audioLead * 1000).toFixed(0)} ms`],
      ['Sim speed', st[40] === 1 ? 'real time' : `1/${Math.round(1 / st[40])}`],
      ['Quality', `${S.quality.mode === 'auto' ? 'Auto · ' : ''}${S.quality.name}`],
      ['CPU load', `${Math.round(S.load * 100)}% of real time`],
      ['Render FPS', `${S.fps.toFixed(0)}`],
      ['Layer', `${S.layer0 + 1} / ${st[37]}`],
    ];
    $('perf').innerHTML = rows.map(([k, v]) => `<div>${k}</div><div>${v}</div>`).join('');
  }
}

// ---------- Engine view ----------
function computeView() {
  const i = S.info;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x, y) => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); };
  const roller = 300 * 0.0000254;
  for (const b of i.banks) {
    const s = b.bore / 2;
    const camR = Math.max(b.intakeCam.base, b.exhaustCam.base) + Math.max(...b.intakeCam.profile, ...b.exhaustCam.profile);
    const top = b.deck + b.chamberHeight + 1.99 * s + roller * 2 + camR * 2;
    const bottom = (1 - b.displayDepth) * b.deck;
    const c = Math.cos(b.angle), sn = Math.sin(b.angle);
    for (const [lx, ly] of [[-1.35 * s, bottom], [1.35 * s, bottom], [-1.35 * s, top], [1.35 * s, top]]) {
      add(b.x + c * lx - sn * ly, b.y + sn * lx + c * ly);
    }
  }
  for (const c of i.cranks) {
    const r = c.throw * 1.9;
    add(c.x - r, c.y - r); add(c.x + r, c.y + r);
  }
  S.view = { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w: maxX - minX, h: maxY - minY };
}

function fitCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, S.quality.level >= 2 ? 1.25 : 2);
  const r = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  return { w, h, dpr };
}

function localToWorld(px, py, th, lx, ly) {
  const c = Math.cos(th), s = Math.sin(th);
  return [px + c * lx - s * ly, py + s * lx + c * ly];
}

function drawEngine() {
  const canvas = $('engine-view');
  const { w, h, dpr } = fitCanvas(canvas);
  const ctx = canvas.getContext('2d');
  const C = S.colors;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = css(C.bg);
  ctx.fillRect(0, 0, w, h);
  if (!S.info || !S.frame || !S.view) {
    ctx.fillStyle = css(C.fg);
    ctx.font = `${14 * dpr}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.fillText(S.info ? '' : 'No engine loaded', w / 2, h / 2);
    return;
  }
  const info = S.info, f = S.frame, st = S.state;
  const V = S.view;
  const scale = Math.min(w / V.w, h / V.h) * 0.88;
  const px = 1 / scale; // one device pixel in world units
  ctx.setTransform(scale, 0, 0, -scale, w / 2, h / 2);
  ctx.rotate(-S.displayAngle);
  ctx.translate(-V.cx, -V.cy);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const nCrank = info.cranks.length, nCyl = info.cylinders.length;
  const crankAt = (i) => [f[i * 3], f[i * 3 + 1], f[i * 3 + 2]];
  const cylBase = nCrank * 3;
  const CYL = 14;
  const cyl = (i) => {
    const o = cylBase + i * CYL;
    return {
      p: [f[o], f[o + 1], f[o + 2]], r: [f[o + 3], f[o + 4], f[o + 5]],
      lit: f[o + 6] > 0, tx: f[o + 7], ty: f[o + 8], P: f[o + 9], T: f[o + 10],
      inLift: f[o + 11], exLift: f[o + 12],
    };
  };
  const bankBase = cylBase + nCyl * CYL;
  const maxDepth = info.maxDepth;
  const layer0 = Math.min(S.layer0, Math.max(0, maxDepth - 1));
  const pink = css(C.pink);

  const foremost = info.banks.map((b) => {
    let best = -1;
    info.cylinders.forEach((c, idx) => {
      if (c.bank === b.index && c.journal >= layer0 && (best < 0 || c.journal < info.cylinders[best].journal)) best = idx;
    });
    return best;
  });

  // --- Bank walls and heads (bottom bucket)
  const roller = 300 * 0.0000254;
  info.banks.forEach((b, bi) => {
    const s = b.bore / 2;
    const lw = b.bore * 0.1;
    const margin = lw * 0.25;
    const off = margin + b.bore / 2 + lw / 2;
    const top = b.deck + b.chamberHeight;
    const bottom = (1 - b.displayDepth) * b.deck;
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(b.angle);
    ctx.strokeStyle = pink;
    ctx.lineWidth = lw;
    for (const sx of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(sx * off, bottom);
      ctx.lineTo(sx * off, top);
      ctx.stroke();
    }
    // Head (in units of s)
    ctx.translate(0, top);
    ctx.save();
    ctx.scale(s, s);
    ctx.fillStyle = pink;
    ctx.beginPath();
    const hw = (off + lw / 2) / s;
    ctx.moveTo(-hw, 0);
    ctx.lineTo(-hw, 1.75);
    ctx.lineTo(-0.85, 1.75);
    ctx.lineTo(-0.85, 2.15);
    ctx.lineTo(0.85, 2.15);
    ctx.lineTo(0.85, 1.75);
    ctx.lineTo(hw, 1.75);
    ctx.lineTo(hw, 0);
    ctx.closePath();
    ctx.fill();
    // valve guides / ports cut-outs
    ctx.strokeStyle = css(C.bg);
    ctx.lineWidth = 0.2;
    const seg = (x0, y0, x1, y1) => { ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); };
    seg(-0.689352, 0.085, -0.88632, -0.077975);
    seg(-(-0.689352 + 0.5) - 0.5, 0.085, -(-0.88632 + 0.5) - 0.5, -0.077975);
    seg(0.689352, 0.085, 0.88632, -0.077975);
    seg(-(0.689352 - 0.5) + 0.5, 0.085, -(0.88632 - 0.5) + 0.5, -0.077975);
    ctx.lineWidth = 0.0917 + 5 * px / s;
    seg(-0.5, 0.2, -0.5, 1.5);
    seg(0.5, 0.2, 0.5, 1.5);
    ctx.restore();

    // Valves and cams of the foremost cylinder
    const fc = foremost[bi];
    if (fc >= 0) {
      const c = cyl(fc);
      const bankCyl = info.cylinders[fc].bankCyl;
      const intakeX = b.flip ? 0.5 : -0.5;
      const camAngles = [f[bankBase + bi * 2], f[bankBase + bi * 2 + 1]];
      const valves = [
        { x: intakeX, lift: c.inLift, col: C.blue, cam: b.intakeCam, ang: camAngles[0] },
        { x: -intakeX, lift: c.exLift, col: C.yellow, cam: b.exhaustCam, ang: camAngles[1] },
      ];
      for (const v of valves) {
        const vc = css(v.col);
        ctx.save();
        ctx.scale(s, s);
        ctx.translate(v.x, -v.lift / s);
        ctx.fillStyle = vc;
        ctx.beginPath(); // valve head
        ctx.moveTo(-0.36, 0.0); ctx.lineTo(0.36, 0.0); ctx.lineTo(0.08, 0.2); ctx.lineTo(-0.08, 0.2); ctx.closePath();
        ctx.fill();
        ctx.fillRect(-0.045, 0.1, 0.09, 1.89); // stem
        const rr = roller / s;
        ctx.beginPath(); ctx.arc(0, 1.99, rr + 2.5 * px / s, 0, TAU); ctx.fillStyle = css(C.bg); ctx.fill();
        ctx.beginPath(); ctx.arc(0, 1.99, rr, 0, TAU); ctx.fillStyle = vc; ctx.fill();
        ctx.beginPath(); ctx.arc(0, 1.99, rr * 0.25, 0, TAU); ctx.fillStyle = css(C.bg); ctx.fill();
        ctx.restore();

        // Cam lobe
        const cam = v.cam;
        const lobe = cam.lobes[bankCyl] || 0;
        ctx.save();
        ctx.translate(v.x * s, 2.5 * px + 1.99 * s + cam.base + roller);
        ctx.rotate(v.ang + lobe);
        ctx.beginPath();
        const N = cam.profile.length;
        for (let k = 0; k <= 72; ++k) {
          const phi = (k / 72) * TAU;
          let t = (phi - 1.5 * Math.PI) % TAU; if (t < 0) t += TAU;
          const fi = (t / TAU) * N;
          const i0 = Math.floor(fi) % N, i1 = (i0 + 1) % N, fr = fi - Math.floor(fi);
          const lift = cam.profile[i0] * (1 - fr) + cam.profile[i1] * fr;
          const rad = cam.base + lift;
          const x = Math.cos(phi) * rad, y = Math.sin(phi) * rad;
          if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.fillStyle = vc;
        ctx.fill();
        ctx.beginPath(); ctx.arc(0, 0, roller * 0.25, 0, TAU); ctx.fillStyle = css(C.bg); ctx.fill();
        ctx.restore();
      }
    }
    ctx.restore();
  });

  // --- Moving parts, deepest layer first
  const grey0 = mix(C.bg, C.fg, 0.9333), grey1 = mix(C.bg, C.fg, 0.8667), grey2 = mix(C.bg, C.fg, 0.05);
  const crankCol = mix(C.bg, C.fg, 0.7), snoutCol = mix(C.bg, C.fg, 0.6), threadCol = mix(C.bg, C.fg, 0.2);

  const drawRod = (i, layerTint) => {
    const ci = info.cylinders[i], c = cyl(i);
    const T = info.cranks[ci.crank].throw;
    const col = css(tint(ci.bank % 2 === 0 ? grey0 : grey1, layerTint));
    ctx.save();
    ctx.translate(c.r[0], c.r[1]);
    ctx.rotate(c.r[2]);
    ctx.strokeStyle = col;
    ctx.fillStyle = col;
    ctx.lineWidth = T * 0.5;
    ctx.beginPath();
    ctx.moveTo(0, ci.bigEnd + T * 0.6);
    ctx.lineTo(0, ci.littleEnd);
    ctx.stroke();
    // big end
    ctx.beginPath();
    ctx.arc(0, ci.bigEnd, T * 0.62, 0, TAU);
    ctx.fill();
    // little end eye
    ctx.beginPath();
    ctx.arc(0, ci.littleEnd, T * 0.32, 0, TAU);
    ctx.fill();
    if (ci.rodJournals.length > 0) {
      ctx.beginPath();
      ctx.arc(0, ci.bigEnd, ci.slaveThrow * 1.5, 0, TAU);
      ctx.fill();
      ctx.fillStyle = css(tint(grey2, layerTint));
      for (let k = 0; k < ci.rodJournals.length; k += 2) {
        ctx.beginPath();
        ctx.arc(ci.rodJournals[k], ci.rodJournals[k + 1], T * 0.2, 0, TAU);
        ctx.fill();
      }
    }
    ctx.restore();
  };

  const drawPiston = (i, layerTint) => {
    const ci = info.cylinders[i], c = cyl(i);
    const bank = info.banks[ci.bank];
    const bore = bank.bore;
    const col = css(tint(C.fg, layerTint));
    const hole = css(tint(C.bg, layerTint));
    ctx.save();
    ctx.translate(c.p[0], c.p[1]);
    ctx.rotate(c.p[2]);
    // local +y points toward the crank; the crown is at -compressionHeight
    const crown = -ci.compressionHeight;
    const skirt = Math.max(ci.wristPin + bore * 0.32, crown + bore * 0.6);
    const hw = bore * 0.49;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(-hw, crown);
    ctx.lineTo(hw, crown);
    ctx.lineTo(hw, skirt - bore * 0.08);
    ctx.lineTo(hw * 0.86, skirt);
    ctx.lineTo(-hw * 0.86, skirt);
    ctx.lineTo(-hw, skirt - bore * 0.08);
    ctx.closePath();
    ctx.fill();
    // ring grooves
    ctx.strokeStyle = hole;
    ctx.lineWidth = Math.max(px * 1.5, bore * 0.012);
    for (let k = 1; k <= 3; ++k) {
      const y = crown + bore * 0.045 * k;
      ctx.beginPath(); ctx.moveTo(-hw, y); ctx.lineTo(-hw * 0.82, y); ctx.moveTo(hw, y); ctx.lineTo(hw * 0.82, y); ctx.stroke();
    }
    ctx.fillStyle = hole;
    ctx.beginPath();
    ctx.arc(0, ci.wristPin, (bore / 10) * 0.75, 0, TAU);
    ctx.fill();
    ctx.restore();
  };

  const drawCrankThrow = (ciIdx, j, layerTint) => {
    const [x, y, th] = crankAt(ciIdx);
    const cr = info.cranks[ciIdx];
    const T = cr.throw;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(th + cr.journals[j]);
    ctx.fillStyle = css(tint(crankCol, layerTint));
    // counterweight
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, T * 1.65, Math.PI * 0.62, Math.PI * 1.38);
    ctx.closePath();
    ctx.fill();
    // web
    ctx.beginPath();
    ctx.moveTo(-T * 0.2, -T * 0.55);
    ctx.lineTo(T, -T * 0.48);
    ctx.arc(T, 0, T * 0.48, -Math.PI / 2, Math.PI / 2);
    ctx.lineTo(-T * 0.2, T * 0.55);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath(); ctx.arc(0, 0, T * 0.62, 0, TAU); ctx.fill();
    ctx.fillStyle = css(tint(mix(C.bg, C.fg, 0.45), layerTint));
    ctx.beginPath(); ctx.arc(T, 0, T * 0.3, 0, TAU); ctx.fill();
    ctx.restore();
  };

  for (let L = maxDepth - 1; L >= layer0; --L) {
    const lt = L - layer0;
    // sublayer 0: plain rods; sublayer 1: master rods
    for (const master of [false, true]) {
      for (let i = 0; i < nCyl; ++i) {
        const ci = info.cylinders[i];
        if (ci.layer !== L) continue;
        if ((ci.rodJournals.length > 0) !== master) continue;
        drawRod(i, lt);
      }
    }
    // sublayer 2: crank throws
    for (let k = 0; k < nCrank; ++k) {
      if (L < info.cranks[k].journals.length) drawCrankThrow(k, L, lt);
    }
    for (let i = 0; i < nCyl; ++i) if (info.cylinders[i].layer === L) drawPiston(i, lt);
  }
  // crank snout
  for (let k = 0; k < nCrank; ++k) {
    const [x, y] = crankAt(k);
    const T = info.cranks[k].throw;
    ctx.fillStyle = css(snoutCol);
    ctx.beginPath(); ctx.arc(x, y, T * 0.45, 0, TAU); ctx.fill();
    ctx.fillStyle = css(threadCol);
    ctx.beginPath(); ctx.arc(x, y, T * 0.28, 0, TAU); ctx.fill();
  }

  // Flames (foremost cylinder per bank)
  info.banks.forEach((b, bi) => {
    const fc = foremost[bi];
    if (fc < 0) return;
    const c = cyl(fc);
    if (!c.lit) return;
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(b.angle);
    ctx.strokeStyle = `rgba(${C.orange[0]},${C.orange[1]},${C.orange[2]},0.6)`;
    ctx.lineCap = 'butt';
    ctx.lineWidth = c.tx * 2;
    ctx.beginPath();
    ctx.moveTo(0, b.deck + b.chamberHeight);
    ctx.lineTo(0, b.deck + b.chamberHeight - c.ty);
    ctx.stroke();
    ctx.restore();
  });

  // Overlay text
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = css(mix(C.bg, C.fg, 0.55));
  ctx.font = `${11 * dpr}px ui-monospace, monospace`;
  ctx.textAlign = 'right';
  const cycle = (st[42] / TAU) * 360;
  ctx.fillText(`${cycle.toFixed(0).padStart(3, ' ')}° / 720°`, w - 10 * dpr, 18 * dpr);
}

// ---------- Gauges ----------
function niceStep(range, target) {
  const raw = range / target;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / p;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * p;
}

function drawGauge(ctx, cx, cy, r, o) {
  const C = S.colors;
  const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
  const ang = (v) => a0 + (a1 - a0) * Math.max(0, Math.min(1, (v - o.min) / (o.max - o.min)));
  ctx.lineCap = 'butt';
  // base arc
  ctx.strokeStyle = css(mix(C.bg, C.fg, 0.15));
  ctx.lineWidth = r * 0.05;
  ctx.beginPath(); ctx.arc(cx, cy, r * 0.93, a0, a1); ctx.stroke();
  for (const band of o.bands || []) {
    ctx.strokeStyle = css(band.col);
    ctx.lineWidth = r * 0.07;
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.93, ang(band.from), ang(band.to)); ctx.stroke();
  }
  // ticks
  const step = o.step || niceStep(o.max - o.min, 8);
  ctx.fillStyle = css(C.fg);
  ctx.strokeStyle = css(mix(C.bg, C.fg, 0.7));
  ctx.lineWidth = Math.max(1, r * 0.015);
  ctx.font = `${Math.max(9, r * 0.13)}px ui-monospace, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let v = o.min, k = 0; v <= o.max + 1e-9 && k < 60; v += step, ++k) {
    const a = ang(v);
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r * 0.8, cy + Math.sin(a) * r * 0.8);
    ctx.lineTo(cx + Math.cos(a) * r * 0.88, cy + Math.sin(a) * r * 0.88);
    ctx.stroke();
    if (r > 40) {
      const lbl = o.tickLabel ? o.tickLabel(v) : String(Math.round(v * 100) / 100);
      ctx.fillText(lbl, cx + Math.cos(a) * r * 0.66, cy + Math.sin(a) * r * 0.66);
    }
  }
  // needle
  const a = ang(o.value);
  ctx.strokeStyle = css(o.needle || C.pink);
  ctx.lineWidth = Math.max(2, r * 0.035);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx - Math.cos(a) * r * 0.1, cy - Math.sin(a) * r * 0.1);
  ctx.lineTo(cx + Math.cos(a) * r * 0.86, cy + Math.sin(a) * r * 0.86);
  ctx.stroke();
  ctx.fillStyle = css(mix(C.bg, C.fg, 0.3));
  ctx.beginPath(); ctx.arc(cx, cy, r * 0.06, 0, TAU); ctx.fill();
  // readout
  ctx.fillStyle = css(C.fg);
  ctx.font = `bold ${Math.max(11, r * 0.24)}px ui-monospace, monospace`;
  ctx.fillText(o.text, cx, cy + r * 0.42);
  ctx.fillStyle = css(mix(C.bg, C.fg, 0.6));
  ctx.font = `${Math.max(9, r * 0.12)}px ui-monospace, monospace`;
  ctx.fillText(o.label, cx, cy + r * 0.7);
}

function drawGauges() {
  const canvas = $('gauges');
  const { w, h, dpr } = fitCanvas(canvas);
  const ctx = canvas.getContext('2d');
  const C = S.colors;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = css(C.bg);
  ctx.fillRect(0, 0, w, h);
  if (!S.state || !S.info) return;
  const st = S.state, info = S.info;
  const metric = S.metric;

  const redRpm = U.rpm(info.redline);
  const maxRpm = Math.ceil(redRpm * 1.25 / 1000) * 1000;
  const warn = Math.floor(redRpm * 0.9 / 500) * 500;
  const red = Math.ceil(redRpm / 500) * 500;
  const rpm = Math.abs(U.rpm(st[0]));

  // Layout: tach on top, then 2 x 2 small gauges, then readouts.
  const pad = 8 * dpr;
  const tachH = Math.min(w * 0.78, h * 0.42);
  const tachR = tachH / 2 - pad / 2;
  drawGauge(ctx, w / 2, pad + tachR, tachR, {
    min: 0, max: maxRpm, value: rpm, step: maxRpm > 12000 ? 2000 : 1000,
    tickLabel: (v) => String(v / 1000),
    bands: [
      { from: warn, to: red, col: C.orange },
      { from: red, to: maxRpm, col: C.red },
    ],
    text: Math.round(rpm).toString(), label: 'RPM ×1000',
  });

  const speed = metric ? U.kmh(Math.abs(st[1])) : U.mph(Math.abs(st[1]));
  const vac = metric ? U.kPa(st[2]) : -Math.min(0, U.inHg(st[2] - ATM));
  const cfm = U.scfm(st[3]);
  const ve = st[4] * 100;
  const maxCfm = Math.max(50, Math.ceil(U.scfm(0.5 * ATM * info.displacement / (8.314 * 298.15) * redRpm / 60) * 1.3 / 50) * 50);

  const gy = pad + tachH + pad;
  const gh = (h - gy) * 0.62;
  const cw = w / 2, chh = gh / 2;
  const r2 = Math.min(cw, chh) / 2 - pad / 2;
  const small = [
    { min: 0, max: metric ? 300 : 200, value: speed, text: speed.toFixed(0), label: metric ? 'KM/H' : 'MPH' },
    metric
      ? { min: 0, max: 120, value: vac, text: vac.toFixed(0), label: 'MANIFOLD kPa' }
      : { min: 0, max: 30, value: vac, text: vac.toFixed(1), label: 'VACUUM inHg' },
    { min: 0, max: maxCfm, value: cfm, text: cfm.toFixed(0), label: 'INTAKE SCFM', needle: C.blue },
    { min: 0, max: 120, value: ve, text: ve.toFixed(0) + '%', label: 'VOL. EFF.', needle: C.green },
  ];
  small.forEach((g, k) => {
    const col = k % 2, row = Math.floor(k / 2);
    drawGauge(ctx, cw * col + cw / 2, gy + chh * row + chh / 2, r2, g);
  });

  // Readouts
  const ry = gy + gh + pad;
  const torque = metric ? st[5] : U.lbft(st[5]);
  const power = metric ? U.kW(st[6]) : U.hp(st[6]);
  const gear = st[8] < 0 ? 'N' : String(st[8] + 1);
  const afr = st[22];
  const items = [
    ['GEAR', gear, C.fg],
    ['CLUTCH', Math.round(st[10] * 100) + '%', st[10] < 0.5 ? C.orange : C.fg],
    ['THROTTLE', Math.round((1 - st[7]) * 100) + '%', C.fg],
    ['AFR', afr > 0 && afr < 100 ? afr.toFixed(1) : '—', C.fg],
    [metric ? 'TORQUE N·m' : 'TORQUE lb-ft', st[13] > 0 ? torque.toFixed(0) : '—', C.orange],
    [metric ? 'POWER kW' : 'POWER hp', st[13] > 0 ? power.toFixed(0) : '—', C.blue],
    ['DYNO', st[13] > 0 ? (st[14] > 0 ? 'HOLD ' : '') + Math.round(U.rpm(st[15])) : 'OFF', st[13] > 0 ? C.green : C.fg],
    ['FUEL USED', (st[24] * 1000).toFixed(2) + ' L', C.fg],
  ];
  const cols = 2, rows = Math.ceil(items.length / cols);
  const cellW = w / cols, cellH = Math.max(18 * dpr, (h - ry - pad) / rows);
  ctx.textBaseline = 'alphabetic';
  items.forEach(([k, v, col], idx) => {
    const x = (idx % cols) * cellW + pad;
    const y = ry + Math.floor(idx / cols) * cellH;
    ctx.textAlign = 'left';
    ctx.fillStyle = css(mix(C.bg, C.fg, 0.5));
    ctx.font = `${Math.max(9, Math.min(11 * dpr, cellH * 0.28))}px ui-monospace, monospace`;
    ctx.fillText(k, x, y + cellH * 0.36);
    ctx.fillStyle = css(col);
    ctx.font = `bold ${Math.max(11, Math.min(18 * dpr, cellH * 0.46))}px ui-monospace, monospace`;
    ctx.fillText(v, x, y + cellH * 0.86);
  });
}

// ---------- Scope ----------
function drawScope() {
  const canvas = $('scope');
  const { w, h, dpr } = fitCanvas(canvas);
  const ctx = canvas.getContext('2d');
  const C = S.colors;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = css(C.bg);
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = css(mix(C.bg, C.fg, 0.12));
  ctx.lineWidth = 1;
  for (let k = 1; k < 4; ++k) { ctx.beginPath(); ctx.moveTo(0, (h * k) / 4); ctx.lineTo(w, (h * k) / 4); ctx.stroke(); }
  for (let k = 1; k < 8; ++k) { ctx.beginPath(); ctx.moveTo((w * k) / 8, 0); ctx.lineTo((w * k) / 8, h); ctx.stroke(); }
  ctx.font = `${10 * dpr}px ui-monospace, monospace`;

  if (S.scopeTab === 'wave') {
    if (!S.scope) return;
    const d = S.scope;
    ctx.strokeStyle = css(C.pink);
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    for (let i = 0; i < d.length; ++i) {
      const x = (i / (d.length - 1)) * w;
      const y = h / 2 - d[i] * h * 0.45;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.fillStyle = css(mix(C.bg, C.fg, 0.5));
    ctx.fillText('AUDIO OUTPUT  ~93 ms', 6 * dpr, 12 * dpr);
  } else if (S.scopeTab === 'dyno') {
    const info = S.info;
    if (!info) return;
    const maxRpm = Math.ceil(U.rpm(info.redline) * 1.1 / 1000) * 1000;
    const pts = [...S.dynoCurve.entries()].sort((a, b) => a[0] - b[0]);
    const tq = (v) => (S.metric ? v : U.lbft(v));
    const pw = (v) => (S.metric ? U.kW(v) : U.hp(v));
    let maxT = 10, maxP = 10;
    for (const [, v] of pts) { maxT = Math.max(maxT, tq(v.t)); maxP = Math.max(maxP, pw(v.p)); }
    const maxY = Math.max(maxT, maxP) * 1.15;
    const X = (r) => (r / maxRpm) * w, Y = (v) => h - (v / maxY) * h;
    const plot = (fn, col) => {
      ctx.strokeStyle = css(col);
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath();
      pts.forEach(([r, v], i) => (i ? ctx.lineTo(X(r), Y(fn(v))) : ctx.moveTo(X(r), Y(fn(v)))));
      ctx.stroke();
    };
    plot((v) => tq(v.t), C.orange);
    plot((v) => pw(v.p), C.blue);
    ctx.fillStyle = css(mix(C.bg, C.fg, 0.5));
    ctx.textAlign = 'left';
    ctx.fillText(pts.length ? `0 – ${maxRpm} rpm · scale ${maxY.toFixed(0)}` : 'Press D to run the dynamometer sweep', 6 * dpr, 12 * dpr);
    ctx.fillStyle = css(C.orange);
    ctx.textAlign = 'right';
    ctx.fillText(S.metric ? 'TORQUE N·m' : 'TORQUE lb-ft', w - 6 * dpr, 12 * dpr);
    ctx.fillStyle = css(C.blue);
    ctx.fillText(S.metric ? 'POWER kW' : 'POWER hp', w - 6 * dpr, 24 * dpr);
    if (pts.length) {
      let bestT = pts[0], bestP = pts[0];
      for (const p of pts) { if (p[1].t > bestT[1].t) bestT = p; if (p[1].p > bestP[1].p) bestP = p; }
      ctx.fillStyle = css(C.fg);
      ctx.fillText(`peak ${tq(bestT[1].t).toFixed(0)} @ ${bestT[0]}  /  ${pw(bestP[1].p).toFixed(0)} @ ${bestP[0]}`, w - 6 * dpr, 38 * dpr);
    }
  } else {
    if (!S.frame || !S.info) return;
    const info = S.info, f = S.frame;
    const n = info.cylinders.length;
    const base = info.cranks.length * 3;
    const bw = w / n;
    let maxP = 0;
    for (let i = 0; i < n; ++i) maxP = Math.max(maxP, f[base + i * 14 + 9]);
    const topP = Math.max(5 * ATM, maxP);
    S.cylPeak = Math.max((S.cylPeak || 0) * 0.995, topP);
    for (let i = 0; i < n; ++i) {
      const o = base + i * 14;
      const P = f[o + 9], T = f[o + 10], lit = f[o + 6] > 0;
      const ph = Math.min(1, P / S.cylPeak) * (h - 28 * dpr);
      ctx.fillStyle = css(lit ? C.orange : C.pink);
      ctx.fillRect(i * bw + bw * 0.15, h - 14 * dpr - ph, bw * 0.35, ph);
      const th = Math.min(1, Math.max(0, (T - 300) / 2500)) * (h - 28 * dpr);
      ctx.fillStyle = css(C.yellow);
      ctx.fillRect(i * bw + bw * 0.52, h - 14 * dpr - th, bw * 0.3, th);
      ctx.fillStyle = css(mix(C.bg, C.fg, 0.6));
      ctx.textAlign = 'center';
      ctx.fillText(String(i + 1), i * bw + bw / 2, h - 3 * dpr);
    }
    ctx.textAlign = 'left';
    ctx.fillStyle = css(mix(C.bg, C.fg, 0.5));
    ctx.fillText(`CYLINDER PRESSURE (pink, max ${(S.cylPeak / 1e5).toFixed(0)} bar) · GAS TEMP (yellow)`, 6 * dpr, 12 * dpr);
  }
}

// ---------- Input ----------
const HOLD_KEYS = new Set(['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyS', 'Space', 'ShiftLeft', 'ShiftRight', 'KeyT', 'KeyU', 'KeyY',
  'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyG', 'F1', 'F2']);

function toggle(code) {
  const st = S.state;
  if (!st) return;
  switch (code) {
    case 'KeyA': {
      const on = !(st[12] > 0);
      call('es_set_ignition', on ? 1 : 0);
      log(on ? 'IGNITION ENABLED' : 'IGNITION DISABLED');
      break;
    }
    case 'KeyD': {
      const on = !(st[13] > 0);
      if (on) S.dynoCurve.clear();
      call('es_set_dyno', on ? 1 : 0, st[14] > 0 ? 1 : 0);
      log(on ? 'DYNOMOMETER ENABLED' : 'DYNOMOMETER DISABLED');
      break;
    }
    case 'KeyH': {
      const hold = !(st[14] > 0);
      call('es_set_dyno', st[13] > 0 ? 1 : 0, hold ? 1 : 0);
      log(hold ? (st[13] > 0 ? 'HOLD ENABLED' : 'HOLD ON STANDBY [ENABLE DYNO. FOR HOLD]') : 'HOLD DISABLED');
      break;
    }
    case 'ArrowUp': {
      const g = Math.min(st[9] - 1, st[8] + 1);
      call('es_set_gear', g);
      st[8] = g;
      log('UPSHIFTED TO ' + (g + 1));
      break;
    }
    case 'ArrowDown': {
      const g = Math.max(-1, st[8] - 1);
      call('es_set_gear', g);
      st[8] = g;
      log(g >= 0 ? 'DOWNSHIFTED TO ' + (g + 1) : 'SHIFTED TO NEUTRAL');
      break;
    }
    case 'KeyM':
      if (S.layer0 + 1 < st[37]) S.layer0++;
      log('[M] - Set render layer to ' + S.layer0);
      break;
    case 'Comma':
      if (S.layer0 > 0) S.layer0--;
      log('[,] - Set render layer to ' + S.layer0);
      break;
    case 'F3':
      S.displayAngle = 0;
      break;
  }
}

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
  const code = e.code;
  if (['Space', 'ArrowUp', 'ArrowDown', 'F1', 'F2', 'F3'].includes(code) || code.startsWith('Digit')) e.preventDefault();
  if (e.target.type === 'range') e.target.blur();
  if (e.repeat) return;
  if (code === 'Space' && !keys.has('Space')) ctl.fineThrottle = S.state ? S.state[26] : 0;
  keys.add(code);
  if (!HOLD_KEYS.has(code)) toggle(code);
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

window.addEventListener('wheel', (e) => {
  const st = S.state;
  if (!st) return;
  const mods = ['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyG', 'Space'];
  const active = mods.find((k) => keys.has(k));
  if (!active) return;
  e.preventDefault();
  const notches = -Math.sign(e.deltaY);
  const fine = keys.has('Space') && active !== 'Space';
  const k = fine ? 0.1 : 1;
  const clamp = (v) => Math.max(0, Math.min(1, v));
  const audio = (idx, delta, label) => {
    const v = clamp(st[idx] + delta);
    st[idx] = v;
    const args = [-1, -1, -1, -1, -1];
    args[idx - 31] = v;
    call('es_set_audio', ...args);
    log(label + v.toFixed(idx === 33 ? 4 : 3));
  };
  switch (active) {
    case 'KeyZ': audio(31, notches * 0.02 * k, '[Z] - Set volume to '); break;
    case 'KeyX': audio(32, notches * 0.02 * k, '[X] - Set convolution level to '); break;
    case 'KeyC': audio(33, notches * 0.002 * k, '[C] - Set high freq. gain to '); break;
    case 'KeyV': audio(34, notches * 0.02 * k, '[V] - Set low freq. noise to '); break;
    case 'KeyB': audio(35, notches * 0.02 * k, '[B] - Set high freq. noise to '); break;
    case 'KeyN': {
      const v = Math.max(400, Math.min(400000, st[17] + notches * 200 * k));
      st[17] = v;
      call('es_set_sim_frequency', v);
      log('[N] - Set simulation freq to ' + Math.round(v));
      break;
    }
    case 'KeyG':
      if (st[14] > 0 && S.info) {
        const v = Math.max(S.info.dynoMin, Math.min(S.info.dynoMax, st[15] + notches * S.info.dynoStep));
        st[15] = v;
        call('es_set_dyno_speed', v);
        log('[G] - Set dyno speed to ' + Math.round(U.rpm(v)));
      }
      break;
    case 'Space':
      ctl.fineThrottle = clamp(ctl.fineThrottle + notches * 0.012);
      $('throttle').value = Math.round(ctl.fineThrottle * 100);
      break;
  }
}, { passive: false });

function bindHold(id, prop) {
  const el = $(id);
  const on = (e) => { e.preventDefault(); ctl[prop] = true; try { el.setPointerCapture(e.pointerId); } catch (err) { /* synthetic event */ } };
  const off = () => { ctl[prop] = false; };
  el.addEventListener('pointerdown', on);
  el.addEventListener('pointerup', off);
  el.addEventListener('pointercancel', off);
  el.addEventListener('lostpointercapture', off);
}
bindHold('btn-starter', 'starterBtn');
bindHold('btn-clutch', 'clutchBtn');
for (const [id, code] of [['btn-ignition', 'KeyA'], ['btn-dyno', 'KeyD'], ['btn-hold', 'KeyH'], ['btn-gear-up', 'ArrowUp'], ['btn-gear-down', 'ArrowDown']]) {
  $(id).addEventListener('click', () => toggle(code));
}
$('throttle').addEventListener('input', (e) => { ctl.throttleSlider = e.target.value / 100; ctl.fineThrottle = ctl.throttleSlider; });
$('clutch').addEventListener('input', (e) => { ctl.clutchSlider = e.target.value / 100; $('clutch-val').textContent = e.target.value + '%'; });
$('volume').addEventListener('input', (e) => {
  $('volume-val').textContent = e.target.value + '%';
  call('es_set_audio', e.target.value / 100, -1, -1, -1, -1);
});

// Per-frame control update (mirrors EngineSimApplication::processEngineInput)
function updateControls(dt) {
  if (!S.state) return;
  // Throttle
  let t;
  if (keys.has('KeyQ')) t = 0.01;
  else if (keys.has('KeyW')) t = 0.1;
  else if (keys.has('KeyE')) t = 0.2;
  else if (keys.has('KeyR')) t = 1.0;
  else if (keys.has('Space')) t = ctl.fineThrottle;
  else t = ctl.throttleSlider;
  setCtl('throttle', 'es_set_throttle', t);

  setCtl('starter', 'es_set_starter', keys.has('KeyS') || ctl.starterBtn ? 1 : 0);

  // Clutch
  const shift = keys.has('ShiftLeft') || keys.has('ShiftRight') || ctl.clutchBtn;
  if (keys.has('KeyT')) ctl.targetClutch -= 0.2 * dt;
  else if (keys.has('KeyU')) ctl.targetClutch += 0.2 * dt;
  else if (shift) ctl.targetClutch = 0;
  else if (!keys.has('KeyY')) ctl.targetClutch = ctl.clutchSlider;
  ctl.targetClutch = Math.max(0, Math.min(1, ctl.targetClutch));
  const rc = keys.has('Space') ? 1.0 : 0.001;
  setCtl('clutch', 'es_set_clutch', Math.round(ctl.targetClutch * 1000) / 1000, rc);

  // Slow motion
  let speed = 1;
  if (keys.has('Digit1')) speed = 1 / 10;
  else if (keys.has('Digit2')) speed = 1 / 100;
  else if (keys.has('Digit3')) speed = 1 / 200;
  else if (keys.has('Digit4')) speed = 1 / 500;
  else if (keys.has('Digit5')) speed = 1 / 1000;
  setCtl('speed', 'es_set_sim_speed', speed);

  if (keys.has('F1')) S.displayAngle += dt;
  else if (keys.has('F2')) S.displayAngle -= dt;
}

// ---------- UI wiring ----------
$('engine-select').addEventListener('change', (e) => { if (e.target.value !== '__user__') loadEngine(e.target.value); e.target.blur(); });
$('file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  log('Compiling ' + file.name + ' …');
  const sel = $('engine-select');
  let opt = sel.querySelector('option[data-user]');
  if (!opt) { opt = document.createElement('option'); opt.dataset.user = '1'; sel.prepend(opt); }
  opt.value = '__user__';
  opt.textContent = 'Uploaded: ' + file.name;
  sel.value = '__user__';
  S.worker.postMessage({ type: 'loadSource', name: file.name, text });
  e.target.value = '';
});
$('quality-select').addEventListener('change', (e) => {
  const v = e.target.value;
  try { localStorage.setItem('esw-quality', v); } catch (err) { /* no storage */ }
  S.worker.postMessage({ type: 'quality', mode: v === 'auto' ? 'auto' : Number(v) });
  e.target.blur();
});
$('units-btn').addEventListener('click', () => { S.metric = !S.metric; updateUnitsBtn(); });
$('help-btn').addEventListener('click', () => { $('help').hidden = false; });
$('help-close').addEventListener('click', () => { $('help').hidden = true; });
$('help').addEventListener('click', (e) => { if (e.target.id === 'help') $('help').hidden = true; });
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === b));
  S.scopeTab = b.dataset.scope;
}));
$('start-btn').addEventListener('click', async () => {
  $('start-btn').disabled = true;
  try { await startAudio(); }
  catch (e) { log('Audio could not start: ' + e.message, true); }
  S.started = true;
  S.worker.postMessage({ type: 'start' });
  $('start-overlay').style.display = 'none';
});

// ---------- Main loop ----------
let lastFrame = performance.now();
let frameNo = 0;
function loop(now) {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  if (dt > 0) S.fps = S.fps * 0.95 + 0.05 * (1 / dt);
  updateControls(dt);
  // Draw only when new simulation data arrived; panels at half rate; everything at
  // half rate on the low quality levels.
  frameNo++;
  const slow = S.quality.level >= 2;
  if (S.dirty && (!slow || frameNo % 2 === 0)) {
    S.dirty = false;
    drawEngine();
  }
  if (S.panelDirty && frameNo % 2 === 0) { S.panelDirty = false; drawGauges(); drawScope(); }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
boot();
