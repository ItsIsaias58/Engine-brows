// eventos encadenados del lado del servidor. una cadena es una historia con
// pasos: un rumor que sube, una confirmación que sube más y una investigación
// que lo tira todo. se dispara cada pocos minutos reales, aplica cada paso al
// motor (los precios los mueve el servidor, no cada cliente) y lo emite por el
// websocket para que todos vean la misma secuencia.
//
// el cliente también sabe pintar estas cadenas (js/events.js): aquí sólo se
// decide *qué* pasa y *cuándo*.
import { adminNudge, adminPublishNews } from './engine.mjs';

export const EVENT_MIN_MS = 3 * 60 * 1000;
export const EVENT_MAX_MS = 15 * 60 * 1000;
const CHECK_EVERY_MS = 2000;

function pick(list, random) {
  return list[Math.floor(random() * list.length)];
}

export function createEventEngine(options = {}) {
  const market = options.market;
  const broadcast = options.broadcast ?? (() => {});
  const random = options.random ?? Math.random;

  const timers = new Set();
  let checkTimer = null;
  let nextAt = 0;
  let stopped = false;
  let active = null;

  function symbols() {
    return market.symbols;
  }

  function sectorOf(sector) {
    return symbols().filter((symbol) => symbol.sector === sector).map((symbol) => symbol.sym);
  }

  // the catalog of stories. each `build` resolves its own cast, so a chain never
  // happens to the same company twice in a row by accident
  const chains = {
    pump_dump: {
      weight: 10,
      label: 'Pump & Dump',
      build() {
        const cheap = symbols().filter((symbol) => symbol.price < 150);
        const symbol = pick(cheap.length ? cheap : symbols(), random);
        return {
          sym: symbol.sym,
          name: symbol.name,
          tone: 'up',
          steps: [
            { t: 0, pct: 6, tone: 'up', title: `📣 Rumor: fondos institucionales interesados en ${symbol.name}` },
            { t: 180, pct: 8, tone: 'up', title: `📈 ${symbol.name} firma un acuerdo millonario` },
            { t: 420, pct: -25, tone: 'down', title: `⚠️ El regulador investiga a ${symbol.name}` },
            { t: 600, pct: -5, tone: 'down', title: `📉 Pánico vendedor en ${symbol.name}` },
          ],
        };
      },
    },

    sector_fire: {
      weight: 8,
      label: 'Sector en llamas',
      build() {
        const sectors = [...new Set(symbols().map((symbol) => symbol.sector))];
        const sector = pick(sectors, random);
        const syms = sectorOf(sector);
        return {
          sym: syms[0],
          name: `Sector ${sector}`,
          sector,
          tone: 'up',
          allSyms: syms,
          steps: [
            { t: 0, pct: 6, tone: 'up', title: `🔥 El sector ${sector} se enciende: varias empresas suben juntas` },
            { t: 120, pct: 4, tone: 'up', title: `📊 Los analistas recomiendan el sector ${sector}` },
            { t: 480, pct: -30, tone: 'down', title: `💥 Estalla la burbuja del sector ${sector}` },
          ],
        };
      },
    },

    earnings: {
      weight: 6,
      label: 'Resultados',
      build() {
        const symbol = pick(symbols(), random);
        const beat = random() < 0.6;
        return {
          sym: symbol.sym,
          name: symbol.name,
          tone: beat ? 'up' : 'down',
          steps: [
            { t: 0, pct: 0, tone: 'gold', title: `🗓️ ${symbol.name} reporta resultados en un minuto` },
            { t: 60, pct: beat ? 15 : -18, tone: beat ? 'up' : 'down',
              title: beat ? `💰 Beat: ${symbol.name} supera lo esperado` : `💔 Miss: ${symbol.name} decepciona al mercado` },
          ],
        };
      },
    },

    whale: {
      weight: 5,
      label: 'Ballena',
      build() {
        const symbol = pick(symbols(), random);
        return {
          sym: symbol.sym,
          name: symbol.name,
          tone: 'up',
          steps: [
            { t: 0, pct: 12, tone: 'up', title: `🐋 Una ballena compra una posición enorme en ${symbol.name}` },
            { t: 240, pct: -8, tone: 'down', title: `🐋 La ballena liquida su posición en ${symbol.name}` },
          ],
        };
      },
    },

    black_swan: {
      weight: 2,
      label: 'Cisne negro',
      build() {
        return {
          sym: symbols()[0].sym,
          name: 'Mercado global',
          tone: 'down',
          allSyms: symbols().map((symbol) => symbol.sym),
          steps: [
            { t: 0, pct: -15, tone: 'down', title: '🌍 Crisis geopolítica: el mercado se desploma' },
            { t: 600, pct: 8, tone: 'up', title: '🕊️ Rebote parcial tras la crisis' },
          ],
        };
      },
    },
  };

  function pickChain() {
    const ids = Object.keys(chains);
    const total = ids.reduce((sum, id) => sum + chains[id].weight, 0);
    let roll = random() * total;
    for (const id of ids) {
      roll -= chains[id].weight;
      if (roll <= 0) return id;
    }
    return ids[0];
  }

  // applies one step: the primary symbol prints the headline, every other symbol
  // in the chain just takes the move (a sector story is one title, not four)
  function applyStep(instance, step) {
    const primary = instance.sym;
    if (step.pct !== 0 || !instance.allSyms) {
      adminPublishNews(market, primary, step.pct || 0, step.title);
    } else {
      adminPublishNews(market, primary, 0, step.title);
    }
    for (const sym of instance.allSyms || []) {
      if (sym === primary) continue;
      adminNudge(market, sym, step.pct || 0);
    }
    broadcast({
      type: 'event-step',
      chainId: instance.chainId,
      step: { sym: primary, title: step.title, pct: step.pct || 0, tone: step.tone || 'gold' },
    });
  }

  function fire(chainId) {
    const id = chainId && chains[chainId] ? chainId : pickChain();
    const chain = chains[id];
    const built = chain.build();
    const instance = {
      chainId: id,
      label: chain.label,
      sym: built.sym,
      name: built.name,
      tone: built.tone,
      allSyms: built.allSyms,
      sector: built.sector,
      steps: built.steps,
      startedAt: Date.now(),
    };

    // the first step lands immediately, the rest are timed
    applyStep(instance, built.steps[0]);
    active = instance;

    const timed = built.steps.slice(1);
    // contador de pasos diferidos por completar (se comparte entre los timers
    // que sí corrieron y los que la pausa dejó pendientes)
    instance.pending = timed.length;
    timed.forEach((step) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (stopped) return;
        // a frozen market should not be quietly shocked: defer this step
        if (market.paused) {
          pendingSteps.push({ instance, step });
          return;
        }
        applyStep(instance, step);
        instance.pending -= 1;
        if (instance.pending <= 0) {
          active = null;
          scheduleNext();
        }
      }, step.t * 1000);
      timer.unref?.();
      timers.add(timer);
    });

    broadcast({ type: 'event-chain', chainId: id, chain: { ...instance } });
    if (built.steps.length === 1) {
      active = null;
      scheduleNext();
    }
    return instance;
  }

  function scheduleNext() {
    nextAt = Date.now() + EVENT_MIN_MS + random() * (EVENT_MAX_MS - EVENT_MIN_MS);
  }

  // pasos diferidos de una cadena activa (los setTimeout de fire()): mientras el
  // reloj está congelado la historia NO avanza — si no, el impacto del paso pega
  // igual y el mercado "saltó solo" durante la pausa
  const pendingSteps = [];

  function due() {
    if (stopped || market.paused) return false;
    if (active) return false;
    if (!nextAt) scheduleNext();
    return Date.now() >= nextAt;
  }

  return {
    chains,
    get active() { return active; },
    get nextAt() { return nextAt; },
    fire,
    due,
    scheduleNext,
    // a trade makes the next story arrive sooner, so a busy market feels busier
    heat() {
      nextAt = Math.min(nextAt || Infinity, Date.now() + 30000);
    },
    start() {
      if (stopped || checkTimer) return;
      scheduleNext();
      checkTimer = setInterval(() => {
        // pasos que quedaron en el aire por una pausa: se aplican al reanudar
        if (!market.paused && pendingSteps.length) {
          const pending = pendingSteps.splice(0);
          for (const { instance, step } of pending) {
            if (stopped) break;
            applyStep(instance, step);
            instance.pending -= 1;
            if (instance.pending <= 0) {
              active = null;
              scheduleNext();
            }
          }
        }
        if (!due()) return;
        fire();
      }, CHECK_EVERY_MS);
      checkTimer.unref?.();
    },
    stop() {
      stopped = true;
      if (checkTimer) clearInterval(checkTimer);
      checkTimer = null;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      active = null;
    },
  };
}
