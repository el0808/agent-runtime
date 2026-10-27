import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface DeviceRecord {
  readonly deviceId: string;
  readonly label?: string;
  readonly registeredAt: string;
}

export interface DeviceRegistryState {
  readonly secret: string;
  readonly devices: DeviceRecord[];
}

function tokenFor(secret: string, deviceId: string): string {
  return createHmac("sha256", secret).update(deviceId).digest("hex");
}

/**
 * Issues and verifies per-device bearer tokens derived from a server secret.
 * Tokens are HMACs, so the registry never needs to store plaintext credentials.
 */
export class DeviceRegistry {
  private state: DeviceRegistryState;
  private readonly filename: string;

  constructor(filename: string) {
    this.filename = filename;
    mkdirSync(path.dirname(filename), { recursive: true });
    if (existsSync(filename)) {
      this.state = JSON.parse(readFileSync(filename, "utf8")) as DeviceRegistryState;
    } else {
      this.state = { secret: randomUUID() + randomUUID(), devices: [] };
      this.persist();
    }
  }

  register(label?: string): { deviceId: string; token: string } {
    const deviceId = randomUUID();
    const record: DeviceRecord = {
      deviceId,
      registeredAt: new Date().toISOString(),
      ...(label === undefined ? {} : { label })
    };
    this.state = { ...this.state, devices: [...this.state.devices, record] };
    this.persist();
    return { deviceId, token: tokenFor(this.state.secret, deviceId) };
  }

  verify(deviceId: string, token: string): boolean {
    if (!this.state.devices.some((device) => device.deviceId === deviceId)) {
      return false;
    }
    const expected = Buffer.from(tokenFor(this.state.secret, deviceId), "utf8");
    const supplied = Buffer.from(token, "utf8");
    return expected.length === supplied.length && timingSafeEqual(expected, supplied);
  }

  devices(): readonly DeviceRecord[] {
    return this.state.devices;
  }

  private persist(): void {
    const temp = `${this.filename}.tmp`;
    writeFileSync(temp, JSON.stringify(this.state), "utf8");
    renameSync(temp, this.filename);
  }
}
