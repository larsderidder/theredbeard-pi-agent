#!/usr/bin/env python3
"""
Loop task script template for /loop-subagent.

Interface (called by the loop extension):
  script.py info              → key=value metadata (optional)
  script.py queue             → next item on stdout + exit 0; exit 1 if nothing left
  script.py prompt <item>     → full LLM worker prompt on stdout + exit 0

Usage:
  /loop-subagent /path/to/script.py

The extension calls `queue` before each iteration. If it exits 1, the loop stops
without spawning a worker. If it exits 0, the item (stdout) is passed to `prompt`,
which returns the full prompt for `pi -p --no-session`.
"""

import sys


def info() -> None:
    """
    Print key=value metadata for the loop extension.
    Supported keys:
      cwd=          Working directory for queue/prompt calls and worker processes.
                    Defaults to the script's directory if not set.
      description=  Short description for the loop status widget.
    """
    # cwd=/absolute/path/to/workdir
    # description=Extract structured data from widget catalog
    pass


def queue() -> None:
    """
    Print the next item to process and exit 0.
    Exit 1 if there is nothing left to do (loop stops).

    The item can be anything the prompt command needs: a file path, an ID,
    a BRIN code, a URL, etc. It can also be multi-line — the full stdout
    is passed verbatim to `prompt` as the <item> argument.

    Convention: print the most useful human-readable identifier on the first
    line (shown in the loop UI), followed by any extra context on subsequent lines.

    Examples:
      print("05CT00")                               # simple ID
      print("/data/raw/pack-hacker-arcteryx.md")    # file path
      print(f"{brin}\\nremaining: {len(pending)}")  # ID + context
    """
    # pending = get_pending()
    # if not pending:
    #     sys.exit(1)
    # item = pending[0]
    # print(item)
    sys.exit(1)  # nothing to do by default


def prompt(item: str) -> None:
    """
    Print the full LLM worker prompt for the given item and exit 0.

    The item is exactly what `queue` printed (full stdout, stripped).
    Build a self-contained prompt: the worker has no shared context,
    so include everything it needs (file paths, schema, rules, constraints).

    The worker should:
      - Do ONE unit of work for this item
      - Stop after completing it
      - Not loop or look for more items
    """
    print(f"""Process the following item: {item}

<replace with your task-specific instructions>

Do exactly the steps above for this one item, then stop.
""")


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""

    if cmd == "info":
        info()
    elif cmd == "queue":
        queue()
    elif cmd == "prompt":
        item = sys.argv[2] if len(sys.argv) > 2 else ""
        prompt(item)
    else:
        print(f"Usage: {sys.argv[0]} info | queue | prompt <item>", file=sys.stderr)
        sys.exit(2)
