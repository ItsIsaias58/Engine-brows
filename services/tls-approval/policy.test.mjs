import { describe, expect, test } from "bun:test";
import {
  domainPolicyRejection,
  isBlockedDomain,
  isDomainSyntaxValid,
  parseIpv4Literal,
} from "./policy.mjs";

describe("parseIpv4Literal", () => {
  test("reconoce IPv4 validas", () => {
    for (const address of ["1.2.3.4", "8.8.8.8", "0.0.0.0", "255.255.255.255", "127.0.0.1", "169.254.169.254"]) {
      expect(parseIpv4Literal(address)).toBe(address);
    }
  });

  // el bug: el filtro anterior solo miraba "3 puntos y ultimo grupo <= 3 chars",
  // asi que estas se colaban como si fueran dominios normales.
  test("rechaza octetos fuera de rango aunque el ultimo grupo sea largo", () => {
    for (const address of ["1.2.3.4444", "192.168.1.1000", "10.0.0.12345", "256.1.1.1", "1.2.3.999"]) {
      expect(parseIpv4Literal(address)).toBeNull();
    }
  });

  test("rechaza ceros a la izquierda (ambiguos en octal)", () => {
    expect(parseIpv4Literal("010.0.0.1")).toBeNull();
    expect(parseIpv4Literal("1.2.3.04")).toBeNull();
  });

  test("rechaza el numero de grupos incorrecto", () => {
    for (const address of ["1.2.3", "1.2.3.4.5", "1.2.3.4444.5"]) {
      expect(parseIpv4Literal(address)).toBeNull();
    }
  });

  test("no confunde un dominio numerico con una IP", () => {
    for (const domain of ["1.2.3.example", "192.168.1.example", "3.example"]) {
      expect(parseIpv4Literal(domain)).toBeNull();
    }
  });
});

describe("isDomainSyntaxValid", () => {
  test("acepta dominios normales", () => {
    for (const domain of ["example.com", "a.b.c.d.example.com", "x-1.example.co.uk", "9gag.com"]) {
      expect(isDomainSyntaxValid(domain)).toBe(true);
    }
  });

  test("rechaza sinonaxis invalidas", () => {
    for (const domain of [
      "",
      ".example.com",
      "example.com.",
      "-example.com",
      "example..com",
      "example.com-",
      "exa mple.com",
      "EXAMPLE.com",
      "example.com/path",
      "exam_ple.com",
    ]) {
      expect(isDomainSyntaxValid(domain)).toBe(false);
    }
  });

  // "example-.com" SI es valido: RFC 1123 permite una etiqueta terminada en
  // guion (solo desaconseja usarla). el validador original tambien lo aceptaba,
  // asi que no se cambia: no aporta nada endurecerlo y eturnal no resolveria
  // un dominio asi en la practica.
  test("una etiqueta terminada en guion es valida salvo si es la ultima", () => {
    expect(isDomainSyntaxValid("example-.com")).toBe(true);
    expect(isDomainSyntaxValid("example.com-")).toBe(false);
  });

  test("rechaza una etiqueta de mas de 63 caracteres", () => {
    expect(isDomainSyntaxValid(`${"a".repeat(64)}.com`)).toBe(false);
    expect(isDomainSyntaxValid(`${"a".repeat(63)}.com`)).toBe(true);
  });

  test("rechaza un dominio de mas de 253 caracteres", () => {
    const long = `${"a".repeat(60)}.`.repeat(5);
    expect(isDomainSyntaxValid(long)).toBe(false);
  });
});

describe("isBlockedDomain", () => {
  test("bloquea subdominios de la lista", () => {
    for (const domain of ["a.nip.io", "x.y.trycloudflare.com", "foo.bar.burpcollaborator.net"]) {
      expect(isBlockedDomain(domain)).toBe(true);
    }
  });

  // el otro bug: los sufijos empiezan por ".", asi que el apex nunca casaba.
  test("bloquea tambien el apex de la lista", () => {
    for (const domain of ["nip.io", "trycloudflare.com", "lvh.me", "oast.fun", "canarytokens.com"]) {
      expect(isBlockedDomain(domain)).toBe(true);
    }
  });

  test("no bloquea dominios legitimos parecidos", () => {
    for (const domain of ["notnip.io", "nip.io.example.com", "example.com", "github.com", "myp.io"]) {
      expect(isBlockedDomain(domain)).toBe(false);
    }
  });
});

describe("domainPolicyRejection", () => {
  test("aprueba un dominio normal", () => {
    expect(domainPolicyRejection("example.com")).toBeNull();
  });

  // el objetivo de todo: on-demand TLS no emite para IPs, y el filtro viejo
  // dejaba pasar las que tenian el ultimo octeto largo.
  test("rechaza cualquier literal IPv4", () => {
    for (const address of ["1.2.3.4", "8.8.8.8", "192.168.1.1", "127.0.0.1", "169.254.169.254", "0.0.0.0", "255.255.255.255"]) {
      expect(domainPolicyRejection(address)).toBe("ip literal");
    }
  });

  // "192.168.1.1000" no es una IP valida (ultimo octeto > 255), asi que no se
  // rechaza como "ip literal". tampoco es un dominio real: un TLD no puede ser
  // numerico, asi que eturnal no lo resuelve y no emite nada. el bug era que el
  // filtro viejo lo marcaba como IP sin comprobarlo; ahora
  // la decision es explicita en vez de depender de un umbral de longitud.
  test("un numerico que no es IP no se marca como IP", () => {
    expect(parseIpv4Literal("192.168.1.1000")).toBeNull();
    expect(domainPolicyRejection("192.168.1.1000")).toBeNull();
  });

  test("rechaza dominios invalidos", () => {
    expect(domainPolicyRejection("")).toBe("invalid domain");
    expect(domainPolicyRejection("-bad.com")).toBe("invalid domain");
    expect(domainPolicyRejection("bad_domain.com")).toBe("invalid domain");
  });

  test("rechaza la lista negra", () => {
    expect(domainPolicyRejection("a.nip.io")).toBe("blocked domain");
    expect(domainPolicyRejection("nip.io")).toBe("blocked domain");
  });
});
