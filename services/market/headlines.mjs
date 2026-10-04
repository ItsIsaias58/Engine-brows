// the copy of the market: the areas a company invests in, the headline
// templates and the small builders that turn a 0..1 pick into a printed title.
//
// the engine never writes headline text itself, and it never spends a random
// draw on picking one: it passes the value it already has (a hash or a roll it
// made for something else) and these builders index the templates with it. so
// rearranging or translating the copy cannot change how the market behaves.

// headlines are deliberately rare: about one per week of game time
export const NEWS_AVERAGE_GAME_DAYS = 7;
export const NEWS_CHANCE_PER_STEP = 1 / (NEWS_AVERAGE_GAME_DAYS * 24 * 60);

export const NEWS_AREAS = [
  'nueva tecnología',
  'inteligencia artificial',
  'expansión internacional',
  'modernización de su infraestructura',
  'investigación y desarrollo',
  'energía limpia',
  'automatización de sus plantas',
  'una nueva planta de producción',
];

export const NEWS_UP_TITLES = [
  (name, area, amount) => `${name} sorprende al mercado con un plan de ${area} de $${amount}M`,
  (name, area, amount) => `Los resultados de ${name} superan lo esperado: $${amount}M para ${area}`,
  (name, area, amount) => `${name} cierra un acuerdo de ${area} por $${amount}M`,
  (name, area, amount) => `Los inversores premian a ${name} por su apuesta de ${area} ($${amount}M)`,
];

export const NEWS_DOWN_TITLES = [
  (name, area, amount) => `Preocupación en ${name}: su plan de ${area} de $${amount}M no convence`,
  (name, area, amount) => `${name} decepciona con $${amount}M gastados en ${area}`,
  (name, area, amount) => `${name} retrasa su proyecto de ${area} de $${amount}M`,
  (name, area, amount) => `Los analistas recortan a ${name} tras $${amount}M en ${area}`,
];

export const SURPRISE_UP_TITLES = [
  (name) => `${name} dispara: resultados muy por encima de lo esperado`,
  (name) => `Rumor de opa sobre ${name}: el mercado corre a comprar`,
  (name) => `${name} revisa al alza su previsión anual`,
];

export const SURPRISE_DOWN_TITLES = [
  (name) => `${name} se hunde tras unos resultados decepcionantes`,
  (name) => `Investigación sobre ${name}: los inversores salen en estampida`,
  (name) => `${name} recorta su previsión anual y arrastra al sector`,
];

// ---- builders --------------------------------------------------------------

// all of them take an already computed 0..1 value, so text never costs a draw
export function newsArea(pick) {
  const index = Math.floor(pick * NEWS_AREAS.length);
  return NEWS_AREAS[index] || NEWS_AREAS[0];
}

export function newsHeadline(name, area, amount, pct, pick) {
  const templates = pct >= 0 ? NEWS_UP_TITLES : NEWS_DOWN_TITLES;
  const template = templates[Math.floor(pick * templates.length)] || templates[0];
  return template(name, area, amount);
}

export function surpriseHeadline(name, up, pick) {
  const templates = up ? SURPRISE_UP_TITLES : SURPRISE_DOWN_TITLES;
  const template = templates[Math.floor(pick * templates.length)] || templates[0];
  return template(name);
}
