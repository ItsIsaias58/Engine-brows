import fs from "fs";
import os from "os";
import path from "path";
import { randomBytes } from "crypto";

function randomHex(bytes = 32) {
  return randomBytes(bytes).toString("hex");
}

export function createDevRuntime(baseEnv = process.env) {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "lyra-dev-"));
  const env = {
    ...baseEnv,
    JWT_SECRET: randomHex(64),
    SYNC_SECRET: randomHex(),
    // credenciales TURN efimeras por ejecucion (sin usuario/password por
    // defecto conocidos que se filtren en la lista de procesos).
    TURN_USERNAME: baseEnv.TURN_USERNAME || `lyra-${randomHex(4)}`,
    TURN_CREDENTIAL: baseEnv.TURN_CREDENTIAL || randomHex(24),
    // los servicios internos se quedan en loopback: solo lyra los consume.
    // sin esto, mochi/isao arrancaban en 0.0.0.0 y quedaban visibles en la LAN.
    MOCHI_HOST: baseEnv.MOCHI_HOST || "127.0.0.1",
    ISAO_HOST: baseEnv.ISAO_HOST || "127.0.0.1",
    CLOUDSYNC_DB_PATH: path.join(runtimeDir, "cloudsync.db"),
  };

  return {
    env,
    runtimeDir,
    cleanup() {
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    },
  };
}
