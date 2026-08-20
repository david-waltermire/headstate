import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { usePollError } from "../api/hooks";
import { getAuthState } from "../api/tauri";

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

  if (isLoading) return null;
  if (data?.ok) {
    return (
      <>
        {pollError !== null && (
          <div
            role="alert"
            className="border-b border-[#f85149]/30 bg-[#f85149]/10 px-4 py-2 text-sm text-[#f85149]"
          >
            Background refresh failed: {pollError}
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
