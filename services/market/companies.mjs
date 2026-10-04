// the companies of the game, in one place.
//
// this file is *data plus character*: the catalog itself (`MARKET_SYMBOLS`) and
// the rules that decide what a readable profile looks like. the simulation that
// uses them lives in engine.mjs, the copy they generate lives in headlines.mjs
// and the numbers behind the model live in tuning.mjs, so nothing has to be
// touched here to change how the market moves — only to change a company.
//
// every company has its own logic. no two behave the same:
//
//   vol        day to day noise (beta is how much of the market mood it takes)
//   alpha      long run drift per game day: the growth path the price is pulled
//              along. positive companies compound, negative ones fade
//   momentum   how slowly an own trend fades (0.9998 = it lasts for days)
//   trendUp    chance that its own trend is upwards
//   trendDays  how long an own trend usually runs
//   trendSize  how big those tend runs are
//   cycleDays  a slow wave of this many game days (0 = none) and its amplitude
//   surprises  average game days between company surprises and their ceiling
//   news       how hard headlines move this name
//   spill      how much of its move it drags into the rest of the sector
//
// so a biotech is a binary lottery, an energy company rides a commodity wave, a
// food company sleeps, and a software company just compounds.
export const MARKET_SYMBOLS = [
  // cíclica: sigue el precio de la energía en olas de cinco semanas y apenas
  // crece a largo plazo
  { sym: 'SOLMK', name: 'Solmark Inc.', sector: 'Energía', price: 230.70, vol: 0.0055, beta: 1.05,
    alpha: -0.0002, momentum: 0.9994, trendUp: 0.52, trendDays: 6, trendSize: 0.75,
    cycleDays: 34, cycleAmp: 0.10, surpriseDays: 26, surpriseMax: 0.28, news: 1.0, spill: 0.30 },
  // crecimiento lento y muy pegajoso: los movimientos duran, las sorpresas casi
  // no existen y el ciclo es larguísimo
  { sym: 'TCED', name: 'TechEdu Inc.', sector: 'Educación', price: 64.30, vol: 0.0075, beta: 1.25,
    alpha: 0.0006, momentum: 0.9998, trendUp: 0.56, trendDays: 8, trendSize: 0.9,
    cycleDays: 60, cycleAmp: 0.06, surpriseDays: 42, surpriseMax: 0.20, news: 0.9, spill: 0.25 },
  // crecimiento de verdad: tendencias frecuentes y hacia arriba, sorpresas
  // regulares
  { sym: 'NORVX', name: 'Norvex Dynamics', sector: 'Robótica', price: 118.40, vol: 0.0065, beta: 1.35,
    alpha: 0.0010, momentum: 0.9997, trendUp: 0.60, trendDays: 7, trendSize: 1.0,
    cycleDays: 45, cycleAmp: 0.05, surpriseDays: 18, surpriseMax: 0.30, news: 1.1, spill: 0.30 },
  // defensiva: poca volatilidad, y su ciclo de tres semanas es el de los tipos
  // de interés. contagia al resto del sector financiero
  { sym: 'BHVN', name: 'Bluehaven Financial', sector: 'Finanzas', price: 88.15, vol: 0.0030, beta: 0.85,
    alpha: 0.0003, momentum: 0.9996, trendUp: 0.54, trendDays: 6, trendSize: 0.55,
    cycleDays: 21, cycleAmp: 0.07, surpriseDays: 40, surpriseMax: 0.18, news: 0.8, spill: 0.45 },
  // consumo básico: la empresa más tranquila de la lista, con estacionalidad de
  // seis semanas
  { sym: 'ORBF', name: 'Orbital Foods Co.', sector: 'Consumo', price: 41.92, vol: 0.0040, beta: 0.70,
    alpha: 0.0002, momentum: 0.9988, trendUp: 0.52, trendDays: 4, trendSize: 0.5,
    cycleDays: 45, cycleAmp: 0.06, surpriseDays: 55, surpriseMax: 0.16, news: 0.6, spill: 0.20 },
  // biotecnología: una lotería. apenas tiene tendencias propias, pero sus
  // sorpresas son enormes y llegan cada dos semanas, y contagian a su sector
  { sym: 'CSCB', name: 'Cascade Biotech', sector: 'Biotecnología', price: 212.55, vol: 0.0110, beta: 1.60,
    alpha: 0.0012, momentum: 0.9992, trendUp: 0.48, trendDays: 4, trendSize: 1.2,
    cycleDays: 0, cycleAmp: 0, surpriseDays: 10, surpriseMax: 0.38, news: 1.5, spill: 0.50 },
  // materiales: pura materia prima, una ola de cuatro semanas muy marcada
  { sym: 'IRPK', name: 'Ironpeak Materials', sector: 'Materiales', price: 56.08, vol: 0.0050, beta: 0.95,
    alpha: 0, momentum: 0.9993, trendUp: 0.50, trendDays: 6, trendSize: 0.8,
    cycleDays: 28, cycleAmp: 0.12, surpriseDays: 30, surpriseMax: 0.26, news: 0.9, spill: 0.35 },
  // automotriz: la más cíclica y volátil después de la biotech, con la ola más
  // amplia de todas
  { sym: 'VLRA', name: 'Velora Motors', sector: 'Automotriz', price: 174.90, vol: 0.0095, beta: 1.45,
    alpha: -0.0003, momentum: 0.9990, trendUp: 0.50, trendDays: 5, trendSize: 1.1,
    cycleDays: 40, cycleAmp: 0.14, surpriseDays: 20, surpriseMax: 0.30, news: 1.2, spill: 0.35 },
  // software: la que más compone a largo plazo y la que más respeta sus
  // tendencias, con un ciclo anual suave
  { sym: 'NMBS', name: 'Nimbus Cloud Systems', sector: 'Software', price: 329.60, vol: 0.0070, beta: 1.20,
    alpha: 0.0016, momentum: 0.9998, trendUp: 0.62, trendDays: 9, trendSize: 1.0,
    cycleDays: 90, cycleAmp: 0.04, surpriseDays: 24, surpriseMax: 0.28, news: 1.3, spill: 0.30 },
  // logística: defensiva, sigue el pulso del consumo con olas de un mes
  { sym: 'HRBL', name: 'Harborline Logistics', sector: 'Logística', price: 73.24, vol: 0.0045, beta: 0.90,
    alpha: 0.0001, momentum: 0.9995, trendUp: 0.53, trendDays: 6, trendSize: 0.65,
    cycleDays: 30, cycleAmp: 0.08, surpriseDays: 45, surpriseMax: 0.20, news: 0.7, spill: 0.35 },
  // cripto-fintech: la más joven y nerviosa de la lista. cuando el humor la
  // acompaña hace x2 en semanas; cuando no, se parte por la mitad. la que más
  // márgenes da y más quita
  { sym: 'ZPHE', name: 'Zephyr Exchange', sector: 'Cripto', price: 96.50, vol: 0.0140, beta: 1.75,
    alpha: 0.0014, momentum: 0.9988, trendUp: 0.54, trendDays: 3, trendSize: 1.6,
    cycleDays: 0, cycleAmp: 0, surpriseDays: 8, surpriseMax: 0.42, news: 1.8, spill: 0.55 },
  // aeroespacial: contratos gubernamentales de años. muy lenta, pero cuando la
  // industria espacial despega en el mercado entero, ella es la que más sube
  { sym: 'ASTR', name: 'Astral Dynamics Corp.', sector: 'Aeroespacial', price: 412.30, vol: 0.0050, beta: 1.10,
    alpha: 0.0009, momentum: 0.9999, trendUp: 0.58, trendDays: 12, trendSize: 0.85,
    cycleDays: 55, cycleAmp: 0.05, surpriseDays: 30, surpriseMax: 0.24, news: 1.0, spill: 0.25 },
  // retail en línea: vive de la estacionalidad del consumo (buena para el "modo
  // calendario": comprar en junio, cobrar en diciembre) y responde fuerte a
  // titulares de consumo
  { sym: 'MYXO', name: 'Myxora Retail Group', sector: 'Consumo', price: 58.75, vol: 0.0060, beta: 1.00,
    alpha: 0.0004, momentum: 0.9990, trendUp: 0.55, trendDays: 5, trendSize: 0.9,
    cycleDays: 26, cycleAmp: 0.11, surpriseDays: 22, surpriseMax: 0.26, news: 1.1, spill: 0.30 },
  // defensa y ciberseguridad: se dispara con noticias de crisis y guerra, y en
  // calma se aburre: el activo "refugio" del juego, la contraparte de la biotech
  { sym: 'KDRA', name: 'Kaidra Defense Systems', sector: 'Defensa', price: 147.20, vol: 0.0040, beta: 0.75,
    alpha: 0.0006, momentum: 0.9996, trendUp: 0.55, trendDays: 7, trendSize: 0.7,
    cycleDays: 35, cycleAmp: 0.05, surpriseDays: 28, surpriseMax: 0.30, news: 1.4, spill: 0.40 },
];

