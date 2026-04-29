import json
import os
import shutil
import subprocess
from langchain_core.tools import tool
from .base import resolve_in_workspace, workspace_root


def _semgrep_available() -> bool:
    if os.environ.get("CODE_REVIEW_AGENT_SEMGREP_ENABLED", "1") != "1":
        return False
    return shutil.which("semgrep") is not None


@tool
def semgrep_scan(path: str, config: str = "auto") -> str:
    """Run Semgrep on a file or directory using pattern-based rules. Returns up to 50 findings
    as JSON lines. Use for security- and quality-relevant pattern detection.

    Args:
        path: Workspace-relative file or directory to scan.
        config: Semgrep config (default 'auto' uses the community rulesets; 'p/security-audit',
                'p/python', 'p/javascript' are useful alternatives).
    """
    if not _semgrep_available():
        return "(semgrep not installed or disabled; skip this tool)"
    try:
        target = resolve_in_workspace(path)
    except ValueError as e:
        return f"(error: {e})"
    if not target.exists():
        return f"(error: path not found: {path})"
    try:
        out = subprocess.run(
            ["semgrep", "--config", config, "--json", "--quiet", "--timeout", "60", str(target)],
            capture_output=True, text=True, timeout=120, cwd=str(workspace_root()),
        )
    except FileNotFoundError:
        return "(semgrep not found)"
    except subprocess.TimeoutExpired:
        return "(semgrep timed out)"
    if out.returncode not in (0, 1):
        return f"(semgrep error rc={out.returncode}: {out.stderr[:300]})"
    try:
        data = json.loads(out.stdout or "{}")
    except json.JSONDecodeError:
        return "(semgrep returned non-json)"
    results = data.get("results", [])[:50]
    if not results:
        return "(no semgrep findings)"
    lines = []
    for r in results:
        lines.append(json.dumps({
            "rule": r.get("check_id"),
            "severity": (r.get("extra") or {}).get("severity"),
            "message": (r.get("extra") or {}).get("message", "")[:400],
            "path": r.get("path"),
            "line": (r.get("start") or {}).get("line"),
        }))
    return "\n".join(lines)
