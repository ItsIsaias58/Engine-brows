// copy de las noticias del modo sin conexión: cuando el servicio de mercado no
// está disponible el juego sigue generando titulares en local. en vivo los
// titulares los escribe el servidor (services/market/headlines.mjs) y este
// archivo no se usa.
//
// el panel guarda sólo los titulares más recientes: al llegar uno nuevo el más
// viejo se cae solo, así la lista nunca se vuelve una pared ilegible.
const NEWS_LIMIT = 15;
const NEWS_AREAS = [
  'nueva tecnología', 'inteligencia artificial', 'expansión internacional',
  'modernización de su infraestructura', 'investigación y desarrollo', 'energía limpia',
];
