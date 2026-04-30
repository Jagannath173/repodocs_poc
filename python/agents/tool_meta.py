"""Per-tool display metadata. The agent emits these strings verbatim to the UI so the TS
side is data-driven — no hardcoded tool names on the client."""

from typing import Any, Callable


def _quote_arg(v: Any, limit: int = 60) -> str:
    s = str(v) if v is not None else ""
    s = s.strip()
    if not s:
        return ""
    if len(s) > limit:
        s = s[: limit - 1] + "…"
    return s


def _grep_msg(args: dict) -> str:
    pat = _quote_arg(args.get("pattern"))
    scope = _quote_arg(args.get("file_glob"), 30)
    if scope:
        return f"Querying codebase for pattern '{pat}' within {scope}"
    return f"Querying codebase for pattern '{pat}'"


def _read_file_msg(args: dict) -> str:
    path = _quote_arg(args.get("path"))
    start = args.get("start_line") or 1
    end = args.get("end_line") or 0
    if end and end > 0:
        return f"Inspecting {path} (lines {start}–{end})"
    return f"Inspecting {path}"


def _blame_msg(args: dict) -> str:
    path = _quote_arg(args.get("path"))
    return f"Retrieving authorship history for {path} (lines {args.get('start_line')}–{args.get('end_line')})"


def _recent_commits_msg(args: dict) -> str:
    path = _quote_arg(args.get("path"))
    return f"Analyzing recent commit activity on {path}"


def _imports_msg(args: dict) -> str:
    sym = _quote_arg(args.get("symbol"), 40)
    return f"Resolving imports and call sites for symbol '{sym}'"


def _similar_msg(args: dict) -> str:
    path = _quote_arg(args.get("path"))
    return f"Identifying structurally similar implementations relative to {path}:{args.get('line')}"


def _semgrep_msg(args: dict) -> str:
    path = _quote_arg(args.get("path"))
    cfg = _quote_arg(args.get("config"), 30) or "auto"
    return f"Executing Semgrep static analysis on {path} (ruleset: {cfg})"


def _mcp_lint_msg(args: dict) -> str:
    path = _quote_arg(args.get("path"))
    return f"Executing project linter against {path}"


def _mcp_sonar_msg(args: dict) -> str:
    path = _quote_arg(args.get("path"))
    return f"Applying SonarQube-equivalent quality rules to {path}"


TOOL_META: dict[str, dict[str, Any]] = {
    # Lifecycle labels (not real tools — used for agent startup / planning / synthesis).
    "agent":                   {"icon": "[AGENT]",   "display": "Agent",                "describe": lambda args: _quote_arg(args.get("message"), 200) or "Agent is working"},
    "synthesis":               {"icon": "[SYNTH]",   "display": "Synthesis",            "describe": lambda args: _quote_arg(args.get("message"), 200) or "Compiling findings"},
    # Codebase inspection tools.
    "grep_codebase":           {"icon": "[SEARCH]",  "display": "Codebase Search",      "describe": _grep_msg},
    "read_file":               {"icon": "[READ]",    "display": "File Reader",          "describe": _read_file_msg},
    "get_git_blame":           {"icon": "[BLAME]",   "display": "Git Blame",            "describe": _blame_msg},
    "get_recent_commits":      {"icon": "[HISTORY]", "display": "Git History",          "describe": _recent_commits_msg},
    "list_imports_and_usages": {"icon": "[XREF]",    "display": "Cross-reference",      "describe": _imports_msg},
    "find_similar_patterns":   {"icon": "[MATCH]",   "display": "Pattern Analysis",     "describe": _similar_msg},
    # MCP-bridged analyzers.
    "semgrep_scan":            {"icon": "[MCP:SEMGREP]", "display": "Semgrep (MCP)",    "describe": _semgrep_msg},
    "mcp_lint_check":          {"icon": "[MCP:LINT]",    "display": "Linter (MCP)",     "describe": _mcp_lint_msg},
    "mcp_sonar_check":         {"icon": "[MCP:SONAR]",   "display": "SonarQube (MCP)",  "describe": _mcp_sonar_msg},
}


def describe_call(tool_name: str, args: dict) -> tuple[str, str]:
    """Return (icon, message) for a tool call. Falls back gracefully for unknown tools."""
    meta = TOOL_META.get(tool_name)
    if not meta:
        return ("⚡", f"Running {tool_name}")
    try:
        describer: Callable[[dict], str] = meta["describe"]
        message = describer(args or {})
    except Exception:
        message = meta.get("display") or tool_name
    return (meta.get("icon", "⚡"), message)


def summarize_result(tool_name: str, raw_result: str) -> str:
    """Compress a tool result into a single line for the activity feed.

    Heuristic: count lines, show the first non-empty trimmed line, pick a natural summary.
    """
    if not raw_result:
        return "done"
    text = raw_result.strip()
    if not text:
        return "done"
    # Parenthesised status results like "(no matches)" — return as-is.
    if text.startswith("(") and "\n" not in text and len(text) <= 120:
        return text.strip("() ")
    lines = [ln for ln in text.splitlines() if ln.strip()]
    if not lines:
        return "done"
    line_word = "match" if tool_name == "grep_codebase" else "line"
    summary_first = lines[0].strip()
    if len(summary_first) > 100:
        summary_first = summary_first[:100] + "…"
    if len(lines) == 1:
        return summary_first
    return f"{len(lines)} {line_word}{'es' if line_word == 'match' else 's'}; first: {summary_first}"
