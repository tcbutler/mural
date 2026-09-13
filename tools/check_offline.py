#!/usr/bin/env python3
"""No internet required: the web UI must work with only the plotter reachable.

A plotter on a wall is reachable on the LAN long before it is reachable through
a working internet connection. When the UI loaded jQuery, paper.js and less from
CDNs, a network without internet - or just slow DNS - rendered the page as a
single "Mural" link and nothing else, with every screen hidden because no
JavaScript had run. The render worker was worse still: it called importScripts()
against cdnjs at runtime, so the failure could arrive long after a page that had
loaded fine.

Reasoning about this by reading is what let it survive; the point of this script
is that it is checked instead. It runs from build.py, so a filesystem image that
needs the internet cannot be built, let alone flashed.

Run standalone:  python3 tools/check_offline.py
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Everything that ends up on the device, plus the vendored copies that are meant
# to have replaced the remote ones.
SCAN_DIRS = [ROOT / "data" / "www", ROOT / "vendor"]
SCAN_SUFFIXES = {".html", ".js", ".mjs", ".css", ".less", ".json", ".svg"}

# Absolute URLs and protocol-relative ones (//host/path), which are just as
# remote but easy to miss by eye.
EXTERNAL = re.compile(r"""(?:https?:)?//(?!/)[A-Za-z0-9._~:\[\]-]+\.[A-Za-z]{2,}""")

# Hosts that never cause a fetch. Namespace URIs are identifiers, not requests -
# an <svg xmlns="http://www.w3.org/2000/svg"> is resolved by the parser, never
# retrieved - and links a person may click are the user's business, not the
# page's.
ALLOWED_HOSTS = {
    "www.w3.org",          # XML/SVG namespaces
    "creativecommons.org", # licence identifiers
    "purl.org", "sodipodi.sourceforge.net", "inkscape.org",  # SVG metadata vocabularies
}


def looks_like_a_link_for_a_person(line: str) -> bool:
    """An <a href> the user may click needs the internet only if they click it."""
    return "<a " in line and "href" in line


# A URL in a comment cannot cause a fetch. This matters for the vendored
# libraries, whose licence banners cite their project pages - the throttle
# plugin's banner alone accounts for two.
COMMENT_LINE = re.compile(r"^\s*(?:\*|//|/\*|<!--)")


def is_comment(line: str) -> bool:
    return bool(COMMENT_LINE.match(line))


def offending_lines(path: Path):
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as err:
        return [(0, f"could not read: {err}")]

    problems = []
    for number, line in enumerate(text.splitlines(), start=1):
        for match in EXTERNAL.finditer(line):
            host = match.group(0).split("//", 1)[1].split("/")[0].split(":")[0]
            if host in ALLOWED_HOSTS:
                continue
            if looks_like_a_link_for_a_person(line) or is_comment(line):
                continue
            problems.append((number, match.group(0)))
    return problems


def main() -> int:
    findings = []
    scanned = 0
    for directory in SCAN_DIRS:
        if not directory.exists():
            continue
        for path in sorted(directory.rglob("*")):
            if not path.is_file() or path.suffix.lower() not in SCAN_SUFFIXES:
                continue
            # Vendored libraries are third-party minified blobs; they are scanned
            # for fetches they would perform, which the regex catches either way.
            scanned += 1
            for number, url in offending_lines(path):
                findings.append((path.relative_to(ROOT), number, url))

    if findings:
        print("FAILED: the web UI would need the internet.\n")
        for path, number, url in findings:
            print(f"  {path}:{number}  {url}")
        print(
            "\nEverything the UI loads has to be served by the plotter itself.\n"
            "Vendor the file into vendor/ (see vendor/README.md) and reference it\n"
            "by a relative path, or add the host to ALLOWED_HOSTS here if it can\n"
            "never cause a fetch (a namespace URI, say)."
        )
        return 1

    print(f"Offline check passed ({scanned} files scanned, no external references).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
