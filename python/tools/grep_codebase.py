import re
import subprocess
import shutil
from pathlib import Path
from langchain_core.tools import tool
from .base import workspace_root, iter_workspace_files, EXCLUDED_DIR_NAMES

MAX_MATCHES = 200
MAX_LINE_LEN = 400


@tool
def grep_codebase(pattern: str, file_glob: str = "") -> str:
    """Search the workspace for a regular-expression pattern. Returns up to 200 matches as
    'path:line:content' lines. Skips node_modules/out/.git/venv and other build dirs.
    Use this to find callers, similar code, or whether a symbol exists elsewhere.

    Args:
        pattern: Regular expression (Python re syntax, case-sensitive).
        file_glob: Optional filename glob (e.g. '*.ts', '*.py') to restrict the search.
    """
    root = workspace_root()
    rg = shutil.which("rg")
    if rg:
        cmd = [rg, "--no-heading", "--line-number", "--max-count", "20", pattern]
        for d in EXCLUDED_DIR_NAMES:
            cmd += ["--glob", f"!{d}/**"]
        if file_glob:
            cmd += ["--glob", file_glob]
        cmd.append(str(root))
        try:
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=30, cwd=str(root))
            lines = (out.stdout or "").splitlines()
            lines = [ln[:MAX_LINE_LEN] for ln in lines[:MAX_MATCHES]]
            return "\n".join(lines) if lines else "(no matches)"
        except subprocess.TimeoutExpired:
            return "(grep timed out)"

    try:
        regex = re.compile(pattern)
    except re.error as e:
        return f"(invalid regex: {e})"
    matches = []
    for p in iter_workspace_files(root):
        if file_glob and not p.match(file_glob):
            continue
        try:
            with p.open("r", encoding="utf-8", errors="ignore") as fh:
                for i, line in enumerate(fh, start=1):
                    if regex.search(line):
                        rel = p.relative_to(root).as_posix()
                        matches.append(f"{rel}:{i}:{line.rstrip()[:MAX_LINE_LEN]}")
                        if len(matches) >= MAX_MATCHES:
                            return "\n".join(matches)
        except (OSError, UnicodeDecodeError):
            continue
    return "\n".join(matches) if matches else "(no matches)"
