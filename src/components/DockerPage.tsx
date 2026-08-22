import { useState } from "react";
import { toast } from "sonner";
import {
  useDockerDiskUsage,
  useDockerImages,
  useDockerState,
  useDockerVolumes,
  usePruneCache,
  useRemoveImages,
  useRemoveVolume,
} from "../api/hooks";
import { dockerRestart, dockerRunningContainers, dockerStart } from "../api/tauri";
import { formatDockerSize, imageState, imageTone, isStale } from "../lib/docker";
import { relativeTime } from "../lib/time";

import type { DockerImage } from "../types/pr";
import { QueryError, errorMessage } from "./QueryError";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";

/// One line of the disk summary.
///
/// Declared here rather than inside `DiskSummary`: a component created
/// during render is a new type on every pass, so React remounts it and
/// resets its state each time.
function UsageRow({
  label,
  size,
  extra,
}: {
  label: string;
  size: number;
  extra?: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="w-28 shrink-0 text-[#8b949e]">{label}</span>
      <span className="tabular-nums">{formatDockerSize(size || null)}</span>
      {extra}
    </div>
  );
}

/// Where the disk actually went.
///
/// Images are only part of it: measured on a real machine, 17.35GB of
/// images sat beside 4.65GB of build cache and a 4.74GB orphaned volume.
/// A page that listed only images would leave most of the waste
/// invisible, so the summary leads.
function DiskSummary({ onPrune }: { onPrune: () => void }) {
  const { data: du, isError } = useDockerDiskUsage(true);
  if (isError) {
    // Vanishing silently is a wrong answer by omission: this panel leads
    // the page and is the argument for the feature existing.
    return (
      <div className="rounded-md border border-[#30363d] p-3 text-xs text-[#8b949e]">
        Could not read Docker disk usage.
      </div>
    );
  }
  if (!du) return null;

  return (
    <div className="rounded-md border border-[#30363d] p-3 text-xs">
      <UsageRow label="Images" size={du.images_bytes} />
      <UsageRow
        label="Build cache"
        size={du.build_cache_bytes}
        extra={
          du.build_cache_bytes > 0 ? (
            <button
              type="button"
              onClick={onPrune}
              className="text-[#58a6ff] hover:underline"
            >
              clear
            </button>
          ) : null
        }
      />
      <UsageRow label="Volumes" size={du.volumes_bytes} />
    </div>
  );
}

function ImageRow({
  img,
  onRemove,
  removing,
}: {
  img: DockerImage;
  onRemove: (img: DockerImage) => void;
  removing: boolean;
}) {
  return (
    <div className="flex items-baseline gap-3 border-b border-[#30363d] px-4 py-2.5 text-sm last:border-b-0">
      <span className="min-w-0 flex-1 truncate font-mono text-[#e6edf3]">
        {img.tags[0] ?? img.id.slice(0, 12)}
        {img.tags.length > 1 ? (
          <span className="ml-2 text-xs text-[#8b949e]">+{img.tags.length - 1} more</span>
        ) : null}
        {/* The commit subject is what makes an eight-hex tag mean
            something. Without it the row is a hash and a size. */}
        {img.origin ? (
          <span className="ml-2 text-xs text-[#8b949e]">{img.origin.subject}</span>
        ) : null}
      </span>
      <span className={`shrink-0 text-xs ${imageTone(img)}`}>{imageState(img)}</span>
      {img.created ? (
        <span className="shrink-0 text-xs text-[#8b949e]">{relativeTime(img.created)}</span>
      ) : null}
      <span className="w-20 shrink-0 text-right tabular-nums text-xs text-[#8b949e]">
        {formatDockerSize(img.size_bytes)}
      </span>
      <button
        type="button"
        disabled={img.in_use !== false || removing}
        onClick={() => onRemove(img)}
        title={
          img.in_use === true
            ? "A running container is using this image"
            : img.in_use === null
              ? "Could not check whether a container is using this image"
              : "Remove this image"
        }
        className={`shrink-0 rounded border px-2 py-0.5 text-xs ${
          img.in_use !== false || removing
            ? "border-[#30363d] text-[#8b949e] opacity-50"
            : "border-[#f85149]/40 text-[#f85149] hover:bg-[#f85149]/10"
        }`}
      >
        {removing ? "Removing…" : "Remove"}
      </button>
    </div>
  );
}

