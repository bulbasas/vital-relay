// Page behaviours: the tap-your-pulse ritual, a living ledger, the waitlist form.
(() => {
  "use strict";
  const motionOK = window.matchMedia("(prefers-reduced-motion: no-preference)");

  // ── Tap your pulse: everything stays in this tab ─────────────────────────
  const btn = document.querySelector("[data-tap-btn]");
  const num = document.querySelector("[data-tap-num]");
  const help = document.querySelector("[data-tap-help]");
  const reply = document.querySelector("[data-tap-reply]");
  if (btn && num && help && reply) {
    let taps = [];
    let phase = "idle"; // idle → tapping → sent
    let ghost = 0;

    const median = (xs) => {
      const s = [...xs].sort((a, b) => a - b);
      const m = s.length >> 1;
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    };
    const beat = () => {
      btn.classList.remove("is-beat");
      void btn.offsetWidth; // restart the CSS animation
      btn.classList.add("is-beat");
    };
    const word = (w) => { num.textContent = w; num.classList.add("is-word"); };
    const digits = (d) => { num.textContent = d; num.classList.remove("is-word", "is-dissolving"); };
    const verdict = (bpm) =>
      bpm < 50 ? "Athlete-low. Calm and efficient."
      : bpm < 90 ? "A resting rate. Nothing to worry about."
      : bpm < 110 ? "A little elevated — coffee, stairs or excitement?"
      : "That’s fast. Just ran up the stairs?";

    // a ghost taps at 64 bpm until someone takes over
    const startGhost = () => {
      if (!motionOK.matches) return;
      stopGhost();
      ghost = setInterval(() => { if (phase === "idle") beat(); }, 938);
    };
    const stopGhost = () => clearInterval(ghost);

    const send = (bpm) => {
      phase = "sent";
      help.textContent = "Sending through the tunnel…";
      setTimeout(() => {
        reply.innerHTML = "";
        const line = document.createElement("span");
        line.textContent = `AI › ${bpm} bpm. ${verdict(bpm)} Received, used, forgotten.`;
        reply.append(line);
        help.textContent = " ";
      }, 700);
      setTimeout(() => {
        num.classList.add("is-dissolving");
        const gone = document.createElement("span");
        gone.className = "gone";
        gone.textContent = "  stored: 0 B";
        reply.append(document.createElement("br"), gone);
      }, 3400);
      setTimeout(() => {
        phase = "idle";
        taps = [];
        word("again");
        num.classList.remove("is-dissolving");
        help.textContent = "Tap the circle (or press Space) with each beat.";
      }, 5200);
    };

    const tap = () => {
      if (phase === "sent") return;
      stopGhost();
      const now = performance.now();
      if (taps.length && now - taps[taps.length - 1] > 2200) taps = []; // a pause starts over
      taps.push(now);
      phase = "tapping";
      beat();
      if (taps.length === 1) { reply.textContent = ""; word("…"); help.textContent = "Keep going."; return; }
      const intervals = taps.slice(-7).slice(1).map((t, i, arr) => t - taps.slice(-7)[i]);
      const bpm = Math.round(60000 / median(intervals));
      if (bpm < 30 || bpm > 220) { digits("?"); help.textContent = "Find a steady rhythm."; return; }
      digits(String(bpm));
      if (taps.length >= 7) send(bpm);
      else help.textContent = `${7 - taps.length} more…`;
    };

    btn.addEventListener("pointerdown", (e) => { e.preventDefault(); tap(); });
    btn.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); tap(); } });
    document.addEventListener("keydown", (e) => {
      if (e.code !== "Space" || e.repeat) return;
      const r = btn.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight) return; // only when the circle is on screen
      if (/^(INPUT|TEXTAREA|SELECT|BUTTON|SUMMARY)$/.test(document.activeElement?.tagName ?? "") && document.activeElement !== btn) return;
      e.preventDefault();
      tap();
    });
    startGhost();
  }

  // ── Ledger: new receipts keep arriving while it is on screen ─────────────
  const ledger = document.querySelector("[data-ledger]");
  if (ledger && motionOK.matches) {
    const feed = [
      ["Claude", "health_overview(today)", "1 day · summary · 2.3 kB"],
      ["Cursor", "get_metric_series(steps, 30d)", "30 days · daily totals · 1.1 kB"],
      ["Claude", "get_sleep(7 nights)", "7 nights · stages · 4.0 kB"],
      ["ChatGPT", "list_workouts(14 days)", "6 workouts · summary · 2.6 kB"],
      ["Claude", "define_metric(readiness)", "approved on phone · 0.4 kB"],
      ["ChatGPT", "get_metric_series(heart_rate, raw)", "denied · raw data not shared", true],
    ];
    let i = 0, n = 0x4f5, timer = 0;
    const add = () => {
      const [who, call, out, deny] = feed[i++ % feed.length];
      const li = document.createElement("li");
      if (deny) li.className = "deny";
      li.classList.add("is-new");
      const parts = [
        ["time", new Date().toTimeString().slice(0, 8)],
        ["b", who],
        ["code", call],
        ["span", out, "out"],
        ["span", `#${(n++).toString(16)}`, "rc"],
      ];
      for (const [tag, text, cls] of parts) {
        const el = document.createElement(tag);
        el.textContent = text;
        if (cls) el.className = cls;
        li.append(el);
      }
      ledger.prepend(li);
      while (ledger.children.length > 4) ledger.lastElementChild.remove();
    };
    new IntersectionObserver((entries) => {
      clearInterval(timer);
      if (entries[0].isIntersecting) timer = setInterval(add, 3200);
    }, { threshold: 0.4 }).observe(ledger);
  }

  // ── Waitlist ─────────────────────────────────────────────────────────────
  const form = document.querySelector("[data-waitlist]");
  const msg = document.querySelector("[data-wl-msg]");
  if (form && msg) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(form));
      const button = form.querySelector("button");
      msg.className = "form-msg";
      if (!form.email.checkValidity()) {
        msg.textContent = "That email doesn’t look right.";
        msg.classList.add("err");
        return;
      }
      button.disabled = true;
      msg.textContent = "Sending…";
      try {
        const res = await fetch("/api/waitlist", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: data.email, website: data.website }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || "Something went wrong — try again.");
        msg.textContent = "You’re on the list. That email is the only thing we stored.";
        msg.classList.add("ok");
        form.reset();
      } catch (err) {
        msg.textContent = err.message;
        msg.classList.add("err");
      } finally {
        button.disabled = false;
      }
    });
  }
})();
