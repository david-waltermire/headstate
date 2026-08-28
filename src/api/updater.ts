import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/// Download and install the pending update, then restart.
///
/// The plugin verifies an Ed25519 signature over the bundle against the
/// public key in `tauri.conf.json` BEFORE writing anything to disk, so
/// an unsigned or tampered archive is rejected rather than installed.
/// That is separate from Apple code signing (#23) and not a substitute:
/// it proves the archive came from our release pipeline, not that macOS
/// trusts the app.
///
/// `onProgress` reports bytes downloaded against the total when the
/// server sends a length. A bundle is ~20 MB, which is long enough on a
/// slow connection that a dialog with no feedback reads as hung.
export async function installUpdate(
  onProgress?: (downloaded: number, total: number | null) => void,
): Promise<void> {
  const update = await check();
  if (!update) {
    // The version check that opened the dialog and this one are
    // separate questions: ours asks GitHub for the latest tag, the
    // plugin asks the manifest. They can disagree if a release exists
    // but its manifest entry does not -- which is exactly the state a
    // partly-failed publish leaves behind.
    throw new Error("No installable update was found for this platform.");
  }

  let downloaded = 0;
  let total: number | null = null;
  await update.downloadAndInstall((event) => {
    if (event.event === "Started") {
      total = event.data.contentLength ?? null;
      onProgress?.(0, total);
    } else if (event.event === "Progress") {
      downloaded += event.data.chunkLength;
      onProgress?.(downloaded, total);
    }
  });

  // Only after a successful install. Relaunching on a failed one would
  // restart into the same version and look like the update silently did
  // nothing.
  await relaunch();
}
