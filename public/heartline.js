// "The line that forgets" — a heartbeat trace that the visitor drives.
// Left of the relay slit it is an analog body signal, inside the slit it vanishes,
// right of it it becomes quantized data for the AI and is forgotten even faster.
(() => {
  "use strict";
  const canvas = document.querySelector("[data-heartline]");
  if (!canvas || !canvas.getContext) { document.documentElement.classList.add("no-canvas"); return; }
  const ctx = canvas.getContext("2d");
  const scope = canvas.closest("[data-scope]");
  const relayEl = document.querySelector("[data-relay]");
  const hintEl = document.querySelector("[data-hint]");
  const out = {
    bpm: document.querySelector("[data-bpm]"),
    transit: document.querySelector("[data-transit]"),
    forgotten: document.querySelector("[data-forgotten]"),
  };
  const motionOK = window.matchMedia("(prefers-reduced-motion: no-preference)");

  // ── tuning ────────────────────────────────────────────────────────────
  const SIM_HZ = 600;               // signal sample rate
  const DT = 1 / SIM_HZ;
  const TAU_ANALOG = 0.55;          // s, how long the body signal lingers
  const TAU_DIGITAL = 0.2;          // s, the AI side forgets faster
  const CAP = 4096;                 // ring buffer
  const BYTES_PER_BEAT = 184;       // one reading ≈ a small JSON object
  const PULSE = [255, 92, 72];
  const AMBER = [255, 196, 120];
  const REST_BPM = 58, MAX_BPM = 138;

  // P, Q, R, S, T as gaussians over one beat: [centre, amplitude, width]
  const WAVES = [
    [0.12, 0.11, 0.022],
    [0.232, -0.11, 0.008],
    [0.255, 1.0, 0.0105],
    [0.278, -0.27, 0.0095],
    [0.48, 0.25, 0.04],
  ];
  const ecg = (p) => {
    let v = 0;
    for (let i = 0; i < WAVES.length; i++) {
      const d = p - WAVES[i][0], w = WAVES[i][2];
      v += WAVES[i][1] * Math.exp(-(d * d) / (2 * w * w));
    }
    return v;
  };
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

  // ── ring buffer of samples ────────────────────────────────────────────
  const bx = new Float32Array(CAP), by = new Float32Array(CAP), bt = new Float64Array(CAP), bk = new Uint8Array(CAP);
  let head = 0, size = 0;
  const push = (x, y, t, brk) => {
    bx[head] = x; by[head] = y; bt[head] = t; bk[head] = brk;
    head = (head + 1) % CAP; if (size < CAP) size++;
  };

  // ── geometry ──────────────────────────────────────────────────────────
  let W = 0, H = 0, dpr = 1, x0 = 0, x1 = 0, slitX = 0, slitHalf = 10, midY = 0, ampPx = 0, speed = 400;
  function layout() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = canvas.getBoundingClientRect();
    W = Math.max(1, r.width); H = Math.max(1, r.height);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const narrow = W < 700;
    x0 = narrow ? 16 : W * 0.07;
    x1 = narrow ? W - 16 : W * 0.93;
    slitX = W / 2; slitHalf = narrow ? 8 : 11;
    midY = H * 0.6; ampPx = H * (narrow ? 0.36 : 0.4);
    speed = clamp((x1 - x0) / 2.5, 200, 520);
    size = 0; hx = x0;
  }

  // ── state ─────────────────────────────────────────────────────────────
  let simT = 0, phase = 0.62, hx = 0, bpm = 62, targetBpm = 62, amp = 1, targetAmp = 1;
  let prevPhase = phase, speedS = 0, lastInput = -1e9, lastX = null, lastY = null, lastT = 0;
  let forgottenBytes = 0, slitGlow = 0, phoneGlow = 0, aiGlow = 0, stillMode = false;

  function onPointer(e) {
    const now = performance.now();
    if (lastX !== null) {
      const dt = Math.max(8, now - lastT) / 1000;
      const v = Math.min(Math.hypot(e.clientX - lastX, e.clientY - lastY) / dt, 6000);
      speedS += (v - speedS) * Math.min(1, dt * 5);
    }
    lastX = e.clientX; lastY = e.clientY; lastT = now; lastInput = now;
    const r = scope.getBoundingClientRect();
    targetAmp = 1.35 - 0.7 * clamp((e.clientY - r.top) / r.height, 0, 1); // higher cursor → taller spikes
  }

  function step() {
    simT += DT;
    prevPhase = phase;
    phase += (bpm / 60) * DT;
    if (phase >= 1) phase -= 1;
    // R-peak crossing: who is holding the beat right now?
    if (prevPhase < 0.255 && phase >= 0.255) {
      if (hx < slitX - slitHalf) phoneGlow = 1;
      else if (hx > slitX + slitHalf) { aiGlow = 1; forgottenBytes += BYTES_PER_BEAT; }
      else slitGlow = 1;
    }
    let brk = 0;
    hx += speed * DT;
    if (hx > x1) { hx = x0; brk = 1; }
    const wander = Math.sin(simT * 0.7) * 1.6 + Math.sin(simT * 2.3) * 0.5;
    const y = midY - ampPx * amp * ecg(phase) + wander + (Math.random() - 0.5) * 0.5;
    push(hx, y, simT, brk);
  }

  function steer(dt, nowMs) {
    speedS *= Math.exp(-dt * 2.2);
    if (nowMs - lastInput > 4500) {
      // ghost input: a calm, slightly wandering resting pulse
      targetBpm = 62 + 5 * Math.sin(simT * 0.31) + 3 * Math.sin(simT * 0.83);
      targetAmp = 1 + 0.12 * Math.sin(simT * 0.47);
    } else {
      targetBpm = REST_BPM + (MAX_BPM - REST_BPM) * clamp(speedS / 2400, 0, 1);
    }
    const tau = targetBpm > bpm ? 0.5 : 4; // fast to rise, slow to calm down
    bpm += (targetBpm - bpm) * (1 - Math.exp(-dt / tau));
    amp += (targetAmp - amp) * (1 - Math.exp(-dt / 0.35));
    slitGlow *= Math.exp(-dt * 4); phoneGlow *= Math.exp(-dt * 5); aiGlow *= Math.exp(-dt * 5);
  }

  // ── drawing ───────────────────────────────────────────────────────────
  function drawRails() {
    ctx.save();
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 6]);
    ctx.strokeStyle = "rgba(237,230,218,0.08)";
    ctx.beginPath();
    ctx.moveTo(x0, midY); ctx.lineTo(slitX - slitHalf - 6, midY);
    ctx.moveTo(slitX + slitHalf + 6, midY); ctx.lineTo(x1, midY);
    ctx.stroke();
    ctx.setLineDash([]);
    // the relay slit
    const top = midY - ampPx * 1.25, bot = midY + ampPx * 0.55;
    const g = ctx.createLinearGradient(0, top, 0, bot);
    g.addColorStop(0, "rgba(237,230,218,0)");
    g.addColorStop(0.5, `rgba(237,230,218,${0.2 + slitGlow * 0.5})`);
    g.addColorStop(1, "rgba(237,230,218,0)");
    ctx.strokeStyle = g;
    ctx.beginPath();
    ctx.moveTo(slitX - slitHalf, top); ctx.lineTo(slitX - slitHalf, bot);
    ctx.moveTo(slitX + slitHalf, top); ctx.lineTo(slitX + slitHalf, bot);
    ctx.stroke();
    if (slitGlow > 0.01) {
      const f = ctx.createLinearGradient(slitX - slitHalf, 0, slitX + slitHalf, 0);
      f.addColorStop(0, rgba(PULSE, 0.22 * slitGlow));
      f.addColorStop(1, rgba(AMBER, 0.22 * slitGlow));
      ctx.fillStyle = f;
      ctx.fillRect(slitX - slitHalf, top + (bot - top) * 0.25, slitHalf * 2, (bot - top) * 0.5);
    }
    // endpoints
    node(x0, PULSE, phoneGlow);
    node(x1, AMBER, aiGlow);
    ctx.restore();
  }
  function node(x, col, glow) {
    ctx.fillStyle = rgba(col, 0.35 + glow * 0.65);
    ctx.beginPath(); ctx.arc(x, midY, 2.5 + glow * 1.5, 0, Math.PI * 2); ctx.fill();
    if (glow > 0.02) {
      ctx.strokeStyle = rgba(col, glow * 0.5);
      ctx.beginPath(); ctx.arc(x, midY, 6 + (1 - glow) * 14, 0, Math.PI * 2); ctx.stroke();
    }
  }

  function render() {
    ctx.clearRect(0, 0, W, H);
    drawRails();
    if (size < 2) return;
    const now = simT;
    // walk back from the newest sample to the oldest one still visible
    // (a still frame shows exactly one sweep at full strength)
    const maxAge = stillMode ? (x1 - x0) / speed : TAU_ANALOG * 4.6;
    let n = 0, i = (head - 1 + CAP) % CAP;
    while (n < size && now - bt[i] < maxAge) { n++; i = (i - 1 + CAP) % CAP; }
    const start = (i + 1) % CAP;
    const ageOf = (p) => (stillMode ? 0 : now - bt[p]);
    const leftEdge = slitX - slitHalf, rightEdge = slitX + slitHalf;

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round"; ctx.lineJoin = "round";

    // analog pass: the body signal, clipped to the phone side
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, leftEdge, H); ctx.clip();
    const SEG = 8;
    for (let k = 0; k < n - 1; k += SEG) {
      const a = (start + k) % CAP, b = (start + Math.min(k + SEG, n - 1)) % CAP;
      if (bx[a] > leftEdge && bx[b] >= bx[a]) continue; // whole segment is past the slit
      const age = ageOf((start + Math.min(k + SEG / 2, n - 1)) % CAP);
      const alpha = Math.exp(-age / TAU_ANALOG);
      if (alpha < 0.012) continue;
      ctx.beginPath();
      let started = false;
      for (let j = k; j <= Math.min(k + SEG, n - 1); j++) {
        const p = (start + j) % CAP;
        if (!started || bk[p]) { ctx.moveTo(bx[p], by[p]); started = true; } else ctx.lineTo(bx[p], by[p]);
      }
      ctx.strokeStyle = rgba(PULSE, alpha * 0.12); ctx.lineWidth = 8; ctx.stroke();
      ctx.strokeStyle = rgba(PULSE, Math.min(1, alpha * 1.1)); ctx.lineWidth = 2; ctx.stroke();
    }
    ctx.restore();

    // digital pass: quantized samples on the AI side, forgotten fast
    const cell = 7, qy = 3;
    let lastCell = -1;
    for (let k = 0; k < n; k++) {
      const p = (start + k) % CAP;
      if (bx[p] <= rightEdge + 2) { lastCell = -1; continue; }
      const c = Math.floor(bx[p] / cell);
      if (c === lastCell) continue;
      lastCell = c;
      const alpha = stillMode ? 0.45 : Math.exp(-ageOf(p) / TAU_DIGITAL);
      if (alpha < 0.02) continue;
      ctx.fillStyle = rgba(AMBER, alpha * 0.9);
      ctx.fillRect(c * cell, Math.round(by[p] / qy) * qy - 1, 2.4, 2.4);
    }

    // the beam head
    const hp = (head - 1 + CAP) % CAP;
    const hxNow = bx[hp], hyNow = by[hp];
    if (hxNow < leftEdge || hxNow > rightEdge) {
      const col = hxNow < leftEdge ? PULSE : AMBER;
      const r = hxNow < leftEdge ? 30 : 18;
      const g = ctx.createRadialGradient(hxNow, hyNow, 0, hxNow, hyNow, r);
      g.addColorStop(0, rgba(col, 0.55)); g.addColorStop(1, rgba(col, 0));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(hxNow, hyNow, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "rgba(255,240,228,0.95)";
      ctx.beginPath(); ctx.arc(hxNow, hyNow, 1.8, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  // ── readout ───────────────────────────────────────────────────────────
  let lastReadout = 0;
  function readout(nowMs) {
    if (nowMs - lastReadout < 200) return;
    lastReadout = nowMs;
    if (out.bpm) out.bpm.textContent = Math.round(bpm);
    if (out.transit) out.transit.textContent = ((bpm / 60) * BYTES_PER_BEAT / 1000).toFixed(2);
    if (out.forgotten) out.forgotten.textContent = (forgottenBytes / 1000).toFixed(1);
    if (relayEl) relayEl.classList.toggle("is-hot", slitGlow > 0.3);
  }

  // ── loop ──────────────────────────────────────────────────────────────
  let raf = 0, lastFrame = 0, acc = 0, visible = true, running = false;
  function frame(ts) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (ts - lastFrame) / 1000 || 0);
    lastFrame = ts;
    steer(dt, performance.now());
    acc += dt;
    while (acc >= DT) { step(); acc -= DT; }
    render();
    readout(performance.now());
  }
  function start() {
    if (running || !visible || document.hidden || !motionOK.matches) return;
    running = true; lastFrame = performance.now(); acc = 0;
    raf = requestAnimationFrame(frame);
  }
  function stop() { running = false; cancelAnimationFrame(raf); }

  // a still frame for reduced motion: one sweep, frozen just before the end
  function still() {
    stop(); stillMode = true; layout();
    const n = Math.floor(((x1 - x0) / speed) * SIM_HZ * 0.97);
    for (let i = 0; i < n; i++) step();
    render();
  }

  function init() {
    stillMode = false;
    layout();
    if (motionOK.matches) {
      // prime the buffer so the first frame is already alive
      for (let i = 0; i < SIM_HZ * 0.8; i++) step();
      start();
    } else still();
  }

  window.addEventListener("pointermove", onPointer, { passive: true });
  window.addEventListener("pointerdown", onPointer, { passive: true });
  // only a real size change re-lays out (mobile URL-bar scrolls fire resize without one)
  let lastW = 0, lastH = 0;
  new ResizeObserver(() => {
    const r = canvas.getBoundingClientRect();
    if (Math.abs(r.width - lastW) < 1 && Math.abs(r.height - lastH) < 1) return;
    lastW = r.width; lastH = r.height;
    if (stillMode) still(); else layout();
  }).observe(canvas);
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
  motionOK.addEventListener?.("change", () => { stop(); init(); });
  new IntersectionObserver((entries) => {
    visible = entries[0].isIntersecting;
    visible ? start() : stop();
  }).observe(scope);

  // hint: appears once, fades a few seconds after the visitor starts playing
  let hideTimer = 0;
  setTimeout(() => { if (hintEl && motionOK.matches) hintEl.classList.add("is-on"); }, 1600);
  window.addEventListener("pointermove", () => {
    if (hintEl && hintEl.classList.contains("is-on") && !hideTimer) {
      hideTimer = setTimeout(() => hintEl.classList.remove("is-on"), 3200);
    }
  }, { passive: true });

  init();
})();
