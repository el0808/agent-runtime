import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";

const SERVICE = "agent-runtime";

/**
 * Stores API keys. macOS uses the Keychain through the `security` CLI so the key
 * never touches the repository; other platforms fall back to a 0600 file.
 */
export class SecretStore {
  private readonly fallbackFile: string;
  private readonly useKeychain: boolean;

  constructor(storageDir: string) {
    this.fallbackFile = path.join(storageDir, "secrets.json");
    mkdirSync(path.dirname(this.fallbackFile), { recursive: true });
    this.useKeychain = process.platform === "darwin" && this.keychainAvailable();
  }

  get(account: string): string | undefined {
    if (this.useKeychain) {
      const result = spawnSync("security", ["find-generic-password", "-s", SERVICE, "-a", account, "-w"], {
        encoding: "utf8"
      });
      if (result.status === 0) {
        const value = result.stdout.trim();
        return value === "" ? undefined : value;
      }
      return undefined;
    }
    return this.readFallback()[account];
  }

  set(account: string, value: string): void {
    if (value === "") {
      this.delete(account);
      return;
    }
    if (this.useKeychain) {
      spawnSync("security", ["delete-generic-password", "-s", SERVICE, "-a", account], { encoding: "utf8" });
      const result = spawnSync(
        "security",
        ["add-generic-password", "-s", SERVICE, "-a", account, "-w", value, "-U"],
        { encoding: "utf8" }
      );
      if (result.status === 0) {
        return;
      }
    }
    const secrets = this.readFallback();
    secrets[account] = value;
    this.writeFallback(secrets);
  }

  delete(account: string): void {
    if (this.useKeychain) {
      spawnSync("security", ["delete-generic-password", "-s", SERVICE, "-a", account], { encoding: "utf8" });
    }
    const secrets = this.readFallback();
    if (account in secrets) {
      delete secrets[account];
      this.writeFallback(secrets);
    }
  }

  /** Whether a key exists, without returning it to a renderer. */
  has(account: string): boolean {
    return (this.get(account) ?? "") !== "";
  }

  private keychainAvailable(): boolean {
    const result = spawnSync("security", ["-h"], { encoding: "utf8" });
    return result.status === 0 || result.status === 1;
  }

  private readFallback(): Record<string, string> {
    if (!existsSync(this.fallbackFile)) {
      return {};
    }
    try {
      return JSON.parse(readFileSync(this.fallbackFile, "utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private writeFallback(secrets: Record<string, string>): void {
    const temp = `${this.fallbackFile}.tmp`;
    writeFileSync(temp, JSON.stringify(secrets, null, 2), { encoding: "utf8", mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, this.fallbackFile);
  }
}
