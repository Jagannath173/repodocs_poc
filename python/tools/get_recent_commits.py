import subprocess
from langchain_core.tools import tool
from .base import resolve_in_workspace, workspace_root


@tool
def get_recent_commits(path: str, limit: int = 10) -> str:
    """List recent commits that touched a file, newest first. Shows hash, date, author, subject.
    Use this to understand churn, recent intent, and whether a file was recently refactored.

    Args:
        path: Workspace-relative file path.
        limit: How many commits to show (default 10, max 50).
    """
    try:
        p = resolve_in_workspace(path)
    except ValueError as e:
        return f"(error: {e})"
    limit = max(1, min(int(limit), 50))
    try:
        out = subprocess.run(
            ["git", "log", f"-{limit}", "--date=short", "--pretty=format:%h  %ad  %an  %s", "--", str(p)],
            capture_output=True, text=True, timeout=20, cwd=str(workspace_root()),
        )
    except FileNotFoundError:
        return "(git not available)"
    except subprocess.TimeoutExpired:
        return "(git log timed out)"
    if out.returncode != 0:
        return f"(git log failed: {out.stderr.strip()[:300]})"
    return out.stdout.strip() or "(no commits found)"
