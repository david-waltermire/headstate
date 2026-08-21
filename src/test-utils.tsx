import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";

/// Render with a QueryClient.
///
/// Components below the list level now reach for the query cache -- the
/// kebab menu invalidates `prs` after acting -- so a bare `render` throws
/// "No QueryClient set" for a component whose test has nothing to do with
/// fetching. Retries are off so a failing query surfaces immediately
/// instead of after three silent attempts.
export function renderWithQuery(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}
