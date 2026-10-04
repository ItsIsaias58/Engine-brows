// sonidos del juego, sintetizados aquí mismo: no se carga ningún archivo, todo
// es osciladores, envolventes y ruido filtrado sobre la Web Audio API.
//
// la misma función `build` construye el sonido para el altavoz y para un
// OfflineAudioContext, que es como los tests comprueban que de verdad suena
// (miden la señal renderizada: que no esté en silencio, que no recorte y que la
// altura suba o baje donde debe).
const SOUND_KEY = 'bolsa-sound-v1';
const ATTACK = 0.0001; // el valor mínimo que acepta una rampa exponencial

// cada sonido pertenece a una categoría con su propio volumen: lo que el
// jugador baja en ajustes afecta a toda la familia, no a un efecto suelto
const SOUND_CATEGORIES = {
  click: 'ui', tick: 'games', spinStart: 'games', buy: 'ui', sell: 'ui',
  profit: 'ui', loss: 'ui', win: 'games', jackpot: 'games', levelup: 'ui',
  achievement: 'ui', event: 'market', alarm: 'market', notify: 'market', alert: 'market',
  card: 'games', cashIn: 'ui',
  pollOpen: 'market', pollVote: 'ui', pollWin: 'market', pollLose: 'market', marketPulse: 'market',
  // nuevos: rechazo de orden (ui), cierre de posición (ui), abrir/cerrar
  // paneles (ui), volver la conexión (market), dinero enviado (ui)
  error: 'ui', close: 'ui', hover: 'ui', open: 'ui',
  reconnect: 'market', transfer: 'ui',
};

// pushNotification suena 'notify' por sí sola. cuando el mismo flujo ya puso
// otro sonido más expresivo (profit, loss, alert...), esta bandera evita el
// segundo disparo: el jugador oye un jingle, no dos pegados.
let suppressNotifyOnce = false;
function suppressNextNotify() { suppressNotifyOnce = true; }

// una nota: oscilador + envolvente, con barrido opcional de frecuencia
function voice(ctx, out, { freq, to, type = 'sine', at = 0, dur = 0.1, gain = 0.1 }) {
  const osc = ctx.createOscillator();
  const envelope = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(Math.max(20, freq), at);
  if (to && to !== freq) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), at + dur);
  envelope.gain.setValueAtTime(ATTACK, at);
  envelope.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), at + Math.min(0.02, dur * 0.3));
  envelope.gain.exponentialRampToValueAtTime(ATTACK, at + dur);
  osc.connect(envelope);
  envelope.connect(out);
  osc.start(at);
  osc.stop(at + dur + 0.02);
  return { osc, envelope };
}

// ruido filtrado: el "tic", el golpe y el brillo de los premios
function noise(ctx, out, { at = 0, dur = 0.06, gain = 0.06, hz = 4200, q = 0.8, type = 'highpass' }) {
  const frames = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i += 1) data[i] = Math.random() * 2 - 1;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = hz;
  filter.Q.value = q;
  const envelope = ctx.createGain();
  envelope.gain.setValueAtTime(ATTACK, at);
  envelope.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), at + dur * 0.12);
  envelope.gain.exponentialRampToValueAtTime(ATTACK, at + dur);
  source.connect(filter);
  filter.connect(envelope);
  envelope.connect(out);
  source.start(at);
  source.stop(at + dur + 0.02);
  return { source, envelope };
}

// las notas de una escala mayor, en Hz, para que los arpegios suenen afinados
const NOTES = { C5: 523.25, D5: 587.33, E5: 659.25, G5: 783.99, A5: 880.0, C6: 1046.5, E6: 1318.5, G6: 1568.0 };

// las rarezas de las cajas, de menos a más: cuántas notas y qué tan brillante
const WIN_NOTES = {
  'común': ['C5', 'G5'],
  'poco común': ['C5', 'E5', 'G5'],
  'raro': ['C5', 'E5', 'G5', 'C6'],
  'épico': ['C5', 'E5', 'G5', 'C6', 'E6'],
  'legendario': ['C5', 'E5', 'G5', 'C6', 'E6', 'G6'],
};

