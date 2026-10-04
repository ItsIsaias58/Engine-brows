// el primer contacto con el piso: una guía de 4 pasos que aparece una sola vez
// (bolsa-tutorial-done en localStorage), se salta con "Entendido" en cualquier
// momento y no vuelve a molestar. cubre lo mínimo para no estar perdido:
// comprar, vender, la vista de mercado y el banco/casino.
const TUTORIAL_STEPS = [
  {
    icon: '📈',
    title: 'Comprar tu primera acción',
    text: 'Elige una empresa en la <b>vista del mercado</b> (columna izquierda), escribe cuántas acciones en el panel de orden y pulsa <b>Comprar</b>. El precio grande es el de ajuste: ahí se ejecuta tu orden.',
  },
  {
    icon: '💰',
    title: 'Vender y ganar (o perder)',
    text: 'En <b>Posiciones</b> ves cada inversión con su ganancia en vivo. Selecciona una y pulsa <b>Vender</b> para cerrar. El rojo y el verde siempre dicen la verdad del día.',
  },
  {
    icon: '🏦',
    title: 'Banco: el dinero también descansa',
    text: 'Deja cash en el <b>Banco</b> y rinde interés diario; pide un préstamo si te arriesgas. También puedes transferir dinero a otros jugadores (las transferencias grandes pagan impuesto).',
  },
  {
    icon: '🗳️',
    title: 'Sondo, el pulso del mercado',
    text: 'Cuando aparezca el <b>banner de Sondo</b>, vota si una empresa sube o baja: ganas recompensa por participar y tu voto empuja el precio de verdad. ¿Y el cash que sobra? El <b>Casino</b> lo quema con estilo.',
  },
];

const Onboarding = {
  step: 0,
  open: false,

  done() {
    try { return localStorage.getItem('bolsa-tutorial-done') === '1'; } catch (e) { return true; }
  },

  maybeShow() {
    if (this.done()) return;
    // un pequeño delay: que el primer frame del juego se asiente antes de taparlo
    setTimeout(() => this.show(), 1200);
  },

  show() {
    if (this.open) return;
    this.step = 0;
    this.open = true;
    let overlay = document.getElementById('onboardOverlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'onboardOverlay';
      overlay.className = 'onboard-overlay';
      document.body.appendChild(overlay);
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) return; // el fondo no cierra: decisión explícita
        const btn = e.target.closest('[data-ob]');
        if (!btn) return;
        if (btn.dataset.ob === 'next') this.next();
        else this.finish();
      });
    }
    overlay.classList.add('is-visible');
    this.render();
    if (typeof Sound !== 'undefined') Sound.play('notify');
  },

  next() {
    this.step += 1;
    if (this.step >= TUTORIAL_STEPS.length) return this.finish();
    this.render();
    if (typeof Sound !== 'undefined') Sound.play('click');
  },

  finish() {
    this.open = false;
    const overlay = document.getElementById('onboardOverlay');
    if (overlay) overlay.classList.remove('is-visible');
    try { localStorage.setItem('bolsa-tutorial-done', '1'); } catch (e) {}
    if (typeof Sound !== 'undefined') Sound.play('levelup');
    toast('¡Listo!', 'Puedes volver a leer esto desde Ajustes.', 'up');
  },

  render() {
    const overlay = document.getElementById('onboardOverlay');
    if (!overlay) return;
    const s = TUTORIAL_STEPS[this.step];
    const last = this.step === TUTORIAL_STEPS.length - 1;
    overlay.innerHTML = `
      <div class="onboard-card">
        <div class="onboard-icon">${s.icon}</div>
        <h3>${s.title}</h3>
        <p>${s.text}</p>
        <div class="onboard-dots">
          ${TUTORIAL_STEPS.map((_, i) => `<span class="${i === this.step ? 'is-on' : i < this.step ? 'is-done' : ''}"></span>`).join('')}
        </div>
        <div class="onboard-actions">
          <button class="onboard-skip" data-ob="skip">Saltar tutorial</button>
          <button class="nav-modal-btn" data-ob="next">${last ? '🚀 Empezar a operar' : 'Siguiente →'}</button>
        </div>
        <span class="onboard-step mono">${this.step + 1} / ${TUTORIAL_STEPS.length}</span>
      </div>`;
  },

  // el botón "ver tutorial otra vez" de ajustes
  replay() {
    try { localStorage.removeItem('bolsa-tutorial-done'); } catch (e) {}
    this.show();
  },
};
