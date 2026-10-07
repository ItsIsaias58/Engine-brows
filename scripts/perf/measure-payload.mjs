// FASE 0 — medición de tamaños de payload del market (sin tocar el server real)
import {
  createMarketState,
  tickMarketState,
  marketSnapshot,
  liveCandles,
  candlesFor,
  serializeMarketSlim,
} from '../../services/market/engine.mjs';

const bytes = (v) => Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v), 'utf8');
const kb = (n) => (n / 1024).toFixed(1) + ' KiB';

const market = createMarketState();
market.intervalMs = 1000;

// simula 10 minutos de juego (1440x => 10 min reales = 10 game days)
let tickBytes = [];
let realNow = Date.now();
for (let i = 0; i < 600; i++) {
  realNow += 1000;
  const news = tickMarketState(market, () => 0.5, realNow);
  const snapshot = marketSnapshot(market);
  // exactamente lo que server.mjs manda en el tick
  const payload = {
    type: 'tick',
    sequence: market.sequence,
    intervalMs: market.intervalMs,
    gameTime: snapshot.gameTime,
    speed: snapshot.speed,
    quotes: snapshot.quotes,
    regime: snapshot.regime,
    candles: liveCandles(market),
    news,
  };
  tickBytes.push(bytes(payload));
}

const avg = tickBytes.reduce((a, b) => a + b, 0) / tickBytes.length;
const max = Math.max(...tickBytes);
const min = Math.min(...tickBytes);

// snapshot de conexión (lo que manda el open())
const snapMsg = {
  type: 'snapshot',
  snapshot: marketSnapshot(market),
  candles: liveCandles(market),
  tape: market.tape,
};

// histórico de velas 5m: ventana completa (una sola vez por empresa)
const full5m = candlesFor(market, market.symbols[0].sym, '5m', 5760, 0);
// gap típico: pide sólo lo nuevo (unos pocos barras)
const gap5m = candlesFor(market, market.symbols[0].sym, '5m', 5760, full5m.windowStart + 5 * 60 * 1000);

const slim = serializeMarketSlim(market);

console.log(JSON.stringify({
  symbols: market.symbols.length,
  tick: { avgBytes: Math.round(avg), min, max, avgKiB: kb(Math.round(avg)), perMinKiB: kb(Math.round(avg * 60)) },
  tick_per_client_per_sec_kib: +(avg / 1024).toFixed(2),
  snapshotBytes: bytes(snapMsg),
  snapshotKiB: kb(bytes(snapMsg)),
  candles_full_5m_bytes: bytes(full5m),
  candles_full_5m_KiB: kb(bytes(full5m)),
  candles_full_5m_bars: full5m.candles.length,
  candles_gap_5m_bytes: bytes(gap5m),
  candles_gap_5m_bars: gap5m.candles.length,
  marketJson_bytes: bytes(slim),
  marketJson_KiB: kb(bytes(slim)),
  quotesOnlyBytes: bytes(snapshot_quotes_only(market)),
}, null, 2));

function snapshot_quotes_only(m) {
  return marketSnapshot(m).quotes;
}