function arpeggio(ctx, out, { notes, at = 0, step = 0.09, dur = 0.26, gain = 0.12, type = 'triangle' }) {
  notes.forEach((name, index) => {
    voice(ctx, out, { freq: NOTES[name] || 523.25, type, at: at + index * step, dur, gain });
    // una octava arriba, muy suave: da el brillo metálico del premio
    voice(ctx, out, { freq: (NOTES[name] || 523.25) * 2, type: 'sine', at: at + index * step, dur: dur * 0.6, gain: gain * 0.22 });
  });
}

// TODO el catálogo, sobre cualquier BaseAudioContext (en vivo u offline)
function build(ctx, out, name, arg = {}) {
  const at = arg.at || 0;
  switch (name) {
    case 'click':
      voice(ctx, out, { freq: 1350, to: 900, type: 'square', at, dur: 0.035, gain: 0.05 });
      return 0.06;

    case 'tick':
      // el "tic" de la ruleta: un golpe cortísimo y seco
      noise(ctx, out, { at, dur: 0.022, gain: 0.09, hz: 5200 });
      voice(ctx, out, { freq: 2100, to: 1500, type: 'triangle', at, dur: 0.03, gain: 0.06 });
      return 0.05;

    case 'spinStart':
      noise(ctx, out, { at, dur: 0.5, gain: 0.05, hz: 900, q: 1.4, type: 'bandpass' });
      voice(ctx, out, { freq: 180, to: 720, type: 'sawtooth', at, dur: 0.45, gain: 0.05 });
      return 0.5;

    case 'buy':
      arpeggio(ctx, out, { notes: ['C5', 'E5'], at, step: 0.075, dur: 0.18, gain: 0.09 });
      return 0.4;

    case 'sell':
      arpeggio(ctx, out, { notes: ['E5', 'C5'], at, step: 0.075, dur: 0.18, gain: 0.09 });
      return 0.4;

    case 'profit':
      arpeggio(ctx, out, { notes: ['C5', 'E5', 'G5', 'C6'], at, step: 0.08, dur: 0.22, gain: 0.11 });
      return 0.6;

    case 'loss':
      // un descenso suave: se pierde dinero, no se castiga el oído
      arpeggio(ctx, out, { notes: ['G5', 'E5', 'C5'], at, step: 0.1, dur: 0.28, gain: 0.1, type: 'sine' });
      return 0.7;

    case 'win': {
      const rarity = WIN_NOTES[arg.rarity] ? arg.rarity : 'común';
      const notes = WIN_NOTES[rarity];
      arpeggio(ctx, out, { notes, at, step: 0.085, dur: 0.3, gain: 0.12 });
      if (rarity === 'épico' || rarity === 'legendario') {
        // un acorde final que dura: es lo que hace que se sienta "raro"
        const chord = ['C5', 'E5', 'G5'];
        chord.forEach((note, index) => voice(ctx, out, {
          freq: NOTES[note], type: 'triangle', at: at + notes.length * 0.085 + index * 0.01, dur: 0.9, gain: 0.07,
        }));
        noise(ctx, out, { at: at + notes.length * 0.085, dur: 0.7, gain: 0.035, hz: 6500 });
      }
      if (rarity === 'legendario') {
        voice(ctx, out, { freq: 110, to: 55, type: 'sine', at, dur: 0.5, gain: 0.16 });
      }
      return notes.length * 0.085 + (rarity === 'épico' || rarity === 'legendario' ? 1 : 0.4);
    }

    case 'jackpot': {
      const notes = ['C5', 'E5', 'G5', 'C6', 'E6', 'G6', 'C6'];
      arpeggio(ctx, out, { notes, at, step: 0.075, dur: 0.34, gain: 0.13 });
      const tail = notes.length * 0.075;
      ['C5', 'E5', 'G5', 'C6'].forEach((note, index) => voice(ctx, out, {
        freq: NOTES[note], type: 'triangle', at: at + tail + index * 0.012, dur: 1.4, gain: 0.07,
      }));
      voice(ctx, out, { freq: 120, to: 50, type: 'sine', at, dur: 0.7, gain: 0.2 });
      voice(ctx, out, { freq: 220, to: 90, type: 'sine', at, dur: 0.7, gain: 0.1 });
      noise(ctx, out, { at: at + tail, dur: 1.1, gain: 0.045, hz: 7000 });
      return tail + 1.6;
    }

    case 'levelup':
      arpeggio(ctx, out, { notes: ['C5', 'E5', 'G5', 'C6'], at, step: 0.07, dur: 0.3, gain: 0.11 });
      noise(ctx, out, { at: at + 0.28, dur: 0.35, gain: 0.03, hz: 8000 });
      return 0.7;

    case 'achievement':
      // dos campanadas con quinta: suena a "logro desbloqueado"
      voice(ctx, out, { freq: NOTES.G5, type: 'triangle', at, dur: 0.5, gain: 0.1 });
      voice(ctx, out, { freq: NOTES.C6, type: 'triangle', at: at + 0.13, dur: 0.7, gain: 0.09 });
      voice(ctx, out, { freq: NOTES.C5, type: 'sine', at, dur: 0.6, gain: 0.05 });
      return 1;

    case 'event':
      // un aviso de mercado: grave y con cuerpo, distinto a todo lo demás
      voice(ctx, out, { freq: 220, to: 160, type: 'sawtooth', at, dur: 0.28, gain: 0.06 });
      voice(ctx, out, { freq: 440, to: 330, type: 'triangle', at: at + 0.16, dur: 0.3, gain: 0.08 });
      noise(ctx, out, { at, dur: 0.45, gain: 0.03, hz: 600, q: 1.2, type: 'bandpass' });
      return 0.6;

    case 'alarm':
      // cuando una posición se cierra sola o la cuenta llega a cero
      voice(ctx, out, { freq: 660, to: 440, type: 'square', at, dur: 0.16, gain: 0.07 });
      voice(ctx, out, { freq: 660, to: 440, type: 'square', at: at + 0.2, dur: 0.16, gain: 0.07 });
      voice(ctx, out, { freq: 220, to: 110, type: 'sawtooth', at: at + 0.4, dur: 0.5, gain: 0.07 });
      return 1;

    case 'notify':
      // campanita de notificación: dos notas cortas y suaves, una quinta arriba
      voice(ctx, out, { freq: NOTES.E5, type: 'triangle', at, dur: 0.22, gain: 0.07 });
      voice(ctx, out, { freq: NOTES.A5, type: 'triangle', at: at + 0.11, dur: 0.3, gain: 0.055 });
      return 0.5;

    case 'card':
      // repartir una carta: un flick corto de papel sobre la mesa
      noise(ctx, out, { at, dur: 0.05, gain: 0.05, hz: 3200, q: 1.2 });
      voice(ctx, out, { freq: 620, to: 240, type: 'triangle', at, dur: 0.05, gain: 0.04 });
      return 0.07;

    case 'cashIn':
      // el cha-ching de la caja registradora: campana doble + chispa de ruido
      voice(ctx, out, { freq: NOTES.E6, type: 'triangle', at, dur: 0.16, gain: 0.09 });
      voice(ctx, out, { freq: NOTES.G6, type: 'triangle', at: at + 0.07, dur: 0.5, gain: 0.08 });
      voice(ctx, out, { freq: NOTES.C6, type: 'sine', at: at + 0.07, dur: 0.45, gain: 0.05 });
      noise(ctx, out, { at, dur: 0.12, gain: 0.03, hz: 7500 });
      return 0.65;

    case 'pollOpen':
      // una encuesta nueva apareció: dos bloops suaves que suben, sin sustar
      voice(ctx, out, { freq: NOTES.C5, type: 'sine', at, dur: 0.16, gain: 0.06 });
      voice(ctx, out, { freq: NOTES.E5, type: 'sine', at: at + 0.12, dur: 0.22, gain: 0.055 });
      return 0.45;

    case 'pollVote':
      // voto registrado: confirmación corta y seca, como un botón físico
      voice(ctx, out, { freq: 880, to: 660, type: 'square', at, dur: 0.05, gain: 0.045 });
      voice(ctx, out, { freq: NOTES.G5, type: 'sine', at: at + 0.06, dur: 0.14, gain: 0.05 });
      return 0.25;

    case 'pollWin':
      // la mayoría acertó la tendencia real: pequeño festejo de tres notas
      arpeggio(ctx, out, { notes: ['E5', 'G5', 'C6'], at, step: 0.08, dur: 0.22, gain: 0.09 });
      return 0.55;

    case 'pollLose':
      // la mayoría falló: dos notas que bajan, sin dramatismo
      arpeggio(ctx, out, { notes: ['E5', 'C5'], at, step: 0.11, dur: 0.24, gain: 0.07, type: 'sine' });
      return 0.5;

    case 'error':
      // rechazo: una tecla grave corta, sin sustar — "no se pudo", nada más
      voice(ctx, out, { freq: 340, to: 220, type: 'square', at, dur: 0.07, gain: 0.055 });
      voice(ctx, out, { freq: 170, to: 120, type: 'sine', at: at + 0.06, dur: 0.13, gain: 0.05 });
      return 0.24;

    case 'sell':
      // venta ejecutada: el invertido del buy (E5→C5) con un toque de registro
      arpeggio(ctx, out, { notes: ['E5', 'C5'], at, step: 0.07, dur: 0.16, gain: 0.08 });
      noise(ctx, out, { at: at + 0.1, dur: 0.06, gain: 0.025, hz: 5000 });
      return 0.35;

    case 'close':
      // panel cerrado: la inversa del open, dos bloops que bajan
      voice(ctx, out, { freq: NOTES.E5, type: 'sine', at, dur: 0.1, gain: 0.04 });
      voice(ctx, out, { freq: NOTES.C5, type: 'sine', at: at + 0.07, dur: 0.14, gain: 0.035 });
      return 0.25;

    case 'hover':
      // resplandor de fila: una capsulita tan corta que casi es textura
      voice(ctx, out, { freq: 1720, to: 1560, type: 'sine', at, dur: 0.03, gain: 0.022 });
      return 0.05;

    case 'open':
      // panel abierto: dos bloops suaves que suben
      voice(ctx, out, { freq: NOTES.C5, type: 'sine', at, dur: 0.1, gain: 0.04 });
      voice(ctx, out, { freq: NOTES.E5, type: 'sine', at: at + 0.07, dur: 0.14, gain: 0.035 });
      return 0.25;

    case 'reconnect':
      // la conexión volvió: un sube-baja rápido, "ya está, sigan"
      voice(ctx, out, { freq: 520, to: 880, type: 'sine', at, dur: 0.12, gain: 0.06 });
      voice(ctx, out, { freq: NOTES.G5, type: 'triangle', at: at + 0.11, dur: 0.2, gain: 0.05 });
      return 0.4;

    case 'transfer':
      // dinero enviado: un arpa corta descendente, la contraparte del cashIn
      arpeggio(ctx, out, { notes: ['G5', 'E5', 'C5'], at, step: 0.07, dur: 0.2, gain: 0.08, type: 'sine' });
      return 0.45;

    case 'marketPulse':
      // el voto colectivo movió el precio: un whoosh que sube, sincronizado
      // con el empujón que se ve en la gráfica
      noise(ctx, out, { at, dur: 0.55, gain: 0.05, hz: 500, q: 0.9, type: 'bandpass' });
      voice(ctx, out, { freq: 320, to: 980, type: 'sine', at, dur: 0.5, gain: 0.06 });
      voice(ctx, out, { freq: 640, to: 1960, type: 'triangle', at: at + 0.08, dur: 0.42, gain: 0.035 });
      return 0.6;

    case 'alert': {
      // el "pum, pum, pum" del aviso central: tres golpes graves que suben de
      // tensión y un timbre brillante que remata
      const beats = [0, 0.26, 0.52];
      beats.forEach((beat, index) => {
        voice(ctx, out, { freq: 150 - index * 14, to: 52, type: 'sine', at: at + beat, dur: 0.24, gain: 0.22 });
        noise(ctx, out, { at: at + beat, dur: 0.13, gain: 0.05, hz: 700, q: 1.1, type: 'lowpass' });
      });
      voice(ctx, out, { freq: NOTES.G5, type: 'triangle', at: at + 0.8, dur: 0.42, gain: 0.09 });
      voice(ctx, out, { freq: NOTES.C6, type: 'sine', at: at + 0.92, dur: 0.5, gain: 0.06 });
      return 1.5;
    }

    default:
      return 0;
  }
}