// what a company does when its profile leaves a value out
export const DEFAULT_PROFILE = {
  // per game minute volatility: kept here so the readable profile carries the
  // same number the model uses
  vol: 0.005,
  alpha: 0,
  momentum: 0.9995,
  trendUp: 0.55,
  trendDays: 5,
  trendSize: 1,
  cycleDays: 0,
  cycleAmp: 0,
  surpriseDays: 22,
  surpriseMax: 0.38,
  news: 1,
  spill: 0.3,
};

export function profileFor(sym) {
  const template = MARKET_SYMBOLS.find((entry) => entry.sym === sym);
  const profile = { ...DEFAULT_PROFILE };
  if (!template) return profile;
  for (const key of Object.keys(DEFAULT_PROFILE)) {
    if (isFiniteNumber(template[key])) profile[key] = template[key];
  }
  return profile;
}

// a readable summary of what kind of company this is, so the game can explain
// why two symbols move so differently
const PROFILE_TAGS = [
  ['crecimiento', (p) => p.alpha >= 0.0008],
  ['en declive', (p) => p.alpha < 0],
  ['cíclica', (p) => p.cycleAmp >= 0.09],
  ['volátil', (p) => p.vol >= 0.009],
  ['impredecible', (p) => p.surpriseDays <= 15],
];

