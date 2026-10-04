// importa los assets REALES de CS:GO para opencase: baja las fotos de las
// skins de nuestras cajas y de las cajas mismas desde la API comunitaria
// ByMykel/CSGO-API (los mismos renders que usa el Steam Market), las guarda
// en services/market/public/csgo-opencase/img/ y escribe assets.json con el
// mapa nombre -> ruta local.
//
// cadena de matcheo por skin: nombre exacto -> nombre normalizado sin
// acentos -> foto del mismo modelo de arma (render real del mismo modelo) ->
// nada (el cliente cae al arte SVG procedural).
//
// uso: bun scripts/fetch-csgo-assets.mjs [--force]
//   idempotente: si assets.json existe y todas las fotos están en disco, no
//   hace nada. --force re-descarga (útil tras añadir skins nuevas).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "services/market/public/csgo-opencase/img");
const OUT_JSON = path.join(OUT_DIR, "assets.json");
const API = "https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en";

// espejo de los items de skins.mjs (sin importar el server: script standalone)
const CASES = {
  barrio: {
    milspec:    ['M249 | Warbird', 'FAMAS | Survivor Z', 'MAG-7 | Sonar', 'Sawed-Off | Lunar Wyrm', 'AWP | Acheron'],
    restricted: ["CZ75-Auto | Tigris", 'Tec-9 | Avalanche', 'Desert Eagle | Naga', 'MP7 | Ocean Foam'],
    classified: ['SCAR-20 | Bloodsport', 'AK-47 | Nouveau Rouge', "P250 | Apep's Curse"],
    covert:     ["AWP | Man-o'-war", 'AK-47 | Neon Revolution'],
    gold:       ['★ M9 Bayonet | Blue Steel', '★ Flip Knife | Urban Masked', '★ Karambit | Freehand'],
  },
  comp: {
    milspec:    ['PP-Bizon | Jungle Slipstream', 'Galil AR | Tuxedo', 'CZ75-Auto | Vendetta', 'P250 | Black & Tan', 'MP5-SD | Gold Leaf'],
    restricted: ['PP-Bizon | Fuel Rod', 'USP-S | Flashback', 'Dual Berettas | Hydro Strike', 'Glock-18 | Block-18'],
    classified: ['UMP-45 | Fade', 'Tec-9 | Fuel Injector', 'SG 553 | Cyrex'],
    covert:     ['AK-47 | Nightwish', 'M4A4 | Temukau'],
    gold:       ['★ Survival Knife | Tiger Tooth', '★ Stiletto Knife | Night Stripe', '★ Kukri Knife | Night Stripe'],
  },
  cartera: {
    milspec:    ['Galil AR | Destroyer', 'AWP | Black Nile', 'P250 | Small Game', 'Dual Berettas | Elite 1.6', 'P2000 | Turf'],
    restricted: ['P250 | Nevermore', 'FAMAS | ZX Spectron', 'UMP-45 | Plastique', 'Dual Berettas | Sweet Little Angels'],
    classified: ['SCAR-20 | Cyrex', 'P2000 | Imperial Dragon', 'Sawed-Off | Kiss♥Love'],
    covert:     ['USP-S | Printstream', "M4A1-S | Chantico's Fire"],
    gold:       ['★ Stiletto Knife | Blue Steel', '★ Bowie Knife | Boreal Forest', '★ Stiletto Knife'],
  },
};

const slug = (s) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

