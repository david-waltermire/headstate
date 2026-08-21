import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { Toaster } from "sonner";
import { AuthGate } from "./components/AuthGate";
import { initSplash } from "./splash";
import "./index.css";

// Starts the splash's minimum-visible window and arms its failsafe. An
// explicit call rather than module-load side effects, so tests can drive
// the timing with fake timers instead of real sleeps.
initSplash();

const queryClient = new QueryClient();

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthGate>
        <App />
      </AuthGate>
      {/* Dark to match the app, and bottom-right so it never covers the
          list the user is acting on. */}
      <Toaster theme="dark" position="bottom-right" richColors />
    </QueryClientProvider>
  </StrictMode>,
);
