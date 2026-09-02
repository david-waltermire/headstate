import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeFile, ImportNode } from "@/types/pr";

const copyFn = vi.hoisted(() => vi.fn(() => Promise.resolve(null as string | null)));
const state = vi.hoisted(() => ({
  repo: "/code/app" as string | undefined,
  files: [] as ClaudeFile[],
  loading: false,
  text: "# hello" as string | undefined,
}));

vi.mock("../api/hooks", () => ({
  useClaudeMd: () => ({ data: state.files, isLoading: state.loading }),
  useClaudeMdText: () => ({ data: state.text, isLoading: false }),
}));
vi.mock("../store/filters", () => ({ useActiveFilters: () => ({ repo: state.repo }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/clipboard", () => ({ copyText: copyFn }));

import { ClaudeMdPage } from "./ClaudeMdPage";

const node = (over: Partial<ImportNode> = {}): ImportNode => ({
  raw: "@shared.md",
  path: "/code/app/shared.md",
  bytes: 400,
  tokens: 100,
  problem: null,
  children: [],
  ...over,
});

const file = (over: Partial<ClaudeFile> = {}): ClaudeFile => ({
  path: "/code/app/CLAUDE.md",
  bytes: 2000,
  tokens: 500,
  total_tokens: 500,
  imports: [],
  ...over,
});

beforeEach(() => {
  copyFn.mockClear();
  copyFn.mockResolvedValue(null);
  state.repo = "/code/app";
  state.files = [];
  state.loading = false;
  state.text = "# hello";
});

describe("ClaudeMdPage", () => {
  it("asks for a repository first", () => {
    state.repo = undefined;
    render(<ClaudeMdPage />);
    expect(screen.getByText(/Choose a repository/)).toBeTruthy();
  });

  it("says so when a repository has none", () => {
    render(<ClaudeMdPage />);
    expect(screen.getByText(/No CLAUDE.md files/)).toBeTruthy();
  });

  /// Every token figure is an ESTIMATE -- chars/4, not a tokeniser --
  /// and a number labelled "tokens" that is not measured is exactly the
  /// confidently-wrong figure this app refuses to ship.
  it("labels every token count as an estimate", () => {
    state.files = [file()];
    render(<ClaudeMdPage />);
    expect(screen.getByText(/est\. tokens/)).toBeTruthy();
  });

  /// The number that matters: a small file pulling in a large tree.
  it("states the whole-tree cost when imports add to it", () => {
    state.files = [file({ tokens: 500, total_tokens: 4000, imports: [node()] })];
    render(<ClaudeMdPage />);
    expect(screen.getByText(/4,000 est\. tokens with imports/)).toBeTruthy();
  });

  /// Two equal numbers printed side by side read as a mistake.
  it("does not repeat the total when there are no imports", () => {
    state.files = [file({ tokens: 500, total_tokens: 500 })];
    render(<ClaudeMdPage />);
    expect(screen.queryByText(/with imports/)).toBeNull();
  });

  /// A broken import must be NAMED. Dropping it makes the tree look
  /// complete when it is not.
  it("shows a broken import rather than omitting it", () => {
    state.files = [
      file({ imports: [node({ raw: "@gone.md", path: null, problem: "file not found" })] }),
    ];
    render(<ClaudeMdPage />);
    expect(screen.getByText("@gone.md")).toBeTruthy();
    expect(screen.getByText("file not found")).toBeTruthy();
  });

  /// A cycle is a bug in the user's own config, and this view is the
  /// only thing that will surface it.
  it("names a circular import", () => {
    state.files = [file({ imports: [node({ problem: "circular import" })] })];
    render(<ClaudeMdPage />);
    expect(screen.getByText("circular import")).toBeTruthy();
  });

  /// Imports are transitive, so the tree must nest rather than flatten.
  it("renders nested imports", () => {
    state.files = [
      file({ imports: [node({ raw: "@a.md", children: [node({ raw: "@leaf.md" })] })] }),
    ];
    render(<ClaudeMdPage />);
    expect(screen.getByText("@a.md")).toBeTruthy();
    expect(screen.getByText("@leaf.md")).toBeTruthy();
  });

  it("renders the selected file's content", () => {
    state.files = [file()];
    state.text = "# The rules";
    render(<ClaudeMdPage />);
    expect(screen.getByText("The rules")).toBeTruthy();
  });
});

describe("ClaudeMdPage browser", () => {
  /// The reported problem: "the file paths now are so long that it is
  /// impossible to tell what they are". A truncated absolute path eats
  /// exactly the middle segment that distinguishes one file from
  /// another.
  it("shows the path relative to the repository, not the absolute one", () => {
    state.repo = "/code/app";
    state.files = [file({ path: "/code/app/services/api/CLAUDE.md" })];
    render(<ClaudeMdPage />);
    expect(screen.getByText("services/api/")).toBeTruthy();
    expect(screen.getByText("CLAUDE.md")).toBeTruthy();
    expect(screen.queryByText("/code/app/services/api/CLAUDE.md")).toBeNull();
  });

  it("copies the relative path from the context menu", async () => {
    state.repo = "/code/app";
    state.files = [file({ path: "/code/app/services/api/CLAUDE.md" })];
    render(<ClaudeMdPage />);

    fireEvent.contextMenu(screen.getByRole("button", { name: /CLAUDE.md/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy relative path" }));
    await waitFor(() => expect(copyFn).toHaveBeenCalledWith("services/api/CLAUDE.md"));
  });

  it("copies the absolute path from the context menu", async () => {
    state.repo = "/code/app";
    state.files = [file({ path: "/code/app/CLAUDE.md" })];
    render(<ClaudeMdPage />);

    fireEvent.contextMenu(screen.getByRole("button", { name: /CLAUDE.md/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy absolute path" }));
    await waitFor(() => expect(copyFn).toHaveBeenCalledWith("/code/app/CLAUDE.md"));
  });

  /// A menu that can only be closed by choosing something is a trap.
  it("dismisses without copying", () => {
    state.repo = "/code/app";
    state.files = [file()];
    render(<ClaudeMdPage />);
    fireEvent.contextMenu(screen.getByRole("button", { name: /CLAUDE.md/ }));
    fireEvent.click(screen.getByRole("button", { name: "Close menu" }));
    expect(screen.queryByRole("menuitem")).toBeNull();
    expect(copyFn).not.toHaveBeenCalled();
  });
});
