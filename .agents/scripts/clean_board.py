#!/usr/bin/env python3
"""Bound BOARD.md by archiving old entries. Stdlib only, lossless.

Rules (see .agents/BOARD.md "Cleanup"):
- Keep the newest --keep unpinned entries (default 30) and at most
  --max-kb KiB (default 32) of board content.
- Entries whose header line contains [PINNED] or [KEEP] are always
  kept and count toward neither limit.
- Overflow entries move verbatim to board-archive/BOARD-YYYY-MM.md,
  grouped by the month in the entry header. Nothing is ever deleted.
- Default is a dry-run: prints the plan, writes nothing.
  --apply writes. --check exits 2 if the board is over a limit
  (writes nothing; for hooks/CI).

Usage:
    python3 .agents/scripts/clean_board.py [--apply|--check]
        [--keep N] [--max-kb N] [--board PATH] [--archive-dir PATH]
"""
import re
import sys
from pathlib import Path

MARKER = "<!-- Post new entries below this line, newest first. -->"
ENTRY_RE = re.compile(r"^## (\d{4})-(\d{2})-\d{2}\b.*$", re.M)
PINNED_TAGS = ("[PINNED]", "[KEEP]")


class BoardError(Exception):
    pass


def split_board(text):
    """Return (head, preamble, entries).

    head: everything through the marker line.
    preamble: non-entry text between the marker and the first entry.
    entries: list of (month 'YYYY-MM', pinned bool, verbatim text).
    """
    if MARKER not in text:
        raise BoardError(f"entries marker not found: {MARKER!r}")
    head, rest = text.split(MARKER, 1)
    head = head + MARKER + "\n"
    matches = list(ENTRY_RE.finditer(rest))
    if not matches:
        return head, rest.strip("\n"), []
    preamble = rest[: matches[0].start()].strip("\n")
    entries = []
    for i, m in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(rest)
        chunk = rest[m.start() : end].strip("\n")
        header_line = chunk.splitlines()[0] if chunk else ""
        pinned = any(tag in header_line for tag in PINNED_TAGS)
        entries.append((f"{m.group(1)}-{m.group(2)}", pinned, chunk))
    return head, preamble, entries


def join_board(head, preamble, entries):
    parts = [head]
    if preamble:
        parts.append(preamble)
    parts.extend(e[2] for e in entries)
    return "\n\n".join(p.strip("\n") for p in parts if p.strip()) + "\n"


def plan_cleanup(entries, keep, max_bytes, head, preamble):
    """Split entries into (kept, overflow), both in board order."""
    kept, overflow = [], []
    unpinned_kept = 0
    for e in entries:
        if e[1]:  # pinned
            kept.append(e)
        elif unpinned_kept < keep:
            kept.append(e)
            unpinned_kept += 1
        else:
            overflow.append(e)
    # Size limit: shed oldest unpinned kept entries until under.
    def size():
        return len(join_board(head, preamble, kept).encode("utf-8"))

    while size() > max_bytes:
        idx = next((i for i in range(len(kept) - 1, -1, -1) if not kept[i][1]), None)
        if idx is None:
            break  # only pinned left; they stay no matter the size
        overflow.append(kept.pop(idx))
    overflow.sort(key=lambda e: entries.index(e))
    return kept, overflow


def archive_entries(archive_dir, overflow, apply):
    """Group overflow by month and merge into monthly archive files."""
    by_month = {}
    for month, _pinned, chunk in overflow:
        by_month.setdefault(month, []).append(chunk)
    written = []
    for month, chunks in by_month.items():
        path = archive_dir / f"BOARD-{month}.md"
        existing = []
        preamble = (f"# BOARD archive — {month}\n\n"
                    "Archived from BOARD.md by clean_board.py. Newest first. "
                    "Entries are verbatim; do not edit.")
        if path.exists():
            text = path.read_text(encoding="utf-8")
            ms = list(ENTRY_RE.finditer(text))
            if ms:
                preamble = text[: ms[0].start()].strip("\n")
                for i, m in enumerate(ms):
                    end = ms[i + 1].start() if i + 1 < len(ms) else len(text)
                    existing.append(text[m.start() : end].strip("\n"))
        merged = chunks + existing  # archived batch is newer than what is filed
        content = preamble + "\n\n" + "\n\n".join(merged) + "\n"
        written.append((path, content))
    if apply:
        archive_dir.mkdir(parents=True, exist_ok=True)
        for path, content in written:
            tmp = path.with_suffix(".tmp")
            tmp.write_text(content, encoding="utf-8")
            tmp.replace(path)
    return [str(p) for p, _c in written]


def main(argv):
    args = argv[1:]
    apply = "--apply" in args
    check = "--check" in args
    if apply and check:
        print("error: --apply and --check are mutually exclusive", file=sys.stderr)
        return 1

    def opt(name, default):
        return args[args.index(name) + 1] if name in args else default

    script_root = Path(__file__).resolve().parents[2]
    board = Path(opt("--board", str(script_root / ".agents" / "BOARD.md")))
    archive_dir = Path(opt("--archive-dir", str(board.parent / "board-archive")))
    keep = int(opt("--keep", "30"))
    max_bytes = int(opt("--max-kb", "32")) * 1024

    try:
        text = board.read_text(encoding="utf-8")
    except OSError as e:
        print(f"error: cannot read board: {e}", file=sys.stderr)
        return 1
    try:
        head, preamble, entries = split_board(text)
        kept, overflow = plan_cleanup(entries, keep, max_bytes, head, preamble)
    except BoardError as e:
        print(f"error: {e}; nothing written", file=sys.stderr)
        return 1

    before = len(text.encode("utf-8"))
    after = len(join_board(head, preamble, kept).encode("utf-8"))
    mode = "apply" if apply else "check" if check else "dry-run"
    print(f"[{mode}] entries: {len(entries)} total, {len(kept)} kept, "
          f"{len(overflow)} to archive; board {before} -> {after} bytes "
          f"(limits: keep {keep}, max {max_bytes} bytes)")
    if not overflow:
        print("board within limits; nothing to do")
        return 0
    files = archive_entries(archive_dir, overflow, apply)
    for f in files:
        print(f"{'archived to' if apply else 'would archive to'}: {f}")
    if check:
        return 2
    if apply:
        tmp = board.with_suffix(".tmp")
        tmp.write_text(join_board(head, preamble, kept), encoding="utf-8")
        tmp.replace(board)
        print("board rewritten; post a board entry recording this cleanup")
    else:
        print("dry-run only; re-run with --apply to write")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