export function companyProfile(sym) {
  const template = MARKET_SYMBOLS.find((entry) => entry.sym === sym);
  if (!template) return null;
  const p = profileFor(sym);
  const tags = PROFILE_TAGS.filter(([, matches]) => matches(p)).map(([name]) => name);
  if (!tags.length) tags.push(p.vol <= 0.0045 ? 'defensiva' : 'estable');
  return {
    sym: template.sym,
    name: template.name,
    sector: template.sector,
    kind: tags[0],
    tags,
    growth: round(p.alpha * 100), // percent per game day
    volatility: p.vol,
    beta: template.beta ?? 1,
    cycle: p.cycleDays > 0 && p.cycleAmp > 0
      ? { days: Math.round(p.cycleDays), amplitude: round(p.cycleAmp * 100) }
      : null,
    surpriseDays: Math.round(p.surpriseDays),
    surpriseMax: round(p.surpriseMax * 100),
    newsSensitivity: p.news,
  };
}

export function marketProfiles() {
  return MARKET_SYMBOLS.map((template) => companyProfile(template.sym));
}

// the template a symbol was built from (name, sector, starting price, beta...)
export function symbolTemplate(sym) {
  return MARKET_SYMBOLS.find((entry) => entry.sym === sym) || null;
}

// tiny local helpers: this module is imported by the engine, so it cannot ask
// the engine for them without a circular import
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function round(value) {
  return Math.round(value * 100) / 100;
}
