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
        return f"Searching codebase for '{pat}' in {scope}"
    return f"Searching codebase for '{pat}'"


def _read_file_msg(args: dict) -> str:
    path = _quote_arg(args.get("path"))
    start = args.get("start_line") or 1
    end = args.get("end_line") or 0
    if end and end > 0:
        return f"Reading file {path} (lines {start}–{end})"
    return f"Reading file {path}"


def _blame_msg(args: dict) -> str:
    path = _quote_arg(args.get("path"))
    return f"Checking git blame for {path} lines {args.get('start_line')}–{args.get('end_line')}"


def _recent_commits_msg(args: dict) -> str:
    path = _quote_arg(args.get("path"))
    return f"Reviewing recent commits touching {path}"


def _imports_msg(args: dict) -> str:
    sym = _quote_arg(args.get("symbol"), 40)
    return f"Tracing imports and usages of {sym}"


def _similar_msg(args: dict) -> str:
    path = _quote_arg(args.get("path"))
    return f"Finding similar patterns near {path}:{args.get('line')}"


def _semgrep_msg(args: dict) -> str:
    path = _quote_arg(args.get("path"))
    cfg = _quote_arg(args.get("config"), 30) or "auto"
    return f"MCP Semgrep scanning {path} with ruleset '{cfg}'"


def _mcp_lint_msg(args: dict) -> str:
    path = _quote_arg(args.get("path"))
    return f"MCP Linter is checking {path}"


def _mcp_sonar_msg(args: dict) -> str:
    path = _quote_arg(args.get("path"))
    return f"MCP SonarQube-style rules checking {path}"


TOOL_META: dict[str, dict[str, Any]] = {
    "grep_codebase":           {"icon": "🔍",  "display": "Codebase search",        "describe": _grep_msg},
    "read_file":               {"icon": "📖",  "display": "File reader",            "describe": _read_file_msg},
    "get_git_blame":           {"icon": "🔎",  "display": "Git blame",              "describe": _blame_msg},
    "get_recent_commits":      {"icon": "📜",  "display": "Git history",            "describe": _recent_commits_msg},
    "list_imports_and_usages": {"icon": "🔗",  "display": "Cross-reference",        "describe": _imports_msg},
    "find_similar_patterns":   {"icon": "🧩",  "display": "Pattern finder",         "describe": _similar_msg},
    "semgrep_scan":            {"icon": "🛡️", "display": "MCP Semgrep scan",       "describe": _semgrep_msg},
    "mcp_lint_check":          {"icon": "🔧",  "display": "MCP Linter",             "describe": _mcp_lint_msg},
    "mcp_sonar_check":         {"icon": "📊",  "display": "MCP SonarQube rules",    "describe": _mcp_sonar_msg},
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
