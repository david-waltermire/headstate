import { describe, expect, it } from "vitest";
import { rerunnableRun } from "./rerun";

describe("rerunnableRun", () => {
  it("finds the run behind a failing check", () => {
    expect(rerunnableRun([{ state: "failure", run_id: 42 }])).toBe(42);
  });

  // Re-running a green pull request either does nothing or re-runs
  // passing work. Neither is what the button says.
  it("offers nothing when everything passed", () => {
    expect(rerunnableRun([{ state: "success", run_id: 42 }])).toBeNull();
  });

  it("offers nothing while checks are still running", () => {
    expect(rerunnableRun([{ state: "pending", run_id: 42 }])).toBeNull();
  });

  // A plain commit status has no workflow run, so the REST call would
  // 404. Better to not offer the button than to fail on click.
  it("offers nothing for a failure with no workflow run", () => {
    expect(rerunnableRun([{ state: "failure", run_id: null }])).toBeNull();
  });

  // The realistic mixed case: a status context failed alongside an
  // Actions job. The Actions run is the one that can be re-run.
  it("skips a non-rerunnable failure to find a rerunnable one", () => {
    expect(
      rerunnableRun([
        { state: "failure", run_id: null },
        { state: "failure", run_id: 7 },
      ]),
    ).toBe(7);
  });

  it("offers nothing for an empty check list", () => {
    expect(rerunnableRun([])).toBeNull();
  });
});
