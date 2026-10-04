// opencase — efectos de revelado estilo CS:GO: destello por rareza, partículas
// que caen del item, rayos para cuchillos (gold), sacudida de pantalla y
// confeti para legendarios. todo canvas/DOM local, sin librerías.

(() => {
  "use strict";

  const TIER_GLOW = {
    milspec: "#4b69ff", restricted: "#8847ff", classified: "#d32ce6",
    covert: "#eb4b4b", gold: "#ffd700", contraband: "#e4ae39",
  };

  let fxLayer = null;
  let shakeWrap = null;

  function ensureLayer() {
    if (fxLayer && document.body.contains(fxLayer)) return fxLayer;
    fxLayer = document.createElement("div");
    fxLayer.id = "fxLayer";
    fxLayer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:70;overflow:hidden";
    document.body.appendChild(fxLayer);
    return fxLayer;
  }

  function ensureShake() {
    if (shakeWrap && document.body.contains(shakeWrap)) return shakeWrap;
    shakeWrap = document.createElement("div");
    shakeWrap.id = "shakeWrap";
    while (document.body.firstChild) shakeWrap.appendChild(document.body.firstChild);
    document.body.appendChild(shakeWrap);
    return shakeWrap;
  }

  const glowFor = (rarity) => TIER_GLOW[rarity] || "#8aa0b4";

  // ----------------------------------------------------------- screen shake
  function shake(intensity = 10, ms = 450) {
    const el = ensureShake();
    const t0 = performance.now();
    (function frame(now) {
      const p = (now - t0) / ms;
      if (p >= 1) { el.style.transform = ""; return; }
      const k = (1 - p) * intensity;
      el.style.transform = `translate(${(Math.random() * 2 - 1) * k}px, ${(Math.random() * 2 - 1) * k}px)`;
      requestAnimationFrame(frame);
    })(performance.now());
  }

  // ----------------------------------------------------------- flash de rareza
  function flash(color) {
    const layer = ensureLayer();
    const el = document.createElement("div");
    el.style.cssText = `position:absolute;inset:0;background:${color};opacity:0;transition:opacity .12s`;
    layer.appendChild(el);
    requestAnimationFrame(() => { el.style.opacity = "0.28"; });
    setTimeout(() => { el.style.opacity = "0"; setTimeout(() => el.remove(), 260); }, 150);
  }

  // ----------------------------------------------------------- partículas del item
  // cuadraditos del color de la rareza que caen y giran desde el box
  function burst(boxEl, color, count = 26) {
    const layer = ensureLayer();
    const r = boxEl.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    for (let i = 0; i < count; i += 1) {
      const p = document.createElement("div");
      const size = 5 + Math.random() * 8;
      p.style.cssText = `position:absolute;left:${cx}px;top:${cy}px;width:${size}px;height:${size}px;background:${color};border-radius:2px;opacity:.95;box-shadow:0 0 ${size}px ${color}`;
      layer.appendChild(p);
      const ang = Math.random() * Math.PI * 2;
      const vel = 90 + Math.random() * 260;
      const dx = Math.cos(ang) * vel;
      const dy = Math.sin(ang) * vel - 140;
      const rot = (Math.random() * 2 - 1) * 720;
      const dur = 900 + Math.random() * 900;
      const t0 = performance.now();
      requestAnimationFrame(function frame(now) {
        const t = (now - t0) / dur;
        if (t >= 1) { p.remove(); return; }
        const x = cx + dx * t;
        const y = cy + dy * t + 460 * t * t; // gravedad
        p.style.transform = `translate(${x - cx}px, ${y - cy}px) rotate(${rot * t}deg)`;
        p.style.opacity = String(1 - t);
        requestAnimationFrame(frame);
      });
    }
  }

  // ----------------------------------------------------------- rayos (cuchillos / gold)
  function rays(color, ms = 1400) {
    const layer = ensureLayer();
    const host = document.createElement("div");
    host.style.cssText = `position:absolute;inset:0;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity .3s`;
    const rays = [];
    for (let i = 0; i < 12; i += 1) {
      const ray = document.createElement("div");
      ray.style.cssText = `position:absolute;width:2px;height:130vmax;background:linear-gradient(to top, transparent, ${color}, transparent);opacity:.5;transform:rotate(${i * 30}deg)`;
      rays.push(ray);
      host.appendChild(ray);
    }
    layer.appendChild(host);
    requestAnimationFrame(() => { host.style.opacity = "1"; });
    const t0 = performance.now();
    (function spin(now) {
      const p = (now - t0) / ms;
      if (p >= 1) { host.style.opacity = "0"; setTimeout(() => host.remove(), 350); return; }
      host.style.transform = `rotate(${p * 60}deg)`;
      requestAnimationFrame(spin);
    })(performance.now());
  }

  // ----------------------------------------------------------- confeti
  function confetti(ms = 2600) {
    const layer = ensureLayer();
    const colors = ["#ffd700", "#eb4b4b", "#d32ce6", "#4b69ff", "#29e0a8", "#f2b84b"];
    const W = window.innerWidth;
    for (let i = 0; i < 130; i += 1) {
      const p = document.createElement("div");
      const w = 6 + Math.random() * 7;
      const h = w * (0.5 + Math.random());
      const x = Math.random() * W;
      const y = -30 - Math.random() * 200;
      const fall = 2.2 + Math.random() * 2.6;
      const sway = 40 + Math.random() * 90;
      const phase = Math.random() * Math.PI * 2;
      const spin = (Math.random() * 2 - 1) * 900;
      const col = colors[i % colors.length];
      p.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;background:${col};border-radius:1px`;
      layer.appendChild(p);
      const t0 = performance.now();
      requestAnimationFrame(function frame(now) {
        const t = (now - t0) / (ms * 1.6);
        if (t >= 1) { p.remove(); return; }
        const yy = y + fall * t * 900;
        p.style.transform = `translate(${Math.sin(t * 6 + phase) * sway * t}px, ${yy - y}px) rotate(${spin * t}deg)`;
        p.style.opacity = t > 0.85 ? String(1 - (t - 0.85) / 0.15) : "1";
        if (yy < window.innerHeight + 40) requestAnimationFrame(frame);
        else p.remove();
      });
    }
    setTimeout(() => { /* cleanup pass */ layer.querySelectorAll("div").forEach((d) => { if (!d.isConnected) d.remove(); }); }, ms * 2);
  }

  // ----------------------------------------------------------- API pública
  // level: 0 normal, 1 raro (classified), 2 covert, 3 gold/knife
  window.OpenCaseFX = {
    reveal(item, boxEl) {
      const color = glowFor(item.rarity);
      const level = item.rarity === "gold" ? 3
        : item.rarity === "covert" ? 2
        : item.rarity === "classified" ? 1 : 0;
      if (level >= 1) flash(color);
      if (level >= 1 && boxEl) burst(boxEl, color, 20 + level * 12);
      if (level >= 2) shake(8 + level * 4, 400 + level * 120);
      if (level === 3) { rays(color); confetti(); }
      return level;
    },
    spinStart() { shake(3, 260); },
  };
})();