async function downloadTo(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`foto ${res.status}: ${url}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

// cadena: exacto -> normalizado sin acentos -> mismo modelo de arma
function findPhoto(name, byName, byNorm, firstByWeapon) {
  const exact = byName.get(name);
  if (exact?.image) return { src: exact.image, kind: "exacta" };
  const fuzzy = byNorm.get(norm(name));
  if (fuzzy?.image) return { src: fuzzy.image, kind: "normalizada" };
  const weapon = name.includes(" | ") ? name.split(" | ")[0].trim() : name.replace("★ ", "").trim();
  const model = firstByWeapon.get(weapon);
  if (model) return { src: model, kind: "modelo" };
  return null;
}

async function main() {
  const force = process.argv.includes("--force");
  fs.mkdirSync(path.join(OUT_DIR, "skins"), { recursive: true });
  fs.mkdirSync(path.join(OUT_DIR, "crates"), { recursive: true });

  if (!force && fs.existsSync(OUT_JSON)) {
    const prev = JSON.parse(fs.readFileSync(OUT_JSON, "utf8"));
    const files = [...Object.values(prev.images || {}), ...Object.values(prev.crates || {})];
    if (files.length && files.every((p) => fs.existsSync(path.join(OUT_DIR, p.replace("img/", ""))))) {
      console.log(`assets.json completo (${files.length} fotos) — nada que hacer (usa --force para re-bajar)`);
      return;
    }
  }

  console.log("bajando índices (skins.json 5.5MB incluye cuchillos ★ + crates.json)…");
  const [skins, crates] = await Promise.all([
    getJson(`${API}/skins.json`),
    getJson(`${API}/crates.json`),
  ]);

  const byName = new Map();
  const byNorm = new Map();
  const firstByWeapon = new Map(); // una foto por modelo de arma (fallback)
  for (const s of skins) {
    if (!s.name || !s.image) continue;
    byName.set(s.name, s);
    if (!byNorm.has(norm(s.name))) byNorm.set(norm(s.name), s);
    const weapon = s.name.includes(" | ") ? s.name.split(" | ")[0].trim() : s.name.replace("★ ", "").trim();
    if (!firstByWeapon.has(weapon)) firstByWeapon.set(weapon, s.image);
  }

  const images = {};
  let exact = 0, vanilla = 0, missing = [];

  // 1) fotos de skins
  const wanted = [...new Set(Object.values(CASES).flatMap((c) => Object.values(c).flat()))];
  for (const name of wanted) {
    const hit = findPhoto(name, byName, byNorm, firstByWeapon);
    if (!hit) { missing.push(name); continue; }
    if (hit.kind === "exacta") exact += 1; else vanilla += 1;
    const dest = `img/skins/${slug(name)}.webp`;
    images[name] = dest;
    const file = path.join(OUT_DIR, dest.replace("img/", ""));
    if (!force && fs.existsSync(file)) continue;
    await downloadTo(hit.src, file);
    console.log(`  ✓ ${name} (${hit.kind})`);
  }

  // 2) fotos de cajas: nombres custom sin match — una foto genérica por caja
  const cratesMap = {};
  const realCases = crates.filter((c) => c.image && /case|capsule|package/i.test(c.name || ""));
  const caseIds = Object.keys(CASES);
  for (let i = 0; i < caseIds.length; i += 1) {
    const pool = realCases.filter((_, j) => j % caseIds.length === i); // distintas entre sí
    const pick = pool[0] || realCases[i] || crates[i];
    if (!pick?.image) continue;
    const dest = `img/crates/${caseIds[i]}.webp`;
    const file = path.join(OUT_DIR, dest.replace("img/", ""));
    if (!force && fs.existsSync(file)) { cratesMap[caseIds[i]] = dest; continue; }
    // la entrada se anota SOLO tras descargar: si la entrada se escribia antes, una
    // descarga fallida dejaba assets.json declarando una foto inexistente y el
    // cliente pintaba el icono de imagen rota (pasó con barrio.webp)
    await downloadTo(pick.image, file);
    if (!fs.existsSync(file)) {
      console.log(`  ✗ caja ${caseIds[i]}: la descarga no produjo archivo — sin foto, el cliente usa el SVG`);
      continue;
    }
    cratesMap[caseIds[i]] = dest;
    console.log(`  ✓ caja ${caseIds[i]} <- ${pick.name}`);
  }

  fs.writeFileSync(OUT_JSON, JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: "https://github.com/ByMykel/CSGO-API",
    note: "mapa nombre -> foto local; sin entrada = SVG procedural en el cliente",
    images, crates: cratesMap,
  }, null, 2));

  console.log(`\nlisto: ${exact} exactas + ${vanilla} vanilla, ${Object.keys(cratesMap).length} cajas, ${missing.length} sin foto (SVG)`);
  if (missing.length) console.log("sin foto:", missing.join(", "));
}

main().catch((e) => { console.error(e); process.exit(1); });
