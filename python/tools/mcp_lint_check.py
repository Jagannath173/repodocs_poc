"""MCP-style lint tool. Auto-detects the right linter for the file/workspace (ruff,
pylint, eslint, tsc) and runs it in a contained subprocess. Emits a terse, model-friendly
summary of issues."""
import json
import os
import shutil
import subprocess
from langchain_core.tools import tool
from .base import resolve_in_workspace, workspace_root


MAX_OUTPUT_ISSUES = 60


def _run(cmd: list[str], cwd: str, timeout: int = 60) -> tuple[int, str, str]:
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, cwd=cwd)
        return out.returncode, out.stdout or "", out.stderr or ""
    except FileNotFoundError:
        return 127, "", f"{cmd[0]} not found on PATH"
    except subprocess.TimeoutExpired:
        return 124, "", f"{cmd[0]} timed out after {timeout}s"


def _lint_python(path: str, cwd: str) -> str:
    if shutil.which("ruff"):
        code, stdout, stderr = _run(["ruff", "check", "--output-format", "json", path], cwd)
        if code in (0, 1):
            try:
                issues = json.loads(stdout or "[]")[:MAX_OUTPUT_ISSUES]
            except json.JSONDecodeError:
                return f"(ruff unparsable output: {stdout[:200]})"
            if not issues:
                return "(no ruff issues)"
            lines = []
            for it in issues:
                loc = it.get("location") or {}
                lines.append(json.dumps({
                    "tool": "ruff", "rule": it.get("code"),
                    "message": (it.get("message") or "")[:200],
                    "path": it.get("filename"), "line": loc.get("row"),
                }))
            return "\n".join(lines)
        return f"(ruff failed rc={code}: {stderr[:200]})"
    if shutil.which("pylint"):
        code, stdout, stderr = _run(["pylint", "--output-format=json", path], cwd)
        try:
            issues = json.loads(stdout or "[]")[:MAX_OUTPUT_ISSUES]
        except json.JSONDecodeError:
            return f"(pylint unparsable output: {stdout[:200]})"
        if not issues:
            return "(no pylint issues)"
        return "\n".join(
            json.dumps({
                "tool": "pylint", "rule": it.get("symbol") or it.get("message-id"),
                "message": (it.get("message") or "")[:200],
                "path": it.get("path"), "line": it.get("line"),
            }) for it in issues
        )
    return "(no Python linter available: install ruff or pylint)"


def _lint_js_ts(path: str, cwd: str) -> str:
    if shutil.which("eslint"):
        code, stdout, stderr = _run(["eslint", "--format", "json", path], cwd)
        if code in (0, 1):
            try:
                results = json.loads(stdout or "[]")
            except json.JSONDecodeError:
                return f"(eslint unparsable output: {stdout[:200]})"
            issues: list[str] = []
            for f in results:
                for m in f.get("messages", []):
                    issues.append(json.dumps({
                        "tool": "eslint", "rule": m.get("ruleId"),
                        "severity": {1: "warning", 2: "error"}.get(m.get("severity"), "info"),
                        "message": (m.get("message") or "")[:200],
                        "path": f.get("filePath"), "line": m.get("line"),
                    }))
                    if len(issues) >= MAX_OUTPUT_ISSUES:
                        break
                if len(issues) >= MAX_OUTPUT_ISSUES:
                    break
            return "\n".join(issues) if issues else "(no eslint issues)"
        return f"(eslint failed rc={code}: {stderr[:200]})"
    return "(eslint not available on PATH; cannot lint JS/TS)"


@tool
def mcp_lint_check(path: str) -> str:
    """Run the appropriate linter on a file or directory and return issues as JSON lines.
    Auto-detects ruff/pylint for Python; eslint for JS/TS. Use this to surface real
    style/quality/bug warnings before reporting findings.

    Args:
        path: Workspace-relative file or directory path.
    """
    try:
        target = resolve_in_workspace(path)
    except ValueError as e:
        return f"(error: {e})"
    if not target.exists():
        return f"(error: path not found: {path})"
    suffix = target.suffix.lower() if target.is_file() else ""
    cwd = str(workspace_root())
    if suffix == ".py" or (target.is_dir() and any(p.suffix == ".py" for p in target.rglob("*.py"))):
        return _lint_python(str(target), cwd)
    if suffix in (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"):
        return _lint_js_ts(str(target), cwd)
    if target.is_dir():
        return _lint_js_ts(str(target), cwd)
    return f"(no linter configured for extension '{suffix}')"
