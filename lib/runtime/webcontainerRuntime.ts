import type { WebContainer, WebContainerProcess } from "@webcontainer/api";

const BOOT_TIMEOUT_MS = 60_000;
const PORT_WAIT_MS = 15_000;
const PREVIEW_CAPTURE_TIMEOUT_MS = 15_000;

export class WebRuntimeError extends Error {}

interface BackgroundHandle {
  process: WebContainerProcess;
  output: string;
  exitCode: number | null;
}

/**
 * Thin, single-purpose WebContainer wrapper - only what Huddle's
 * RuntimeProvider interface needs (create/write/run/port/preview),
 * not the full multi-provider SandboxProvider surface (pty sessions,
 * archive/suspend, Daytona-shaped options) apostle's version carries
 * for E2B/Daytona parity. This repo has exactly one runtime; the
 * interface stays small on purpose.
 */
export class WebContainerRuntime {
  private container: WebContainer | null = null;
  private previewUrls = new Map<number, string>();
  private previewWaiters = new Map<number, Array<(url: string) => void>>();
  private backgroundCommands = new Map<string, BackgroundHandle>();

  private previewWindow: Window | null = null;
  private previewOrigin: string | null = null;
  private capturePending = new Map<
    string,
    {
      resolve: (r: { dataUrl: string; width: number; height: number }) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private messageHandler: ((evt: MessageEvent) => void) | null = null;

  /**
   * Phase 23: `onInternalError` wires the container's own `error` event
   * (a genuine WebContainer-engine-level signal, distinct from a dev
   * server merely exiting non-zero - see webcontainerRuntime's own type
   * defs) so a failure here is reported instead of silently vanishing.
   * Deliberately detection-only: full recreation (teardown + reboot +
   * file replay + reconciling any in-flight command against the dead
   * instance) was assessed and NOT implemented this pass - no live
   * reproduction of a real WebContainer-engine crash exists to build or
   * verify against, and `WebContainerRuntime` carries enough per-boot
   * state (previewUrls/previewWaiters/backgroundCommands/capturePending/
   * the preview message listener) that a safe reset needs its own
   * verified design, not a bolt-on. Surfacing the failure honestly via
   * `onInternalError` is the graceful-degradation half of that decision.
   */
  async boot(onInternalError?: (message: string) => void): Promise<void> {
    const { WebContainer } = await import("@webcontainer/api");

    const container = await Promise.race([
      WebContainer.boot({ forwardPreviewErrors: true }),
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () =>
            reject(
              new WebRuntimeError(
                `WebContainer.boot() did not settle within ${BOOT_TIMEOUT_MS / 1000}s`
              )
            ),
          BOOT_TIMEOUT_MS
        )
      ),
    ]);

    this.container = container;

    if (onInternalError) {
      container.on("error", (error) => onInternalError(error.message));
    }

    container.on("server-ready", (port, url) => {
      this.previewUrls.set(port, url);
      const waiters = this.previewWaiters.get(port);
      if (waiters) {
        waiters.forEach((resolve) => resolve(url));
        this.previewWaiters.delete(port);
      }
    });

    container.on("port", (port, type, url) => {
      if (type === "open") this.previewUrls.set(port, url);
      else this.previewUrls.delete(port);
    });

