import re
import shutil
import subprocess
from langchain_core.tools import tool
from .base import workspace_root, iter_workspace_files, EXCLUDED_DIR_NAMES

MAX_HITS = 150


@tool
def list_imports_and_usages(symbol: str) -> str:
    """For a given symbol (function, class, variable name), find where it is imported and called
    across the workspace. Handles Python, TS/JS, and Go import/usage conventions heuristically.
    Returns up to 150 matches as 'path:line:content'.

    Args:
        symbol: Bare identifier to look up (e.g. 'runCodeReview', 'generate_response').
    """
    if not symbol or not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", symbol):
        return "(error: symbol must be a bare identifier)"
    patterns = [
        rf"\bimport\s+.*\b{re.escape(symbol)}\b",
        rf"\bfrom\s+.*\bimport\s+.*\b{re.escape(symbol)}\b",
        rf"\brequire\(.*\)\s*\.\s*{re.escape(symbol)}\b",
        rf"\b{re.escape(symbol)}\s*\(",
        rf"\bnew\s+{re.escape(symbol)}\b",
    ]
    joined = "|".join(f"(?:{p})" for p in patterns)
    root = workspace_root()
    rg = shutil.which("rg")
    if rg:
        cmd = [rg, "--no-heading", "--line-number", "-e", joined]
        for d in EXCLUDED_DIR_NAMES:
            cmd += ["--glob", f"!{d}/**"]
        cmd.append(str(root))
        try:
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=30, cwd=str(root))
            lines = (out.stdout or "").splitlines()[:MAX_HITS]
            return "\n".join(lines) if lines else "(no usages found)"
        except subprocess.TimeoutExpired:
            return "(search timed out)"
    try:
        regex = re.compile(joined)
    except re.error as e:
        return f"(regex error: {e})"
    hits = []
    for p in iter_workspace_files(root):
        if p.suffix.lower() not in (".py", ".ts", ".tsx", ".js", ".jsx", ".go", ".java", ".rs"):
            continue
        try:
            with p.open("r", encoding="utf-8", errors="ignore") as fh:
                for i, line in enumerate(fh, start=1):
                    if regex.search(line):
                        rel = p.relative_to(root).as_posix()
                        hits.append(f"{rel}:{i}:{line.rstrip()[:400]}")
                        if len(hits) >= MAX_HITS:
                            return "\n".join(hits)
        except (OSError, UnicodeDecodeError):
            continue
    return "\n".join(hits) if hits else "(no usages found)"
