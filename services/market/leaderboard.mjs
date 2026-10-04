// ranking del servidor. no guarda una tabla: la calcula cuando se la piden, con
// las carteras que ya tiene guardadas cada cuenta y los precios vivos del
// mercado, así que nunca queda desincronizada.
//
// los filtros temporales salen de una muestra de patrimonio por día de juego
// (`netHistory`), tomada cuando la cuenta guarda su cartera. sin muestras
// suficientes el periodo se evalúa contra lo que haya, y el histórico siempre
// contra el efectivo inicial.
import { GAME_DAY_MS, marketQuotes } from './engine.mjs';
import { START_CASH } from './accounts.mjs';
import { portfolioTradingValue } from './valuation.mjs';

export const LEADERBOARD_METRICS = ['net', 'roi', 'winrate', 'best', 'streak'];
export const LEADERBOARD_PERIODS = { all: null, today: 0, week: 7, month: 30 };
export const METRIC_KEYS = {
  net: 'net',
  roi: 'roi',
  winrate: 'winrate',
  best: 'best',
  streak: 'streak',
};

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function createLeaderboard(options) {
  const market = options.market;
  const accounts = options.accounts;

  function gameDay() {
    return Math.floor(market.gameTime / GAME_DAY_MS);
  }

  function priceMap() {
    const map = new Map();
    for (const quote of marketQuotes(market)) map.set(quote.sym, quote.price);
    return map;
  }

  // what a stored portfolio is worth to the ranking: cash plus every position at
  // the live quote. the bank is deliberately NOT in here, so a stored rank does
  // not move; the "patrimonio" the player sees in their profile does include it,
  // and that number comes from valuation.mjs.
  function netOf(portfolio, prices) {
    return portfolioTradingValue(portfolio, (sym) => prices.get(sym));
  }

  // one sample per game day: the first save of a new day records where the
  // player started it, which is what the period filters compare against
  function recordSample(account) {
    if (!account || !account.portfolio) return false;
    const day = gameDay();
    if (!Array.isArray(account.netHistory)) account.netHistory = [];
    const last = account.netHistory[account.netHistory.length - 1];
    if (last && last.d === day) return false;
    account.netHistory.push({ d: day, net: round(netOf(account.portfolio, priceMap())) });
    if (account.netHistory.length > 90) account.netHistory.splice(0, account.netHistory.length - 90);
    return true;
  }

  // the net worth the period is measured from
  function baseNet(account, days) {
    const history = Array.isArray(account.netHistory) ? account.netHistory : [];
    if (!history.length) return START_CASH;
    if (days === null) return START_CASH;
    const cutoff = gameDay() - days;
    let pick = null;
    for (const sample of history) {
      if (sample.d <= cutoff) pick = sample;
      else break;
    }
    return (pick || history[0]).net;
  }

  function valueFor(account, metric, net, base) {
    const stats = (account.portfolio && account.portfolio.stats) || {};
    switch (metric) {
      case 'roi': {
        const reference = base > 0 ? base : START_CASH;
        return round(((net - reference) / reference) * 100);
      }
      case 'winrate': {
        const total = Number(stats.totalTrades) || 0;
        return total ? round((Number(stats.wins) || 0) / total * 100, 1) : 0;
      }
      case 'best':
        return round(Number(stats.bestTrade) || 0);
      case 'streak':
        return Math.round(Number(stats.bestStreak) || 0);
      default:
        return round(net);
    }
  }

  function snapshot(request = {}) {
    const metric = LEADERBOARD_METRICS.includes(request.metric) ? request.metric : 'net';
    const period = Object.prototype.hasOwnProperty.call(LEADERBOARD_PERIODS, request.period)
      ? request.period : 'all';
    const limit = Math.min(Math.max(Number(request.limit) || 100, 1), 500);
    const days = LEADERBOARD_PERIODS[period];
    const viewerKey = request.viewer ? String(request.viewer.name || '').toLowerCase() : '';
    const prices = priceMap();
    const day = gameDay();

    const entries = [];
    let me = null;

    for (const account of Object.values(accounts.accounts || {})) {
      const key = String(account.name || '').toLowerCase();
      const isViewer = viewerKey && key === viewerKey;
      const profile = account.profile || {};
      // a private profile still plays, it just does not show up for others
      if (profile.privacy === 'private' && !isViewer) continue;

      const history = Array.isArray(account.netHistory) ? account.netHistory : [];
      const lastSample = history.length ? history[history.length - 1].d : null;
      // a period is about who was around for it: an account whose last sample is
      // older than the window is not part of that ranking
      if (days !== null && lastSample !== null && day - lastSample > days) continue;

      const net = netOf(account.portfolio || {}, prices);
      const base = baseNet(account, days);
      const stats = (account.portfolio && account.portfolio.stats) || {};
      const entry = {
        id: account.id,
        name: account.name,
        you: isViewer,
        net: round(net),
        roi: valueFor(account, 'roi', net, base),
        winrate: valueFor(account, 'winrate', net, base),
        best: valueFor(account, 'best', net, base),
        streak: valueFor(account, 'streak', net, base),
        level: Math.round(Number((account.portfolio || {}).level) || 1),
        bankrupt: (account.portfolio || {}).bankrupt === true,
        trades: Number(stats.totalTrades) || 0,
        avatar: profile.avatar || null,
        avatarColor: Number.isFinite(profile.avatarColor) ? profile.avatarColor : 0,
        title: profile.title || null,
        // the period's own number, handy for the "gap to the next rank" line
        periodBase: round(base),
      };
      entries.push(entry);
      if (isViewer) me = entry;
    }

    entries.sort((left, right) => {
      const diff = (right[metric] || 0) - (left[metric] || 0);
      if (diff !== 0) return diff;
      return String(left.name).localeCompare(String(right.name));
    });
    entries.forEach((entry, index) => { entry.rank = index + 1; });

    return {
      metric,
      period,
      updatedAt: Date.now(),
      total: entries.length,
      entries: entries.slice(0, limit),
      me: me ? { ...me, total: entries.length } : null,
    };
  }

  return { snapshot, recordSample, netOf, gameDay };
}
