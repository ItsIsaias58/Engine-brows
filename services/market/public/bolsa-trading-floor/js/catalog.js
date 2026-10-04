// el catálogo de empresas del juego y las reglas de la partida, en un archivo
// aparte para que state.js se ocupe solo del estado.
//
// este listado es el *respaldo* del navegador: espeja a
// `services/market/companies.mjs`, que es la fuente real (precios vivos, perfiles
// de cada empresa, noticias y velas llegan por el socket). se mantiene aquí para
// que el simulador local siga funcionando si el servicio de mercado no responde;
// si cambias una empresa en el servidor, refleja aquí al menos sym/name/sector y
// el precio de partida.
const MARKET = [
  { sym:'SOLMK', name:'Solmark Inc.',           sector:'Energía',      price:230.70, vol:0.0055 },
  { sym:'TCED',  name:'TechEdu Inc.',           sector:'Educación',    price:64.30,  vol:0.0075 },
  { sym:'NORVX', name:'Norvex Dynamics',        sector:'Robótica',     price:118.40, vol:0.0065 },
  { sym:'BHVN',  name:'Bluehaven Financial',     sector:'Finanzas',     price:88.15,  vol:0.0030 },
  { sym:'ORBF',  name:'Orbital Foods Co.',      sector:'Consumo',      price:41.92,  vol:0.0040 },
  { sym:'CSCB',  name:'Cascade Biotech',        sector:'Biotecnología',price:212.55, vol:0.0110 },
  { sym:'IRPK',  name:'Ironpeak Materials',     sector:'Materiales',   price:56.08,  vol:0.0050 },
  { sym:'VLRA',  name:'Velora Motors',          sector:'Automotriz',   price:174.90, vol:0.0095 },
  { sym:'NMBS',  name:'Nimbus Cloud Systems',   sector:'Software',     price:329.60, vol:0.0070 },
  { sym:'HRBL',  name:'Harborline Logistics',   sector:'Logística',    price:73.24,  vol:0.0045 },
];
// cada empresa arranca el día plana: el primer tick la mueve. `price` es el
// precio de ajuste (al que se opera, fijo hasta el próximo cierre) y `livePrice`
// es la cinta que dibuja la gráfica.
MARKET.forEach(m=>{
  m.prevClose = m.price; m.open = m.price; m.change = 0; m.pct = 0; m.high = m.price; m.low = m.price;
  m.livePrice = m.price; m.liveChange = 0; m.livePct = 0;
  m.settle = m.price; m.prevSettle = m.price;
  m.settleDay = 0; m.settleAt = 0; m.nextSettleAt = 0;
});

// reglas de la partida
const START_CASH = 10000;      // con lo que empiezas
const RECAP_CASH = 10000;      // lo que recibes tras la bancarrota
const BANKRUPT_WAIT_MS = 60000; // un minuto real de espera antes de la recapitalización
const SETTLE_DAYS = 2;          // cada cuántos días de juego se fija el precio de ajuste
