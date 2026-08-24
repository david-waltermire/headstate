/// A bug report the user can read before it is posted.
///
/// The banner used to state a problem and offer nothing, and the errors
/// that most need reporting are exactly the ones a user cannot diagnose.
/// Both recent diagnoses in this area needed the platform, the build
/// kind, and how the app was launched -- none of which appear in the
/// error string.

/// What the app knows about itself when something fails.
export interface ReportContext {
  version: string;
  platform: string;
  arch: string;
  error: string;
}

/// The longest error text worth including.
///
/// Deliberately short. A long error is more likely to be carrying
/// something -- a quoted query naming repositories, a stack of paths --
/// and no diagnosis so far has needed more than a sentence of it.
const MAX_ERROR = 500;

/// Patterns for the things that must never leave the machine.
///
/// This is a second line of defence, NOT the design. The report is built
/// from named fields that are known to be safe; this exists because one
/// of those fields -- the error string -- is written by code we do not
/// control and can quote anything.
const SCRUB: [RegExp, string][] = [
  // Every token shape gh can hand out. Checked before paths, since a
  // token can appear inside one.
  [/\b(gh[pousr]|github_pat)_[A-Za-z0-9_]+/g, "[redacted]"],
  // A home directory carries a username; a checkout path can name a
  // private project. Both are leaks the privacy guard exists to stop.
  [/(\/Users\/|\/home\/|C:\\Users\\)[^\s"']*/g, "[path]"],
  // The poll log records counts only, never repository names. A report
  // must not undo that.
  [/\b[A-Za-z0-9][-\w.]*\/[A-Za-z0-9][-\w.]+\b/g, "[repo]"],
];

function scrub(text: string): string {
  return SCRUB.reduce((acc, [pattern, with_]) => acc.replace(pattern, with_), text);
}

/// The report body, scrubbed and bounded.
export function buildReport(ctx: ReportContext): string {
  const error = scrub(ctx.error).slice(0, MAX_ERROR);
  return [
    "## What happened",
    "",
    "Headstate showed this error:",
    "",
    "```",
    error,
    "```",
    "",
    "## Environment",
    "",
    `- Headstate ${ctx.version}`,
    `- ${ctx.platform} ${ctx.arch}`,
    "",
    "## Anything else",
    "",
    "<!-- What you were doing, and whether it happens every time. -->",
    "",
    "<!-- This report was prepared by Headstate. Tokens, file paths and",
    "     repository names are removed automatically -- but please read it",
    "     before posting. -->",
  ].join("\n");
}

/// A prefilled issue form.
///
/// Opens a form rather than submitting: the user is the only one who can
/// confirm nothing sensitive survived scrubbing, and filing publicly on
/// someone's behalf without showing them what it says is not something
/// an app should do. It also avoids needing issue-write scope on a token
/// this app only reads with.
export function issueUrl(body: string): string {
  const base = "https://github.com/pktstorm/headstate/issues/new";
  return `${base}?title=${encodeURIComponent("Error: ")}&body=${encodeURIComponent(body)}`;
}
