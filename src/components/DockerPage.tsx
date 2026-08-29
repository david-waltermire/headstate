import { useState } from "react";
import { toast } from "sonner";
import {
  useDockerDiskUsage,
  useDockerImages,
  useDockerState,
  useDockerVolumes,
  usePruneCache,
  useRemoveImages,
  useDockerBuilds,
  useRemoveVolume,
} from "../api/hooks";
import { dockerRestart, dockerRunningContainers, dockerStart } from "../api/tauri";
import { formatDockerSize, imageState, imageTone, isStale, isSuperseded } from "../lib/docker";
import { HelpButton } from "./HelpButton";
import {
  buildForImage,
  cachePercent,
  cacheTone,
  formatDuration,
  recentCacheHealth,
} from "../lib/buildJoin";
import { relativeTime } from "../lib/time";

import type { DockerBuild, DockerImage } from "../types/pr";
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
function DiskSummary({
  onPrune,
  builds,
}: {
  onPrune: () => void;
  /// For the cache-health figure. Empty is ordinary -- a machine that
  /// has never built anything has no health to report, and the row
  /// simply omits it.
  builds: DockerBuild[];
}) {
  const { data: du, isError } = useDockerDiskUsage(true);
  const cacheHealth = recentCacheHealth(builds);
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
          <>
            {/* The number the Builds page existed to show, next to the
                cache it describes. A cold build is not a problem in
                itself; a target that USED to be warm and is not any
                more means something invalidated the cache. Sitting
                beside "clear" also makes the trade legible -- clearing
                is what turns this number cold. */}
            {cacheHealth ? (
              <span
                className={cacheTone(cacheHealth.percent)}
                title={`Across the last ${cacheHealth.count} builds, weighted by steps`}
              >
                {cacheHealth.percent}% cached
              </span>
            ) : null}
            {cacheHealth ? (
              <HelpButton topic="build-cache" />
            ) : null}
            {du.build_cache_bytes > 0 ? (
              <button
                type="button"
                onClick={onPrune}
                className="text-[#58a6ff] hover:underline"
              >
                clear
              </button>
            ) : null}
          </>
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
  builds,
}: {
  img: DockerImage;
  onRemove: (img: DockerImage) => void;
  removing: boolean;
  /// Every known build, for the commit join. Empty is ordinary.
  builds: DockerBuild[];
}) {
  const [open, setOpen] = useState(false);
  // Only once the row is expanded: the join is cheap, but the builds
  // themselves are not fetched at all unless something needs them.
  const build = open ? buildForImage(img, builds) : null;
  // An untagged image is exactly the one the user cannot identify, and
  // it is what accumulates from repeated rebuilds. `repository` was on
  // the type all along and never rendered -- so the row said `abc123`
  // where it could have said `registry/app`.
  const name = img.tags[0] ?? `${img.repository}@${img.id.slice(0, 12)}`;

  return (
    <div className="border-b border-[#30363d] px-4 py-2.5 text-sm last:border-b-0">
      <div className="flex items-baseline gap-3">
      {/* The whole row toggles, so the hit target is the row rather
          than a chevron the user has to aim at. */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="min-w-0 flex-1 truncate text-left font-mono text-[#e6edf3] hover:text-white"
      >
        {name}
        {img.tags.length > 1 ? (
          <span className="ml-2 text-xs text-[#8b949e]">+{img.tags.length - 1} more</span>
        ) : null}
        {/* The commit subject is what makes an eight-hex tag mean
            something. Without it the row is a hash and a size. */}
        {img.origin ? (
          <span className="ml-2 text-xs text-[#8b949e]">{img.origin.subject}</span>
        ) : null}
      </button>
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
      {/* The long fields, kept out of the collapsed row. The problem
          was never density -- it was that the identifying detail had
          nowhere to live. */}
      {open ? (
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 border-t border-[#30363d] pt-2 text-xs text-[#8b949e]">
          <dt>Image ID</dt>
          <dd className="font-mono">{img.id}</dd>
          <dt>Repository</dt>
          <dd className="font-mono">{img.repository}</dd>
          {img.tags.length > 0 ? (
            <>
              <dt>Tags</dt>
              <dd className="font-mono">{img.tags.join(", ")}</dd>
            </>
          ) : null}
          {img.created ? (
            <>
              <dt>Created</dt>
              <dd>{img.created}</dd>
            </>
          ) : null}
          {img.origin ? (
            <>
              <dt>Commit</dt>
              <dd className="font-mono">
                {img.origin.commit} — {img.origin.subject}
              </dd>
              <dt className="inline-flex items-center">
                Built from
                {/* Empty provenance looks identical whether the image
                    was pulled or the app is looking in the wrong
                    place -- which it was, silently, until #344. */}
                <HelpButton topic="image-provenance" />
              </dt>
              <dd className="font-mono">{img.origin.context ?? img.origin.repo_path}</dd>
              <dt>Branch</dt>
              <dd>{img.origin.merged ? "merged" : "still open"}</dd>
            </>
          ) : (
            <>
              <dt>Origin</dt>
              {/* Says WHY there is nothing to show. "unknown" alone
                  reads as a missing feature rather than a fact about
                  this image. */}
              <dd>
                could not be traced to a commit — nothing in the local repos matched
                its tag
              </dd>
            </>
          )}
          {/* The Builds page folded in here (#326).
              
              A build's duration and cache ratio are facts about the
              IMAGE it produced, and on their own page they were a log
              nobody could act on. Matched on the commit: `buildx
              history` records a VCS Revision and these images are
              tagged with it, so the key was already on both sides --
              no new field was needed.
              
              Absent freely: a project that tags by version rather than
              by commit matches nothing here, which is ordinary rather
              than an error. */}
          {build ? (
            <>
              <dt>Build</dt>
              <dd>
                {formatDuration(build.duration_secs)}
                {build.total_steps > 0 ? (
                  <span className={`ml-2 ${cacheTone(cachePercent(build))}`}>
                    {cachePercent(build)}% cached
                  </span>
                ) : null}
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}
    </div>
  );
}

export function DockerPage() {
  const { data: state } = useDockerState();
  const up = state?.kind === "running";
  const { data: images, isLoading, isError, error, refetch } = useDockerImages(up);
  const { data: volumes } = useDockerVolumes(up);
  const removeImages = useRemoveImages();
  // For the build join on an expanded row (#326). Fetched with the
  // page rather than per row: one listing serves every image, and the
  // Builds page it replaces fetched exactly this.
  const { data: builds = [] } = useDockerBuilds(up);
  const removeVolume = useRemoveVolume();
  const prune = usePruneCache();

  const [pending, setPending] = useState<DockerImage | null>(null);
  /// Which bulk set the confirmation is for, or null when closed.
  ///
  /// "stale" is the conservative set (superseded AND merged AND unused);
  /// "superseded" is every superseded image we can prove is unused. They
  /// share a dialog because everything except the wording and the
  /// membership rule is identical.
  const [bulkOpen, setBulkOpen] = useState<null | "stale" | "superseded">(null);
  // Whether the confirmation is showing the WIDE set. Reset each time
  // the dialog opens, so a previous session's choice cannot silently
  // widen a later removal.
  const [includeWider, setIncludeWider] = useState(false);
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
  // Every superseded image we can prove is unused -- a SUPERSET of
  // `stale`, and on a real machine a much larger one: `isStale` also
  // requires that the image was attributed to a branch and that the
  // branch merged, which excludes everything nothing could attribute.
  const superseded = shown.filter(isSuperseded);
  // What the confirmation is actually about.
  const bulkSet = includeWider ? superseded : stale;
  const bulkBytes = bulkSet.reduce((n, i) => n + i.size_bytes, 0);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="inline-flex items-center font-semibold">
          Images
          {/* Two near-identical words decide what a bulk removal takes,
              and the difference was already reported as unreadable. */}
          <HelpButton topic="image-states" />
        </span>
        <span className="text-[#8b949e]">{shown.length}</span>
        {stale.length > 0 ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setIncludeWider(false);
              setBulkOpen("stale");
            }}
            className="rounded border border-[#f85149]/40 px-2 py-0.5 text-xs text-[#f85149] hover:bg-[#f85149]/10 disabled:opacity-50"
          >
            Remove {stale.length} stale image{stale.length === 1 ? "" : "s"}
          </button>
        ) : null}
        {/* ONE entry point, not two. Measured on a real machine:
            18 stale against 19 superseded -- two buttons one apart in
            count, doing near-identical things. The wide set is now an
            opt-in inside the confirmation, where the images are already
            listed individually, rather than a competing button whose
            difference the reader had to work out by subtraction. */}
        <button
          type="button"
          onClick={() => dockerRunningContainers().then(setRestartOpen)}
          className="ml-auto text-xs text-[#8b949e] hover:text-[#e6edf3]"
        >
          Restart Docker
        </button>
      </div>

      <DiskSummary
        builds={builds}
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
              builds={builds}
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
        <Dialog open onOpenChange={(o) => !o && setBulkOpen(null)}>
          <DialogContent className="max-w-2xl">
            <DialogTitle>
              Remove {bulkSet.length}{" "}
              {bulkOpen === "superseded" ? "superseded" : "stale"} image
              {bulkSet.length === 1 ? "" : "s"}?
            </DialogTitle>
            {/* The wider set needs a DIFFERENT sentence, not a louder
                one: some of its images belong to branches that are
                still open, and the dialog has to say so plainly rather
                than reuse the reassurance that fits the narrow set. */}
            <p className="mt-2 text-sm text-[#8b949e]">
              Reclaims {formatDockerSize(bulkBytes || null)}.{" "}
              {bulkOpen === "superseded"
                ? "Each one has been replaced by a newer build and nothing is running it — but some belong to branches that are still open, so check the list."
                : "Every one is superseded and its branch has merged, so nothing will want it again."}
            </p>
            {/* The wider set as an OPT-IN, and only when it actually
                covers more. Named with its difference so the choice has
                a stated reason rather than leaving the reader to
                subtract two counts. */}
            {superseded.length > stale.length ? (
              <label className="mt-3 flex items-center gap-2 text-sm text-[#d29922]">
                <input
                  type="checkbox"
                  checked={includeWider}
                  onChange={() => setIncludeWider((v) => !v)}
                />
                Also remove {superseded.length - stale.length} superseded image
                {superseded.length - stale.length === 1 ? "" : "s"} whose branch is
                still open or could not be traced
              </label>
            ) : null}
            <ul className="mt-3 max-h-64 overflow-y-auto font-mono text-xs text-[#8b949e]">
              {bulkSet.map((i) => (
                <li key={i.id} className="py-0.5">
                  {i.repository}:{i.tags[0] ?? i.id.slice(0, 12)} — {formatDockerSize(i.size_bytes)}
                </li>
              ))}
            </ul>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setBulkOpen(null)}
                className="rounded border border-[#30363d] px-3 py-1.5 text-sm hover:bg-[#21262d]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const targets = bulkSet.map((i) => i.id);
                  const freed = bulkBytes;
                  setBulkOpen(null);
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
                Remove {bulkSet.length} image{bulkSet.length === 1 ? "" : "s"}
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
