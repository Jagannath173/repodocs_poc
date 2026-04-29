from langchain_core.tools import tool
from .base import resolve_in_workspace

MAX_BYTES = 2 * 1024 * 1024
MAX_LINES = 2000


@tool
def read_file(path: str, start_line: int = 1, end_line: int = 0) -> str:
    """Read a file from the workspace. Returns content with line numbers.
    Use this to inspect related modules, configuration, or to follow imports you discovered with grep.

    Args:
        path: Workspace-relative path (e.g. 'src/commands/review/codeReview.ts').
        start_line: 1-based start line (default 1).
        end_line: 1-based end line inclusive; 0 means read to end (capped at 2000 lines).
    """
    try:
        p = resolve_in_workspace(path)
    except ValueError as e:
        return f"(error: {e})"
    if not p.exists():
        return f"(error: file not found: {path})"
    if not p.is_file():
        return f"(error: not a file: {path})"
    size = p.stat().st_size
    if size > MAX_BYTES:
        return f"(error: file too large: {size} bytes, cap is {MAX_BYTES})"
    try:
        content = p.read_text(encoding="utf-8", errors="ignore")
    except OSError as e:
        return f"(error reading file: {e})"
    lines = content.splitlines()
    start = max(1, start_line)
    end = len(lines) if end_line <= 0 else min(end_line, len(lines))
    if end - start + 1 > MAX_LINES:
        end = start + MAX_LINES - 1
    selected = lines[start - 1:end]
    numbered = [f"{start + i:>5}  {ln}" for i, ln in enumerate(selected)]
    return "\n".join(numbered) if numbered else "(empty selection)"
