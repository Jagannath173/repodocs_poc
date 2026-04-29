import subprocess
from langchain_core.tools import tool
from .base import resolve_in_workspace, workspace_root


@tool
def get_git_blame(path: str, start_line: int, end_line: int) -> str:
    """Show git blame for a range of lines in a file (who/what/when each line was last changed).
    Use this to understand the intent and history behind code you're reviewing.

    Args:
        path: Workspace-relative file path.
        start_line: 1-based start line.
        end_line: 1-based end line (inclusive).
    """
    try:
        p = resolve_in_workspace(path)
    except ValueError as e:
        return f"(error: {e})"
    if not p.exists():
        return f"(error: file not found: {path})"
    start = max(1, int(start_line))
    end = max(start, int(end_line))
    try:
        out = subprocess.run(
            ["git", "blame", "-L", f"{start},{end}", "--date=short", str(p)],
            capture_output=True, text=True, timeout=20, cwd=str(workspace_root()),
        )
    except FileNotFoundError:
        return "(git not available)"
    except subprocess.TimeoutExpired:
        return "(git blame timed out)"
    if out.returncode != 0:
        return f"(git blame failed: {out.stderr.strip()[:300]})"
    lines = (out.stdout or "").splitlines()
    return "\n".join(lines[:500]) if lines else "(no blame output)"
