import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { Toaster } from "sonner";
import { AuthGate } from "./components/AuthGate";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { PERSIST_KEY } from "./store/filters";
import { initSplash } from "./splash";
import "./index.css";
// Sonner 2.x ships its layout in a SEPARATE stylesheet and its runtime
// never references it. Without this import the toast still mounts and
// still holds the right text, but with no `position: fixed` it lands in
// normal document flow at the bottom of the page: an unstyled black
// block, off-screen, that grows the document and makes a scrollbar
// appear -- which is what the "layout shifts when I click Claudify"
// reports were actually describing.
import "sonner/dist/styles.css";

// Starts the splash's minimum-visible window and arms its failsafe. An
// explicit call rather than module-load side effects, so tests can drive
// the timing with fake timers instead of real sleeps.
initSplash();

const queryClient = new QueryClient();

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    {/* Outside QueryClientProvider and AuthGate on purpose: a throw in
        either of those must still land on a readable screen, and this is
        the only thing left to render it. */}
    <ErrorBoundary onReset={() => localStorage.removeItem(PERSIST_KEY)}>
      <QueryClientProvider client={queryClient}>
        <AuthGate>
          <App />
        </AuthGate>
        {/* Dark to match the app, and bottom-right so it never covers the
            list the user is acting on. */}
        <Toaster theme="dark" position="bottom-right" richColors />
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
