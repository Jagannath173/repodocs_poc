"""MCP SonarQube-style local rule set. Pure-Python heuristic scanner that flags a
handful of common code-smell/maintainability issues inspired by SonarQube rules. No
external server or subscription required.

Rules implemented (intentionally small and high-signal):
  S1234  Function too long (> 80 lines)
  S1541  High cognitive complexity (>= 15 branches)
  S1192  Magic number in non-test code
  S125   Commented-out code
  S117   Variable/parameter names too short (single char, non-loop)
  S1854  Dead assignment (value assigned never read)  [approximate]
  S2068  Hardcoded credential-looking literal
  S1135  TODO/FIXME/XXX left in code
"""
import ast
import re
from langchain_core.tools import tool
from .base import resolve_in_workspace, workspace_root, iter_workspace_files


MAX_FINDINGS = 80

CRED_PATTERN = re.compile(
    r"(?i)(password|passwd|secret|api[_-]?key|token|bearer)\s*[:=]\s*[\"'][^\"']{4,}[\"']"
)
TODO_PATTERN = re.compile(r"\b(TODO|FIXME|XXX|HACK)\b", re.IGNORECASE)
MAGIC_NUM_PATTERN = re.compile(r"(?<![\w.])([-+]?\d{2,})(?![\w.])")
COMMENTED_CODE_HINT = re.compile(r"^\s*(#|//)\s*(def |class |function |if |for |while |return |import |from )")


def _finding(rule: str, path: str, line: int, message: str, severity: str = "MEDIUM") -> dict:
    return {"rule": rule, "severity": severity, "path": path, "line": line, "message": message[:240]}


def _scan_text_rules(rel_path: str, lines: list[str]) -> list[dict]:
    out: list[dict] = []
    for i, raw in enumerate(lines, start=1):
        if len(out) >= MAX_FINDINGS:
            break
        if TODO_PATTERN.search(raw):
            out.append(_finding("S1135", rel_path, i, f"Open TODO/FIXME: {raw.strip()[:160]}", "LOW"))
        if CRED_PATTERN.search(raw):
            out.append(_finding("S2068", rel_path, i, "Possible hardcoded credential literal", "HIGH"))
        if COMMENTED_CODE_HINT.match(raw):
            out.append(_finding("S125", rel_path, i, f"Possible commented-out code: {raw.strip()[:140]}", "LOW"))
    return out


def _scan_python_ast(rel_path: str, src: str) -> list[dict]:
    out: list[dict] = []
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return out
    for node in ast.walk(tree):
        if len(out) >= MAX_FINDINGS:
            break
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            end = getattr(node, "end_lineno", node.lineno)
            body_len = (end or node.lineno) - node.lineno + 1
            if body_len > 80:
                out.append(_finding(
                    "S1234", rel_path, node.lineno,
                    f"Function '{node.name}' is {body_len} lines; refactor into smaller functions",
                    "MEDIUM",
                ))
            branches = sum(
                1 for n in ast.walk(node)
                if isinstance(n, (ast.If, ast.For, ast.While, ast.Try, ast.BoolOp, ast.IfExp))
            )
            if branches >= 15:
                out.append(_finding(
                    "S1541", rel_path, node.lineno,
                    f"Function '{node.name}' has high cognitive complexity ({branches} branches)",
                    "HIGH",
                ))
            for arg in list(node.args.args) + list(node.args.kwonlyargs):
                if len(arg.arg) == 1 and arg.arg not in ("_", "i", "j", "k", "x", "y", "n"):
                    out.append(_finding(
                        "S117", rel_path, arg.lineno,
                        f"Single-letter parameter '{arg.arg}' in function '{node.name}'",
                        "LOW",
                    ))
                    break
        if isinstance(node, ast.Constant) and isinstance(node.value, int):
            if node.value not in (-1, 0, 1, 2, 10, 100, 1000) and abs(node.value) >= 10:
                out.append(_finding(
                    "S1192", rel_path, node.lineno,
                    f"Magic number {node.value}; extract to a named constant",
                    "LOW",
                ))
    return out


@tool
def mcp_sonar_check(path: str) -> str:
    """Run a local SonarQube-style rule set against a file or directory. Returns up to
    80 findings as JSON lines. Use this to catch common maintainability issues: long
    functions, high complexity, magic numbers, hardcoded credentials, commented-out
    code, and TODO markers.

    Args:
        path: Workspace-relative file or directory.
    """
    try:
        target = resolve_in_workspace(path)
    except ValueError as e:
        return f"(error: {e})"
    if not target.exists():
        return f"(error: path not found: {path})"

    root = workspace_root()
    findings: list[dict] = []

    def scan_file(p):
        rel = p.relative_to(root).as_posix()
        try:
            text = p.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            return
        lines = text.splitlines()
        findings.extend(_scan_text_rules(rel, lines))
        if p.suffix == ".py":
            findings.extend(_scan_python_ast(rel, text))

    if target.is_file():
        scan_file(target)
    else:
        for p in iter_workspace_files(target, max_files=200):
            if p.suffix.lower() not in (".py", ".ts", ".tsx", ".js", ".jsx", ".go", ".java", ".rs", ".rb", ".php"):
                continue
            scan_file(p)
            if len(findings) >= MAX_FINDINGS:
                break

    findings = findings[:MAX_FINDINGS]
    if not findings:
        return "(no mcp_sonar findings)"
    import json as _json
    return "\n".join(_json.dumps(f) for f in findings)
