import { useQuery } from "@tanstack/react-query";
import { useEffect, type ReactNode } from "react";
import { clearPollError, usePollError, useStoreError } from "../api/hooks";
import { getAuthState } from "../api/tauri";
import { dismissSplash } from "../splash";

/// Gates the whole app on `get_auth_state`. Rust computes auth once at
/// startup from the `gh` CLI token, so this is a one-shot check, not a
/// poll -- `staleTime: Infinity` avoids a pointless refetch on window
/// focus for a value that cannot change without an app restart.
///
/// `isLoading` and "authenticated but not yet ok" are deliberately
/// distinct from the failure screen below: returning `null` while loading
/// avoids flashing the "install gh" message for authenticated users before
/// the first render settles.
export function AuthGate({ children }: { children: ReactNode }) {
  const { data, isLoading } = useQuery({
    queryKey: ["auth"],
    queryFn: getAuthState,
    staleTime: Infinity,
  });
  const pollError = usePollError();
  const storeError = useStoreError();

  // Dismissal belongs HERE, not in `App`, and keys off the auth check
  // having SETTLED rather than succeeded.
  //
  // `App` only mounts when auth is ok, so dismissing there left an
  // unauthenticated machine showing the splash forever -- with the "needs
  // the GitHub CLI" screen rendered correctly underneath a fixed,
  // inset-0, z-index-9999 overlay that hides it. Anything that leaves the
  // app on a non-App branch must still uncover the window; the only state
  // that should hold the splash is "we do not know yet".
  useEffect(() => {
    if (!isLoading) dismissSplash();
  }, [isLoading]);

  if (isLoading) return null;
  if (data?.ok) {
    return (
      <>
        {/* Its own banner, on its own channel. A store failure describes
            a condition a later successful poll did not fix, so it must
            not be cleared by one -- which is what sharing `poll-error`
            did, microseconds after it appeared. */}
        {storeError.message !== null && (
          <div
            role="alert"
            className="flex items-start gap-2 border-b border-[#d29922]/30 bg-[#d29922]/10 px-4 py-2 text-sm text-[#d29922]"
          >
            <span className="flex-1">
              {storeError.message} Your pull requests are still live; only the local
              cache is affected.
            </span>
            <button
              type="button"
              onClick={storeError.dismiss}
              aria-label="Dismiss"
              className="shrink-0 rounded px-1 hover:bg-[#d29922]/20"
            >
              ×
            </button>
          </div>
        )}
        {pollError !== null && (
          <div
            role="alert"
            className="flex items-start gap-2 border-b border-[#f85149]/30 bg-[#f85149]/10 px-4 py-2 text-sm text-[#f85149]"
          >
            <span className="flex-1">
            Background refresh failed: {pollError}
            {/* The token is read once at startup and held for the process
                lifetime, so a revoked or expired one 401s forever with the
                list silently going stale. A relaunch is the actual fix;
                saying so beats an opaque message the user cannot act on.
                Refreshing the token in-process is tracked separately. */}
            {/401|unauthorized|bad credentials/i.test(pollError) ? (
              <span className="ml-1">
                Your GitHub token may have expired — run <code>gh auth login</code> and
                restart Headstate.
              </span>
            ) : null}
            </span>
            {/* Dismissable: a rate limit the user has read is not
                information worth pinning for an hour, and its own text
                says polling resumes automatically. */}
            <button
              type="button"
              onClick={clearPollError}
              aria-label="Dismiss"
              className="shrink-0 rounded px-1 hover:bg-[#f85149]/20"
            >
              ×
            </button>
          </div>
        )}
        {children}
      </>
    );
  }

  return (
    <div className="flex h-screen items-center justify-center bg-[#0d1117] text-[#e6edf3]">
      <div className="max-w-md space-y-4">
        <h1 className="text-xl font-semibold">Headstate needs the GitHub CLI</h1>
        <p className="text-sm text-[#8b949e]">{data?.message}</p>
        <pre className="rounded bg-[#161b22] p-3 text-sm">
          brew install gh{"\n"}gh auth login
        </pre>
        <p className="text-sm text-[#8b949e]">
          Headstate reads your token from <code>gh</code> and keeps it in memory only.
        </p>
      </div>
    </div>
  );
}
