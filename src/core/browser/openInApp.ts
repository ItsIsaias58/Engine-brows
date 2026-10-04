import { openStage, stageReady } from "./stageOverlay.ts";
import { toast } from "../ui/toast.ts";

/**
 * Abre una url DENTRO de la app: en el visor grande, servida por el proxy de
 * folio, en vez de lanzar una ventana nativa del sistema ni abrir una pestana
 * del navegador.
 *
 * Existe porque `window.open` y `target="_blank"` se escapan de todo lo que la
 * app hace: abren un navegador de verdad, sin proxy, sin el cloaking y fuera
 * del HUD. En un sitio cuyo motivo de ser es precisamente el proxy, eso es un
 * agujero, no un detalle de estilo. Y abrir una pestana tampoco servia: el
 * usuario pide que la pagina aparezca como pantalla, no como una pestana mas
 * entre el catalogo y la pagina anterior.
 *
 * Sin alternativa a `window.open` a proposito: si la app todavia no puede
 * montar el visor, lo correcto es avisar. Un sitio que no se puede abrir a
 * traves del proxy es un sitio que la app no puede hacer funcionar, y eso es
 * informacion para el usuario, no algo que se esconda abriendo el navegador
 * del sistema sin avisar.
 *
 * Devuelve si la navegacion llega a arrancar, para que quien llame lo pueda
 * medir igual que mide el resto de lanzamientos.
 */
export function openInApp(url: string): boolean {
  const target = (url || "").trim();
  if (!target) return false;
  if (!stageReady()) {
    toast.warning("the browser is still starting, try again in a moment");
    return false;
  }
  try {
    // sin titulo: el visor ya pone el host en su barra, y un titulo aqui solo
    // taparia el nombre de la pagina que se esta viendo
    openStage(target);
    return true;
  } catch {
    toast.error("the page could not be opened");
    return false;
  }
}