const SOUND_DURATIONS = {
  click: 0.06, tick: 0.05, spinStart: 0.5, buy: 0.4, sell: 0.4, profit: 0.6, loss: 0.7,
  levelup: 0.7, achievement: 1, event: 0.6, alarm: 1, notify: 0.5, alert: 1.5,
  jackpot: 2.2, win: 1.6, card: 0.07, cashIn: 0.65,
  pollOpen: 0.45, pollVote: 0.25, pollWin: 0.55, pollLose: 0.5, marketPulse: 0.6,
  error: 0.24, close: 0.25, hover: 0.05, open: 0.25, reconnect: 0.4, transfer: 0.45,
};

const Sound = {
  enabled: true,
  ctx: null,
  master: null,
  // volumen por categoría (0..1). la clave persistida es 'bolsa-sound-v2'
  volumes: { ui: 1, market: 1, games: 1, ambience: 0.5 },
  // el murmullo del piso de bolsa: un nodo vivo mientras suena
  ambience: null,
  ambienceGain: null,

  load() {
    try {
      const raw = localStorage.getItem(SOUND_KEY);
      if (raw !== null) this.enabled = raw !== '0';
      const v2 = JSON.parse(localStorage.getItem('bolsa-sound-v2') || 'null');
      if (v2 && typeof v2 === 'object') {
        for (const key of Object.keys(this.volumes)) {
          const v = Number(v2[key]);
          if (Number.isFinite(v)) this.volumes[key] = Math.min(1, Math.max(0, v));
        }
      }
    } catch (e) {}
    return this.enabled;
  },

  save() {
    try { localStorage.setItem(SOUND_KEY, this.enabled ? '1' : '0'); } catch (e) {}
    try { localStorage.setItem('bolsa-sound-v2', JSON.stringify(this.volumes)); } catch (e) {}
  },

  setEnabled(on) {
    this.enabled = on === true;
    this.save();
    if (!this.enabled) this.stopAmbience();
    if (this.master) {
      // un click seco para dejar claro que quedó activado/desactivado
      if (this.enabled) this.play('click');
    }
    return this.enabled;
  },

  setVolume(category, value) {
    if (!(category in this.volumes)) return;
    this.volumes[category] = Math.min(1, Math.max(0, Number(value) || 0));
    this.save();
    if (category === 'ambience') this.applyAmbienceVolume();
  },

  // el navegador exige un gesto del usuario: se crea (o reanuda) al primer clic
  ensure() {
    if (!this.enabled) return null;
    const Ctor = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null;
    if (!Ctor) return null;
    if (!this.ctx) {
      try {
        this.ctx = new Ctor();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.9;
        this.master.connect(this.ctx.destination);
      } catch (e) {
        this.ctx = null;
        return null;
      }
    }
    if (this.ctx.state === 'suspended' && this.ctx.resume) this.ctx.resume().catch(() => {});
    return this.ctx;
  },

  // nodo con el volumen de la categoría del sonido dado
  channelFor(category) {
    const ctx = this.ctx;
    if (!ctx) return null;
    if (!this.channels) this.channels = {};
    if (!this.channels[category]) {
      const g = ctx.createGain();
      g.gain.value = this.volumes[category] ?? 1;
      g.connect(this.master);
      this.channels[category] = g;
    }
    const node = this.channels[category];
    node.gain.value = this.volumes[category] ?? 1; // se actualiza al vuelo
    return node;
  },

  play(name, arg) {
    // el jingle sustituye a la campanita en el mismo flujo: si el que llama
    // marcó la supresión, este disparo de 'notify' se salta una vez
    if (name === 'notify' && suppressNotifyOnce) {
      suppressNotifyOnce = false;
      return false;
    }
    const ctx = this.ensure();
    if (!ctx) return false;
    try {
      const channel = this.channelFor(SOUND_CATEGORIES[name] || 'ui');
      build(ctx, channel || this.master, name, { ...(arg || {}), at: ctx.currentTime + 0.02 });
      return true;
    } catch (e) {
      return false;
    }
  },

  // la ruleta: los tics se agendan en el reloj de audio, no con setInterval, así
  // que van clavados y se van separando conforme frena la cinta
  spin(durationMs, ticks = 34) {
    const ctx = this.ensure();
    if (!ctx) return false;
    const dur = durationMs / 1000;
    const base = ctx.currentTime + 0.02;
    try {
      const channel = this.channelFor('games');
      build(ctx, channel || this.master, 'spinStart', { at: base });
      for (let i = 0; i < ticks; i += 1) {
        const p = ticks > 1 ? i / (ticks - 1) : 1;
        // easing cúbico: al principio casi no hay espacio entre tics y al final
        // se estiran, que es exactamente cómo frena una ruleta
        const time = base + dur * (1 - (1 - p) ** 3) * 0.97;
        build(ctx, channel || this.master, 'tick', { at: time, gain: 0.07 + 0.03 * p });
      }
      return true;
    } catch (e) {
      return false;
    }
  },

  // el murmullo del piso de bolsa: ruido rosa filtrado muy bajo, opcional y
  // silenciable desde su propia categoría. un latido lento le da vida sin
  // que el oído lo registre como música.
  startAmbience() {
    if (!this.enabled) return false;
    const ctx = this.ensure();
    if (!ctx || this.ambience) return true;
    try {
      const frames = ctx.sampleRate * 2;
      const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      // ruido rosa aproximado (paul kellet): suena a "sala llena", no a lluvia
      let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < frames; i += 1) {
        const white = Math.random() * 2 - 1;
        b0 = 0.99765 * b0 + white * 0.099;
        b1 = 0.963 * b1 + white * 0.2965;
        b2 = 0.57 * b2 + white * 1.0526;
        data[i] = (b0 + b1 + b2 + white * 0.1848) * 0.08;
      }
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 640;
      const g = ctx.createGain();
      g.gain.value = 0; // arranca en silencio y sube suave
      source.connect(lp); lp.connect(g); g.connect(this.master);
      source.start();
      // un latido cada ~7s para que se sienta vivo y no un ventilador
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      lfo.frequency.value = 1 / 7;
      lfoGain.gain.value = 0.35;
      lfo.connect(lfoGain); lfoGain.connect(g.gain);
      lfo.start();
      g.gain.setValueAtTime(0, ctx.currentTime);
      g.gain.linearRampToValueAtTime(this.volumes.ambience * 0.5, ctx.currentTime + 2.5);
      this.ambience = { source, lfo };
      this.ambienceGain = g;
      return true;
    } catch (e) {
      return false;
    }
  },

  applyAmbienceVolume() {
    if (!this.ambienceGain || !this.ctx) return;
    this.ambienceGain.gain.linearRampToValueAtTime(this.volumes.ambience * 0.5, this.ctx.currentTime + 0.2);
  },

  stopAmbience() {
    if (!this.ambience) return;
    try {
      const { source, lfo } = this.ambience;
      if (this.ambienceGain && this.ctx) {
        this.ambienceGain.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 0.4);
      }
      setTimeout(() => { try { source.stop(); lfo.stop(); } catch (e) {} }, 500);
    } catch (e) {}
    this.ambience = null;
    this.ambienceGain = null;
  },

  // lo que dura cada sonido, para que el render offline sepa cuánto capturar
  durationOf(name, arg) {
    if (name === 'win') {
      const rarity = WIN_NOTES[arg && arg.rarity] ? arg.rarity : 'común';
      return WIN_NOTES[rarity].length * 0.085 + ((rarity === 'épico' || rarity === 'legendario') ? 1.1 : 0.5);
    }
    return SOUND_DURATIONS[name] || 0.4;
  },

  // expuesto para los tests: renderiza el sonido en un buffer y lo devuelve
  renderOffline(name, arg) {
    const Ctor = typeof window !== 'undefined'
      ? (window.OfflineAudioContext || window.webkitOfflineAudioContext) : null;
    if (!Ctor) return null;
    const seconds = this.durationOf(name, arg) + 0.15;
    const ctx = new Ctor(1, Math.ceil(44100 * seconds), 44100);
    const out = ctx.createGain();
    out.gain.value = 0.9;
    out.connect(ctx.destination);
    build(ctx, out, name, { ...(arg || {}), at: 0.01 });
    return ctx.startRendering();
  },
};

