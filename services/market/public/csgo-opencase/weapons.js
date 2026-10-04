// opencase — arte procedural de armas. cada skin se dibuja como SVG inline:
// silueta por tipo de arma + gradiente derivado de la rareza y del patrón
// (hash determinista: la misma skin SE VEE igual siempre), rayas de desgaste
// según el wear y contador naranja si es StatTrak. sin archivos ni redes:
// todo se genera en el cliente.
//
// el simulador CS:GO original no trae assets (su DB sembraba URLs de Steam
// Market), así que este módulo es la fuente de verdad visual del juego.

(() => {
  "use strict";

  // hash FNV-1a: mismo nombre -> mismos colores, siempre
  function hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i += 1) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  let seq = 0;

  const WEAR_SCRATCHES = { FN: 0, MW: 2, FT: 4, WW: 6, BS: 9 };

  function hsl(h, s, l) { return `hsl(${h} ${s}% ${l}%)`; }

  // paleta del patrón: matiz estable por nombre de skin, saturado por rareza
  function palette(item) {
    const name = item.item || item.name || "?";
    const rarity = item.color || "#4b69ff";
    const h = hash(name);
    const hue = h % 360;
    const sat = 55 + (h % 35);
    return {
      a: hsl(hue, sat, 46),          // acento principal del patrón
      b: hsl((hue + 40) % 360, sat - 10, 30), // secundario
      dark: hsl(hue, 30, 12),        // cuerpo base
      edge: hsl(hue, 20, 60),        // brillo de filo/detalle
      rarity,
    };
  }

  // ------------------------------------------------------------ siluetas
  // todas en viewBox 0 0 200 100, mirando a la derecha
  const SHAPES = {
    rifle: {
      body: "M12 52 L36 52 40 44 70 44 76 36 104 36 108 42 152 42 152 50 188 50 188 56 150 56 146 62 124 62 120 74 110 74 106 62 82 62 78 70 66 70 62 60 36 60 24 66 12 60 Z",
      extra: "M104 62 C 100 80 92 90 80 94 L 96 97 C 108 90 114 76 116 62 Z",
      detail: ["M84 40 L104 40 104 44 84 44 Z", "M156 46 L182 46 182 50 156 50 Z"],
    },
    sniper: {
      body: "M6 54 L40 54 46 46 82 46 88 40 124 40 130 46 194 46 194 52 152 52 148 60 116 60 112 66 98 66 94 58 58 58 50 66 32 66 26 58 10 58 Z",
      extra: "M66 30 L108 30 108 40 66 40 Z M72 26 L76 26 76 30 72 30 Z M98 26 L102 26 102 30 98 30 Z",
      detail: ["M134 48 L188 48 188 51 134 51 Z"],
    },
    smg: {
      body: "M36 50 L58 50 62 42 122 42 124 50 170 50 170 56 130 56 126 62 104 62 100 76 88 76 86 62 64 62 58 70 44 70 40 58 30 58 Z",
      extra: "M70 62 L84 62 80 88 68 88 Z",
      detail: ["M128 46 L164 46 164 50 128 50 Z"],
    },
    shotgun: {
      body: "M10 50 L46 50 52 44 92 44 94 50 192 50 192 56 118 56 114 64 94 64 90 56 58 56 52 64 32 64 26 56 10 56 Z",
      extra: "M98 58 L124 58 122 70 100 70 Z",
      detail: ["M126 47 L188 47 188 51 126 51 Z"],
    },
    heavy: {
      body: "M26 44 L58 44 64 34 132 34 134 44 182 44 182 52 150 52 146 62 118 62 114 72 100 72 98 62 68 62 64 68 44 68 40 56 26 56 Z",
      extra: "M60 62 C 62 76 58 88 50 94 L 66 96 C 74 88 76 74 76 62 Z",
      detail: ["M138 40 L176 40 176 46 138 46 Z"],
    },
    pistol: {
      body: "M96 40 L188 40 188 52 148 52 146 58 130 58 128 52 96 52 Z",
      extra: "M148 52 L170 52 160 88 140 88 Z",
      detail: ["M138 58 L146 58 144 66 137 66 Z"],
    },
    knife: {
      body: "M28 56 C 70 26 130 18 178 34 C 138 40 96 50 62 64 Z",
      extra: "M26 54 L48 58 44 72 20 66 Z M40 62 C 52 66 60 70 64 76 L 52 80 C 46 74 40 70 34 68 Z",
      detail: ["M52 50 C 88 34 128 28 158 32"],
    },
    zeus: {
      body: "M60 40 L150 40 150 64 60 64 Z",
      extra: "M150 44 L192 40 192 48 150 50 Z M150 56 L192 58 192 66 150 62 Z",
      detail: ["M70 46 L140 46 140 58 70 58 Z"],
    },
  };

  function shapeFor(name) {
    const n = name.toLowerCase();
    if (n.includes("★") || n.includes("bayoneta") || n.includes("karambit") || n.includes("mariposa") || n.includes("talon") || n.includes("skeleton") || n.includes("kukri")) return SHAPES.knife;
    if (n.includes("awp") || n.includes("ssg") || n.includes("scar-20") || n.includes("g3sg1")) return SHAPES.sniper;
    if (n.includes("nova") || n.includes("xm1014") || n.includes("mag-7") || n.includes("sawed")) return SHAPES.shotgun;
    if (n.includes("negev") || n.includes("m249")) return SHAPES.heavy;
    if (n.includes("zeus")) return SHAPES.zeus;
    if (n.includes("ak-47") || n.includes("m4a4") || n.includes("m4a1") || n.includes("galil") || n.includes("famas") || n.includes("aug") || n.includes("sg 553")) return SHAPES.rifle;
    if (n.includes("mp9") || n.includes("mp7") || n.includes("mac-10") || n.includes("ump-45") || n.includes("pp-bizon") || n.includes("p90")) return SHAPES.smg;
    return SHAPES.pistol; // deagle, glock, usp, p250, p2000, r8, tec-9, five-seven...
  }

  // rayas de desgaste: más wear = más rayas claras sobre el patrón
  function scratches(shape, count, seedStr) {
    if (!count) return "";
    const h = hash(seedStr);
    let out = "";
    for (let i = 0; i < count; i += 1) {
      const x = 40 + ((h >> (i * 3)) % 120);
      const y = 40 + ((h >> (i * 2 + 1)) % 30);
      const len = 6 + ((h >> i) % 14);
      out += `<line x1="${x}" y1="${y}" x2="${x + len}" y2="${y + 3}" stroke="rgba(255,255,255,.16)" stroke-width="1.4" stroke-linecap="round"/>`;
    }
    return out;
  }

  // dibuja el arma completa; `small` simplifica detalles para la ruleta
  function weaponSvg(item, opts = {}) {
    const name = item.item || item.name || "?";
    const shape = shapeFor(name);
    const pal = palette(item);
    const id = `w${(seq += 1)}`;
    const wear = WEAR_SCRATCHES[item.wear] != null ? WEAR_SCRATCHES[item.wear] : 3;
    const grad = opts.mono
      ? `${pal.a};${pal.dark}`
      : `${pal.b};${pal.a};${pal.dark}`;
    const st = item.stattrak
      ? `<g><rect x="8" y="8" rx="3" width="30" height="14" fill="#cf6a32"/><text x="23" y="19" text-anchor="middle" font-size="10" font-weight="800" fill="#fff" font-family="monospace">ST</text></g>`
      : "";
    return `
      <svg class="wpn ${item.stattrak ? "is-st" : ""}" viewBox="0 0 200 100" role="img" aria-label="${name}">
        <defs>
          <linearGradient id="${id}g" x1="0" y1="0" x2="1" y2="0.25">
            <stop offset="0" stop-color="${grad.split(";")[0]}"/>
            <stop offset="0.45" stop-color="${grad.split(";")[1]}"/>
            <stop offset="1" stop-color="${grad.split(";")[2] || grad.split(";")[1]}"/>
          </linearGradient>
          <linearGradient id="${id}d" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="${pal.dark}"/>
            <stop offset="1" stop-color="#05070b"/>
          </linearGradient>
        </defs>
        <g>
          <path d="${shape.body}" fill="url(#${id}g)" stroke="rgba(0,0,0,.55)" stroke-width="1.6"/>
          <path d="${shape.extra}" fill="url(#${id}d)" stroke="rgba(0,0,0,.55)" stroke-width="1.4"/>
          ${(shape.detail || []).map((d) => `<path d="${d}" fill="${pal.edge}" opacity=".5"/>`).join("")}
          <path d="${shape.body}" fill="none" stroke="${pal.rarity}" stroke-width="1" opacity=".65"/>
          ${scratches(shape, wear, name)}
        </g>
        ${st}
      </svg>`;
  }

  // caja dibujada (reemplaza al emoji) con el color de la caja
  function crateSvg(color) {
    const id = `c${(seq += 1)}`;
    return `
      <svg class="crate" viewBox="0 0 120 100" role="img" aria-label="caja">
        <defs>
          <linearGradient id="${id}g" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="${color}" stop-opacity=".95"/>
            <stop offset="1" stop-color="#0d1320"/>
          </linearGradient>
        </defs>
        <rect x="14" y="26" width="92" height="62" rx="7" fill="url(#${id}g)" stroke="rgba(0,0,0,.6)" stroke-width="2"/>
        <rect x="14" y="20" width="92" height="14" rx="5" fill="${color}" stroke="rgba(0,0,0,.6)" stroke-width="2"/>
        <rect x="50" y="40" width="20" height="16" rx="3" fill="#0a0e15" opacity=".85"/>
        <path d="M14 44 L106 44" stroke="rgba(255,255,255,.18)" stroke-width="1.5"/>
        <path d="M20 88 L36 68 M100 88 L84 68" stroke="rgba(255,255,255,.10)" stroke-width="3"/>
      </svg>`;
  }

  window.OpenCaseArt = { weaponSvg, crateSvg };
})();
