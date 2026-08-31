import { WebContainerRuntime } from "@/lib/runtime/webcontainerRuntime";
import { startDevServer, type RuntimeSessionCallbacks } from "@/lib/runtime/runtimeSession";

export interface PublicProjectFile {
  path: string;
  content: string;
  encoding?: "utf8" | "base64";
}

/**
 * Phase 38: the public visitor's own boot path - deliberately NOT
 * reusing useRuntimeHost/RuntimeSession's full start() (that machinery
 * is entangled with Firestore host-election/heartbeat/reporting, the
 * wrong trust model for a solo anonymous viewer with no multiplayer
 * coordination needed). What IS reused, unmodified: WebContainerRuntime
 * itself (boot/writeFile/runForeground/runBackground/waitForPort) and
 * startDevServer (the install -> dev-server -> port pipeline), which
 * was already extracted specifically to be usable against any
 * RuntimeLike with zero Firestore/sessionId coupling - see that
 * function's own doc comment in runtimeSession.ts. This function is a
 * thin new composition of two already-existing, already-tested pieces,
 * not a second boot pipeline.
 *
 * Returns a teardown function - the caller (usePublicProjectPreview)
 * must call it on unmount, same discipline as useRuntimeHost's own
 * effect cleanup, since WebContainer only allows one booted instance
 * per tab.
 */
export async function bootPublicPreview(
  files: PublicProjectFile[],
  callbacks: RuntimeSessionCallbacks
): Promise<() => void> {
  const runtime = new WebContainerRuntime();
  let stopped = false;

  await runtime.boot((message) => {
    if (!stopped) callbacks.onStateChange("crashed", { errorMessage: message });
  });
  if (stopped) return () => runtime.teardown();

  const pkgFile = files.find((f) => f.path === "package.json");
  if (!pkgFile) {
    callbacks.onStateChange("crashed", { errorMessage: "This project has no package.json - nothing to run." });
    return () => runtime.teardown();
  }

  for (const file of files) {
    await runtime.writeFile(file.path, file.content, file.encoding);
  }
  if (stopped) return () => runtime.teardown();

  // startDevServer checks isStopped() before every state-changing call
  // except its own final success path (see its own code) - the caller
  // (usePublicProjectPreview) is responsible for ignoring a late
  // callback that fires just after unmount, same pattern React effect
  // cleanup already uses everywhere else in this app.
  void startDevServer(runtime, pkgFile.content, callbacks, () => stopped);

  return () => {
    stopped = true;
    runtime.teardown();
  };
}
