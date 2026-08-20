import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it } from "vitest";
import { PR_FIXTURES } from "../fixtures/prs";
import type { Stats } from "../types/pr";
import { getAuthState, getCached, getStats, refreshNow } from "./tauri";

afterEach(() => {
  clearMocks();
});

describe("tauri command wrappers", () => {
  it("getCached invokes get_cached and returns the payload", async () => {
    mockIPC((cmd) => (cmd === "get_cached" ? PR_FIXTURES : undefined));
    await expect(getCached()).resolves.toEqual(PR_FIXTURES);
  });

  it("refreshNow invokes refresh_now", async () => {
    mockIPC((cmd) => (cmd === "refresh_now" ? [PR_FIXTURES[0]] : undefined));
    await expect(refreshNow()).resolves.toEqual([PR_FIXTURES[0]]);
  });

  it("getStats invokes get_stats", async () => {
    const stats: Stats = {
      merged_week: 3,
      merged_month: 9,
      in_merge_queue: 0,
      needs_attention: 0,
      awaiting_review: 0,
      ready_to_queue: 0,
      blocked_by_comments: 0,
    };
    mockIPC((cmd) => (cmd === "get_stats" ? stats : undefined));
    await expect(getStats()).resolves.toEqual(stats);
  });

  it("getAuthState invokes get_auth_state", async () => {
    mockIPC((cmd) =>
      cmd === "get_auth_state" ? { ok: true, message: "" } : undefined,
    );
    await expect(getAuthState()).resolves.toEqual({ ok: true, message: "" });
  });

  it("propagates a Rust Err(String) as a rejected promise", async () => {
    mockIPC((cmd) => {
      if (cmd === "refresh_now") throw "not authenticated: run `gh auth login`";
      return undefined;
    });
    await expect(refreshNow()).rejects.toBe("not authenticated: run `gh auth login`");
  });
});
