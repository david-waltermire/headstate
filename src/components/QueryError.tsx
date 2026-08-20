import type { ReactNode } from "react";

/// The panel shown when a query FAILED, as distinct from returning nothing.
///
/// The distinction is the whole point. A rejected query left `data` at its
/// `[]` default, and the empty-list copy then told the user "no pull
/// requests match these filters" -- a confident, wrong answer to a question
/// the app could not actually answer. An error has to look like an error.
///
/// `message` is the rejection text from the Tauri command, which is already
/// display-ready prose on the Rust side (see `AuthError`'s Display impls);
/// it is rendered verbatim rather than re-wrapped, and never contains the
/// token.
export function QueryError({
  title,
  message,
  onRetry,
  children,
}: {
  title: string;
  message?: string;
  onRetry?: () => void;
  children?: ReactNode;
}) {
  return (
    <div
      role="alert"
      className="rounded-md border border-[#f85149]/40 bg-[#f85149]/5 px-4 py-8 text-center"
    >
      <p className="text-sm font-semibold text-[#f85149]">{title}</p>
      {message ? (
        <p className="mx-auto mt-2 max-w-lg break-words text-sm text-[#8b949e]">{message}</p>
      ) : null}
      {children}
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 rounded border border-[#30363d] px-3 py-1.5 text-sm text-[#e6edf3] hover:bg-[#161b22]"
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}

/// Normalises whatever a rejected Tauri command threw into display prose.
///
/// Tauri surfaces a Rust `Err(String)` as a rejected promise carrying the
/// bare string, but a transport-level failure rejects with an `Error`. Both
/// reach this function, and neither should render as "[object Object]".
export function errorMessage(err: unknown): string | undefined {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return undefined;
}
