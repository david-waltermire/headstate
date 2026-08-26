import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useScrollReset } from "./scrollReset";
import { createRef } from "react";

function container() {
  const el = document.createElement("div");
  el.scrollTo = vi.fn();
  return { ref: { current: el as HTMLElement | null }, scrollTo: el.scrollTo as ReturnType<typeof vi.fn> };
}

describe("useScrollReset", () => {
  it("does not scroll on the first render", () => {
    const { ref, scrollTo } = container();
    renderHook(() => useScrollReset(ref, "my-prs||"));
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("scrolls to the top when the destination changes", () => {
    const { ref, scrollTo } = container();
    const { rerender } = renderHook(({ d }) => useScrollReset(ref, d), {
      initialProps: { d: "my-prs|list||octocat/hello#1" },
    });
    rerender({ d: "my-prs|list|octocat/hello|" });
    expect(scrollTo).toHaveBeenCalledWith({ top: 0 });
  });

  /// The half that matters most. A poll tick re-renders the same view
  /// with fresh data; scrolling the user to the top there would be a
  /// worse bug than the one this hook fixes.
  it("leaves the scroll alone when the same destination re-renders", () => {
    const { ref, scrollTo } = container();
    const { rerender } = renderHook(({ d }) => useScrollReset(ref, d), {
      initialProps: { d: "my-prs|list||" },
    });
    rerender({ d: "my-prs|list||" });
    rerender({ d: "my-prs|list||" });
    expect(scrollTo).not.toHaveBeenCalled();
  });

  /// jsdom does not implement `scrollTo`, and neither do some older
  /// webviews. A missing DOM method must not take the render down --
  /// this hook is cosmetic, and the fallback is always available.
  it("falls back to scrollTop when scrollTo is unavailable", () => {
    const el = document.createElement("div");
    el.scrollTop = 500;
    const ref = { current: el as HTMLElement | null };
    const { rerender } = renderHook(({ d }) => useScrollReset(ref, d), {
      initialProps: { d: "a" },
    });
    expect(() => rerender({ d: "b" })).not.toThrow();
    expect(el.scrollTop).toBe(0);
  });

  it("survives a null container without throwing", () => {
    const ref = createRef<HTMLElement>();
    const { rerender } = renderHook(({ d }) => useScrollReset(ref, d), {
      initialProps: { d: "a" },
    });
    expect(() => rerender({ d: "b" })).not.toThrow();
  });
});
