import { describe, expect, test } from "bun:test";
import {
  TRANSPORT_CANDIDATES,
  isProxyTransportName,
  transportAttemptOrder,
} from "./transportOrder.ts";

describe("orden de intentos de transporte", () => {
  test("respeta el transporte elegido como primero", () => {
    expect(transportAttemptOrder("epoxy")[0]).toBe("epoxy");
    expect(transportAttemptOrder("libcurl")[0]).toBe("libcurl");
  });

  test("incluye el otro como fallback (no deja la app sin transporte)", () => {
    expect(transportAttemptOrder("epoxy")).toEqual(["epoxy", "libcurl"]);
    expect(transportAttemptOrder("libcurl")).toEqual(["libcurl", "epoxy"]);
  });

  test("siempre cubre todos los transportes conocidos exactamente una vez", () => {
    for (const preferred of [...TRANSPORT_CANDIDATES, "desconocido", ""]) {
      const order = transportAttemptOrder(preferred);
      expect([...order].sort()).toEqual([...TRANSPORT_CANDIDATES].sort());
    }
  });

  test("un valor desconocido no se pierde y cae al final", () => {
    expect(transportAttemptOrder("vpn-magica")).toEqual(["epoxy", "libcurl"]);
  });

  test("isProxyTransportName valida solo los nombres reales", () => {
    expect(isProxyTransportName("epoxy")).toBe(true);
    expect(isProxyTransportName("libcurl")).toBe(true);
    expect(isProxyTransportName("otro")).toBe(false);
    expect(isProxyTransportName(null)).toBe(false);
    expect(isProxyTransportName(7)).toBe(false);
  });
});
