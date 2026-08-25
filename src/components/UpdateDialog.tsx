import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { ExternalLink } from "./ExternalLink";

/// Announces a new release once per version.
///
/// The status bar has always carried an update hint, and it is easy to
/// miss -- a small line at the bottom edge of a window that is often
/// not the one you are looking at. A user running a build with a fixed
/// crash in it should not have to notice a footnote.
///
/// Dismissal is per VERSION, not per launch: nagging about a release
/// someone has already declined is how a notice trains people to
/// dismiss it unread. A user who wants none of it can turn the whole
/// thing off in Settings.
export function UpdateDialog({
  version,
  open,
  onDismiss,
}: {
  version: string;
  open: boolean;
  onDismiss: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onDismiss()}>
      <DialogContent className="max-w-md">
        <DialogTitle>Headstate {version} is available</DialogTitle>
        <p className="text-sm text-[#8b949e]">
          You are running an older build. Releases carry fixes for problems you
          may be seeing.
        </p>
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onDismiss}
            className="rounded border border-[#30363d] px-3 py-1.5 text-sm hover:bg-[#161b22]"
          >
            Not now
          </button>
          <ExternalLink
            href="https://github.com/pktstorm/headstate/releases/latest"
            onClick={onDismiss}
            className="rounded bg-[#238636] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#2ea043]"
          >
            See the release
          </ExternalLink>
        </div>
      </DialogContent>
    </Dialog>
  );
}
