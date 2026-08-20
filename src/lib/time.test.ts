import { describe, expect, it } from "vitest";
import { relativeTime } from "./time";

const now = new Date("2026-08-19T12:00:00Z");

describe("relativeTime", () => {
  it("reports just now for sub-minute diffs", () => {
    expect(relativeTime("2026-08-19T11:59:30Z", now)).toBe("just now");
  });

  it("reports minutes, singular and plural", () => {
    expect(relativeTime("2026-08-19T11:59:00Z", now)).toBe("1 minute ago");
    expect(relativeTime("2026-08-19T11:55:00Z", now)).toBe("5 minutes ago");
  });

  it("reports hours, singular and plural", () => {
    expect(relativeTime("2026-08-19T11:00:00Z", now)).toBe("1 hour ago");
    expect(relativeTime("2026-08-19T09:00:00Z", now)).toBe("3 hours ago");
  });

  it("reports days, singular and plural", () => {
    expect(relativeTime("2026-08-18T12:00:00Z", now)).toBe("1 day ago");
    expect(relativeTime("2026-08-15T12:00:00Z", now)).toBe("4 days ago");
  });

  it("reports months once past 30 days", () => {
    expect(relativeTime("2026-07-19T12:00:00Z", now)).toBe("1 month ago");
    expect(relativeTime("2026-05-19T12:00:00Z", now)).toBe("3 months ago");
  });
});
