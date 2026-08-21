#!/usr/bin/env python3
"""Every `run:` step reachable on Windows must declare `shell: bash`.

Windows runners default to PowerShell, where `set -euo pipefail`, heredocs,
and `${VAR#prefix}` are all parse errors. The failure is late and confusing:
the step dies with a ParserError pointing at a generated .ps1 file, and only
on one platform.

Caught for real by the v2.0.1-rc.1 rehearsal, where "Stamp version from tag"
failed on Windows while macOS and Linux passed.

Deliberately parses by indentation rather than importing PyYAML: the lint
runner has no third-party Python packages, and a guard that needs its own
install is a guard that gets dropped. Workflow files are machine-written
and consistently indented, so this is sound for the narrow question asked
-- and the exactness that matters is on `shell:`/`run:` keys, not on YAML
in general.
"""

import pathlib
import re
import sys

NON_WINDOWS = ("macos-latest", "ubuntu-latest")


def steps_of(text: str):
    """Yield (job_has_windows, step_lines) for every `run:` step."""
    lines = text.splitlines()
    job_windows = False
    current: list[str] = []
    in_step = False

    for line in lines:
        # A new job resets the platform question. Jobs are at 2 spaces.
        if re.match(r"^  [A-Za-z0-9_-]+:\s*$", line):
            if in_step and current:
                yield job_windows, current
            current, in_step = [], False
            job_windows = False

        if "windows-latest" in line:
            job_windows = True

        # Steps start with `- ` at 6 spaces inside `steps:`.
        if re.match(r"^      - ", line):
            if in_step and current:
                yield job_windows, current
            current, in_step = [line], True
        elif in_step:
            # A line dedented past the step body ends it.
            if line.strip() and not line.startswith("        "):
                yield job_windows, current
                current, in_step = [], False
            else:
                current.append(line)

    if in_step and current:
        yield job_windows, current


def main() -> int:
    bad = []
    for path in sorted(pathlib.Path(".github/workflows").glob("*.yml")):
        text = path.read_text()
        for job_windows, step in steps_of(text):
            body = "\n".join(step)
            # Only `run:` steps have a shell; `uses:` steps do not.
            if not re.search(r"^\s+run:", body, re.M):
                continue
            if re.search(r"^\s+shell:", body, re.M):
                continue
            if not job_windows:
                continue
            # An `if:` pinning the step to another OS makes it unreachable.
            cond = re.search(r"^\s+if:.*$", body, re.M)
            if cond and any(o in cond.group(0) for o in NON_WINDOWS):
                continue
            name = re.search(r"name:\s*(.+)$", body, re.M)
            bad.append(f"{path}: {name.group(1).strip() if name else '(unnamed)'}")

    if bad:
        print("These `run:` steps can execute on Windows without `shell: bash`:")
        for b in bad:
            print(f"  {b}")
        print("\nWindows defaults to PowerShell, where bash syntax is a parse error.")
        return 1
    print("All Windows-reachable run steps declare a shell.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