const SOUND_CATEGORY_LABELS = [
  ['ui', 'Interfaz (comprar, vender, clics)'],
  ['market', 'Mercado (eventos, alertas, notificaciones)'],
  ['games', 'Minijuegos (casino, cajas, ruleta)'],
];

function soundToggleRow() {
  const sliders = SOUND_CATEGORY_LABELS.map(([cat, label]) => `
    <label class="settings-row settings-vol">
      <span>${label}</span>
      <input type="range" min="0" max="1" step="0.05" value="${Sound.volumes[cat]}" data-vol="${cat}">
    </label>`).join('');
  return `
    <label class="settings-row">
      <span>Sonidos del juego</span>
      <input type="checkbox" id="setSoundOn" ${Sound.enabled ? 'checked' : ''}>
    </label>
    <label class="settings-row">
      <span>Murmullo del piso (ambiente)</span>
      <input type="checkbox" id="setAmbienceOn" ${Sound.ambience ? 'checked' : ''}>
    </label>
    <label class="settings-row settings-vol">
      <span>Volumen del ambiente</span>
      <input type="range" min="0" max="1" step="0.05" value="${Sound.volumes.ambience}" data-vol="ambience">
    </label>
    ${sliders}`;
}

function bindSoundToggle(body) {
  if (!body) return;
  const input = body.querySelector('#setSoundOn');
  if (input) {
    input.addEventListener('change', () => {
      Sound.setEnabled(input.checked);
      toast('Sonido', input.checked ? 'Activado' : 'Silenciado', 'gold');
      const amb = body.querySelector('#setAmbienceOn');
      if (amb) amb.checked = input.checked && Sound.ambience !== null;
    });
  }
  const ambToggle = body.querySelector('#setAmbienceOn');
  if (ambToggle) {
    ambToggle.addEventListener('change', () => {
      if (ambToggle.checked) Sound.startAmbience();
      else Sound.stopAmbience();
    });
  }
  body.querySelectorAll('[data-vol]').forEach((slider) => {
    slider.addEventListener('input', () => {
      Sound.setVolume(slider.dataset.vol, parseFloat(slider.value));
      // muestra el sonido que se está ajustando, al volumen elegido
      if (slider.dataset.vol === 'ambience') Sound.applyAmbienceVolume();
      else Sound.play(slider.dataset.vol === 'games' ? 'tick' : slider.dataset.vol === 'market' ? 'notify' : 'click');
    });
  });
}