export function DockerPage() {
  const { data: state } = useDockerState();
  const up = state?.kind === "running";
  const { data: images, isLoading, isError, error, refetch } = useDockerImages(up);
  const { data: volumes } = useDockerVolumes(up);
  const removeImages = useRemoveImages();
  const removeVolume = useRemoveVolume();
  const prune = usePruneCache();

  const [pending, setPending] = useState<DockerImage | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [restartOpen, setRestartOpen] = useState<string[] | null>(null);

  // Docker being off is NORMAL, not an error. An empty image list would
  // say "your machine is clean" when the truth is we could not ask.
  if (state && !up) {
    const notInstalled = state.kind === "not_installed";
    // Unknown carries the REAL message -- a 20s timeout, a
    // permission-denied socket, a broken context -- and used to fall
    // into the "not running" branch, discarding the detail and offering
    // a Start button that cannot help because Docker is already running.
    // Its fix is nothing like "start Docker", so it gets its own screen
    // rather than a Start button that cannot help.
    if (state.kind === "permission_denied") {
      return (
        <div className="rounded-md border border-[#30363d] px-4 py-12 text-center">
          <p className="text-sm font-semibold text-[#e6edf3]">Docker refused the connection</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-[#8b949e]">
            Your user is probably not in the <code>docker</code> group. Run{" "}
            <code>sudo usermod -aG docker $USER</code>, then log out and back in.
          </p>
        </div>
      );
    }
    if (state.kind === "unknown") {
      return (
        <div className="rounded-md border border-[#30363d] px-4 py-12 text-center">
          <p className="text-sm font-semibold text-[#e6edf3]">Could not talk to Docker</p>
          <p className="mx-auto mt-2 max-w-xl break-words text-sm text-[#8b949e]">
            {state.detail}
          </p>
          {/permission denied/i.test(state.detail) ? (
            <p className="mx-auto mt-2 max-w-md text-sm text-[#8b949e]">
              On Linux this usually means your user is not in the <code>docker</code>{" "}
              group: <code>sudo usermod -aG docker $USER</code>, then log out and back in.
            </p>
          ) : null}
        </div>
      );
    }
    return (
      <div className="rounded-md border border-[#30363d] px-4 py-12 text-center">
        <p className="text-sm font-semibold text-[#e6edf3]">
          {notInstalled ? "Docker was not found" : "Docker is not running"}
        </p>
        <p className="mx-auto mt-2 max-w-md text-sm text-[#8b949e]">
          {notInstalled
            ? "Install Docker Desktop, or set HEADSTATE_DOCKER to the docker binary."
            : "Start it to see images and reclaim disk space."}
        </p>
        {!notInstalled ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              dockerStart().then(
                () => {
                  setBusy(false);
                  toast.success("Starting Docker…");
                },
                (e: unknown) => {
                  setBusy(false);
                  toast.error("Could not start Docker", {
                    description: typeof e === "string" ? e : undefined,
                  });
                },
              );
            }}
            className="mt-4 rounded border border-[#30363d] px-3 py-1.5 text-sm hover:bg-[#161b22] disabled:opacity-50"
          >
            {busy ? "Starting…" : "Start Docker"}
          </button>
        ) : null}
      </div>
    );
  }

  const shown = images ?? [];
  const stale = shown.filter(isStale);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="font-semibold">Images</span>
        <span className="text-[#8b949e]">{shown.length}</span>
        {stale.length > 0 ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => setBulkOpen(true)}
            className="rounded border border-[#f85149]/40 px-2 py-0.5 text-xs text-[#f85149] hover:bg-[#f85149]/10 disabled:opacity-50"
          >
            Remove {stale.length} stale image{stale.length === 1 ? "" : "s"}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => dockerRunningContainers().then(setRestartOpen)}
          className="ml-auto text-xs text-[#8b949e] hover:text-[#e6edf3]"
        >
          Restart Docker
        </button>
      </div>

      <DiskSummary
        onPrune={() =>
          // A week, not everything: the last day's cache is what makes
          // today's builds fast, while a month-old entry is unlikely to
          // be helping any current work.
          prune("168h").then(
            (freed) => toast.success(`Freed ${formatDockerSize(freed || null)} of build cache`),
            (e: unknown) =>
              toast.error("Could not clear the build cache", {
                description: typeof e === "string" ? e : undefined,
              }),
          )
        }
      />

      <div className="rounded-md border border-[#30363d]">
        {isLoading ? (
          <div className="px-4 py-12 text-center text-sm text-[#8b949e]">Reading images…</div>
        ) : isError ? (
          // NOT an empty list. On a disk-cleanup tool "No images." reads
          // as "your machine is clean" when the truth is we could not
          // ask -- the exact pattern this codebase forbids.
          <QueryError
            title="Could not read Docker images"
            message={errorMessage(error)}
            onRetry={() => void refetch()}
          />
        ) : shown.length === 0 ? (
          <div className="px-4 py-12 text-center text-sm text-[#8b949e]">No images.</div>
        ) : (
          shown.map((img) => (
            <ImageRow
              key={img.id}
              img={img}
              removing={removing === img.id}
              onRemove={setPending}
            />
          ))
        )}
      </div>

      {volumes && volumes.length > 0 ? (
        <div className="rounded-md border border-[#30363d] p-3 text-xs">
          <p className="mb-2 font-semibold text-[#e6edf3]">Volumes attached to nothing</p>
          {/* Individually, never bulk: a dangling volume can hold a
              database someone still wants. A wrongly deleted image costs
              a rebuild; this costs data. */}
          {volumes.map((v) => (
            <div key={v.name} className="flex items-baseline gap-3 py-0.5">
              <span className="flex-1 truncate font-mono">{v.name}</span>
              <span className="tabular-nums text-[#8b949e]">{formatDockerSize(v.size_bytes || null)}</span>
              <button
                type="button"
                onClick={() => {
                  if (!window.confirm(`Delete volume ${v.name}? Its contents cannot be recovered.`))
                    return;
                  removeVolume(v.name).then(
                    () => toast.success(`Removed ${v.name}`),
                    (e: unknown) =>
                      toast.error(`Could not remove ${v.name}`, {
                        description: typeof e === "string" ? e : undefined,
                      }),
                  );
                }}
                className="rounded border border-[#f85149]/40 px-2 py-0.5 text-[#f85149] hover:bg-[#f85149]/10"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {pending ? (
        <Dialog open onOpenChange={(o) => !o && setPending(null)}>
          <DialogContent className="max-w-lg">
            <DialogTitle>Remove this image?</DialogTitle>
            <p className="mt-3 break-all font-mono text-xs text-[#8b949e]">
              {pending.repository}
              {pending.tags.length > 0 ? `:${pending.tags.join(", :")}` : ""}
            </p>
            <p className="mt-2 text-sm text-[#8b949e]">
              {formatDockerSize(pending.size_bytes)} · {imageState(pending)}
              {pending.origin ? ` · ${pending.origin.subject}` : ""}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPending(null)}
                className="rounded border border-[#30363d] px-3 py-1.5 text-sm hover:bg-[#21262d]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const target = pending;
                  setPending(null);
                  setRemoving(target.id);
                  removeImages([target.id]).then(
                    (outcomes) => {
                      setRemoving(null);
                      const failed = outcomes.find((o) => o.error !== null);
                      if (failed) {
                        toast.error("Could not remove the image", {
                          description: failed.error ?? undefined,
                        });
                      } else {
                        toast.success(`Removed ${formatDockerSize(target.size_bytes)}`);
                      }
                    },
                    (e: unknown) => {
                      setRemoving(null);
                      toast.error("Could not remove the image", {
                        description: typeof e === "string" ? e : undefined,
                      });
                    },
                  );
                }}
                className="rounded bg-[#da3633] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#f85149]"
              >
                Remove
              </button>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}

      {bulkOpen ? (
        <Dialog open onOpenChange={(o) => !o && setBulkOpen(false)}>
          <DialogContent className="max-w-2xl">
            <DialogTitle>
              Remove {stale.length} stale image{stale.length === 1 ? "" : "s"}?
            </DialogTitle>
            <p className="mt-2 text-sm text-[#8b949e]">
              Reclaims {formatDockerSize(stale.reduce((n, i) => n + i.size_bytes, 0) || null)}. Every one
              is superseded and its branch has merged, so nothing will want it again.
            </p>
            <ul className="mt-3 max-h-64 overflow-y-auto font-mono text-xs text-[#8b949e]">
              {stale.map((i) => (
                <li key={i.id} className="py-0.5">
                  {i.repository}:{i.tags[0] ?? i.id.slice(0, 12)} — {formatDockerSize(i.size_bytes)}
                </li>
              ))}
            </ul>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setBulkOpen(false)}
                className="rounded border border-[#30363d] px-3 py-1.5 text-sm hover:bg-[#21262d]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const targets = stale.map((i) => i.id);
                  const freed = stale.reduce((n, i) => n + i.size_bytes, 0);
                  setBulkOpen(false);
                  setBusy(true);
                  removeImages(targets).then(
                    (outcomes) => {
                      setBusy(false);
                      const failed = outcomes.filter((o) => o.error !== null);
                      if (failed.length === 0) {
                        toast.success(`Removed ${outcomes.length}, freeing ${formatDockerSize(freed)}`);
                      } else {
                        toast.error(`${failed.length} of ${outcomes.length} could not be removed`, {
                          description: failed.map((f) => f.error).join("\n"),
                        });
                      }
                    },
                    (e: unknown) => {
                      setBusy(false);
                      toast.error("The removal could not run", {
                        description: typeof e === "string" ? e : undefined,
                      });
                    },
                  );
                }}
                className="rounded bg-[#da3633] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#f85149]"
              >
                Remove {stale.length} image{stale.length === 1 ? "" : "s"}
              </button>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}

      {restartOpen !== null ? (
        <Dialog open onOpenChange={(o) => !o && setRestartOpen(null)}>
          <DialogContent className="max-w-lg">
            <DialogTitle>Restart Docker?</DialogTitle>
            {/* Name what will be stopped: the user may have a database
                up that they would otherwise notice the hard way. */}
            <p className="mt-3 text-sm text-[#8b949e]">
              {restartOpen.length === 0
                ? "No containers are running."
                : `${restartOpen.length} running container${
                    restartOpen.length === 1 ? "" : "s"
                  } will be stopped: ${restartOpen.join(", ")}`}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRestartOpen(null)}
                className="rounded border border-[#30363d] px-3 py-1.5 text-sm hover:bg-[#21262d]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setRestartOpen(null);
                  setBusy(true);
                  dockerRestart().then(
                    () => {
                      setBusy(false);
                      toast.success("Docker restarted");
                    },
                    (e: unknown) => {
                      setBusy(false);
                      toast.error("Could not restart Docker", {
                        description: typeof e === "string" ? e : undefined,
                      });
                    },
                  );
                }}
                className="rounded bg-[#da3633] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#f85149]"
              >
                Restart
              </button>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