    this.setupCaptureMessageListener();
  }

  private requireContainer(): WebContainer {
    if (!this.container) {
      throw new WebRuntimeError("WebContainer isn't booted yet.");
    }
    return this.container;
  }

  async writeFile(path: string, content: string, encoding?: "utf8" | "base64"): Promise<void> {
    const container = this.requireContainer();
    const lastSlash = path.lastIndexOf("/");
    if (lastSlash > 0) {
      await container.fs.mkdir(path.slice(0, lastSlash), { recursive: true });
    }
    if (encoding === "base64") {
      // Firestore's SessionFile.content is a string field - binary assets
      // (real downloaded photography, per the image-asset rules) travel
      // as base64 text and get decoded back to real bytes right here,
      // via the browser's own atob (no Buffer - this runs client-side).
      const binary = atob(content);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      await container.fs.writeFile(path, bytes);
    } else {
      await container.fs.writeFile(path, content);
    }
  }

  async deleteFile(path: string): Promise<void> {
    const container = this.requireContainer();
    await container.fs.rm(path, { recursive: true, force: true });
  }

  private async spawnCommand(
    command: string,
    cwd?: string
  ): Promise<WebContainerProcess> {
    const container = this.requireContainer();
    try {
      return await container.spawn("jsh", ["-c", command], { cwd });
    } catch {
      const [cmd, ...args] = command.split(" ");
      return container.spawn(cmd, args, { cwd });
    }
  }

  private async collectOutput(
    process: WebContainerProcess,
    onChunk?: (chunk: string) => void
  ): Promise<string> {
    let output = "";
    const reader = process.output.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        output += value;
        onChunk?.(value);
      }
    } finally {
      reader.releaseLock();
    }
    return output;
  }

  async runForeground(
    command: string,
    opts?: { cwd?: string; timeoutSeconds?: number }
  ): Promise<{ exitCode: number; output: string }> {
    const process = await this.spawnCommand(command, opts?.cwd);
    const timeoutMs = (opts?.timeoutSeconds ?? 240) * 1000;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      process.kill();
    }, timeoutMs);

    try {
      const [output, exitCode] = await Promise.all([
        this.collectOutput(process),
        process.exit,
      ]);
      return {
        exitCode: timedOut ? -1 : exitCode,
        output: timedOut
          ? `${output}\n[killed - exceeded ${opts?.timeoutSeconds ?? 240}s timeout]`
          : output,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async runBackground(
    command: string,
    opts?: { cwd?: string }
  ): Promise<string> {
    const process = await this.spawnCommand(command, opts?.cwd);
    const commandId = crypto.randomUUID();
    const record: BackgroundHandle = { process, output: "", exitCode: null };
    this.backgroundCommands.set(commandId, record);

    void this.collectOutput(process, (chunk) => {
      record.output += chunk;
    });
    void process.exit.then((code) => {
      record.exitCode = code;
    });

    return commandId;
  }

  getKnownPreviewPorts(): number[] {
    return Array.from(this.previewUrls.keys());
  }

  async waitForPort(port: number): Promise<string> {
    const known = this.previewUrls.get(port);
    if (known) return known;

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiters = this.previewWaiters.get(port);
        if (waiters) {
          const i = waiters.indexOf(onReady);
          if (i !== -1) waiters.splice(i, 1);
        }
        reject(
          new WebRuntimeError(`Nothing became ready on port ${port} within ${PORT_WAIT_MS / 1000}s.`)
        );
      }, PORT_WAIT_MS);

      function onReady(url: string) {
        clearTimeout(timer);
        resolve(url);
      }

      const waiters = this.previewWaiters.get(port) ?? [];
      waiters.push(onReady);
      this.previewWaiters.set(port, waiters);
    });
  }

  async setPreviewScript(scriptSrc: string): Promise<void> {
    const container = this.requireContainer();
    await container.setPreviewScript(scriptSrc);
  }

  private setupCaptureMessageListener(): void {
    if (this.messageHandler) return;

    const handler = (evt: MessageEvent) => {
      const data = evt.data as
        | { marker?: string; kind?: string; requestId?: string; ok?: boolean; error?: string; dataUrl?: string; width?: number; height?: number }
        | null
        | undefined;

      if (!data || data.marker !== "__huddlePreviewCapture") return;

      if (data.kind === "ready") {
        this.previewWindow = evt.source as Window | null;
        this.previewOrigin = evt.origin;
        return;
      }

      if (data.kind === "result" && data.requestId) {
        const pending = this.capturePending.get(data.requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.capturePending.delete(data.requestId);

        if (data.ok && data.dataUrl) {
          pending.resolve({ dataUrl: data.dataUrl, width: data.width ?? 0, height: data.height ?? 0 });
        } else {
          pending.reject(new WebRuntimeError(data.error ?? "Preview capture failed."));
        }
      }
    };

    window.addEventListener("message", handler);
    this.messageHandler = handler;
  }

  async capturePreview(viewport?: {
    width: number;
    height: number;
  }): Promise<{ dataUrl: string; width: number; height: number }> {
    if (!this.previewWindow) {
      throw new WebRuntimeError(
        "No live preview page to capture yet - make sure the dev server is running and the preview has loaded at least once."
      );
    }

    const requestId = crypto.randomUUID();
    const targetWindow = this.previewWindow;
    const targetOrigin = this.previewOrigin ?? "*";

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.capturePending.delete(requestId);
        reject(new WebRuntimeError(`Preview capture timed out after ${PREVIEW_CAPTURE_TIMEOUT_MS / 1000}s.`));
      }, PREVIEW_CAPTURE_TIMEOUT_MS);

      this.capturePending.set(requestId, { resolve, reject, timer });

      targetWindow.postMessage(
        { marker: "__huddlePreviewCapture", kind: "request", requestId, viewport },
        targetOrigin
      );
    });
  }

  teardown(): void {
    this.container?.teardown();
    this.container = null;
    if (this.messageHandler) {
      window.removeEventListener("message", this.messageHandler);
      this.messageHandler = null;
    }
    for (const pending of this.capturePending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new WebRuntimeError("Runtime torn down."));
    }
    this.capturePending.clear();
  }
}
