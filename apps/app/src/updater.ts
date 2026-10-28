import { app } from "electron";
import { autoUpdater, type UpdateInfo } from "electron-updater";

export type UpdateStatus =
  | { readonly state: "idle" }
  | { readonly state: "checking" }
  | { readonly state: "available"; readonly version: string; readonly notes: string }
  | { readonly state: "none"; readonly current: string }
  | { readonly state: "downloading"; readonly percent: number }
  | { readonly state: "ready"; readonly version: string }
  | { readonly state: "error"; readonly message: string };

export interface UpdaterOptions {
  /** Called on every state change so the window can render it. */
  readonly onChange: (status: UpdateStatus) => void;
  /** Opens the release page, for the unsigned fallback. */
  readonly onOpenRelease: (version: string) => void;
}

/**
 * Wraps electron-updater for a GitHub-hosted release feed.
 *
 * macOS installs updates through Squirrel, which requires the running app to be
 * signed. Without a signing identity the download still works but the install
 * cannot, so that case is reported as a link to the release rather than a
 * failure the user cannot act on.
 */
export class Updater {
  private status: UpdateStatus = { state: "idle" };
  private readonly options: UpdaterOptions;

  constructor(options: UpdaterOptions) {
    this.options = options;

    // A portable or development run has no packaged app to replace.
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = false;

    autoUpdater.on("checking-for-update", () => this.set({ state: "checking" }));
    autoUpdater.on("update-available", (info: UpdateInfo) => {
      this.set({
        state: "available",
        version: info.version,
        notes: typeof info.releaseNotes === "string" ? info.releaseNotes : ""
      });
    });
    autoUpdater.on("update-not-available", () => {
      this.set({ state: "none", current: app.getVersion() });
    });
    autoUpdater.on("download-progress", (progress) => {
      this.set({ state: "downloading", percent: Math.round(progress.percent) });
    });
    autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
      this.set({ state: "ready", version: info.version });
    });
    autoUpdater.on("error", (error: Error) => {
      this.set({ state: "error", message: error.message.slice(0, 300) });
    });
  }

  current(): UpdateStatus {
    return this.status;
  }

  private set(status: UpdateStatus): void {
    this.status = status;
    this.options.onChange(status);
  }

  /** Whether this build can check for updates at all. */
  available(): boolean {
    // An unpackaged run has no update feed and no app to replace.
    return app.isPackaged;
  }

  async check(): Promise<UpdateStatus> {
    if (!this.available()) {
      this.set({ state: "error", message: "Update checks only work in a packaged build." });
      return this.status;
    }
    try {
      this.set({ state: "checking" });
      await autoUpdater.checkForUpdates();
    } catch (error) {
      this.set({ state: "error", message: error instanceof Error ? error.message.slice(0, 300) : String(error) });
    }
    return this.status;
  }

  async download(): Promise<UpdateStatus> {
    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      this.set({ state: "error", message: error instanceof Error ? error.message.slice(0, 300) : String(error) });
    }
    return this.status;
  }

  /**
   * Installs a downloaded update. On an unsigned build Squirrel refuses, so the
   * release page is opened instead of leaving the user with a dead button.
   */
  install(): { installed: boolean; openedRelease: boolean } {
    if (this.status.state !== "ready") {
      return { installed: false, openedRelease: false };
    }
    const version = this.status.version;
    try {
      autoUpdater.quitAndInstall();
      return { installed: true, openedRelease: false };
    } catch {
      this.options.onOpenRelease(version);
      return { installed: false, openedRelease: true };
    }
  }
}
