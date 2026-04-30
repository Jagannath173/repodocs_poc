"""Per-review-type tool whitelist. Keys must match REVIEW_TYPE values sent by the extension."""

TOOLS_BY_REVIEW_TYPE: dict[str, list[str]] = {
    "quality":     ["grep_codebase", "read_file", "list_imports_and_usages", "find_similar_patterns", "mcp_lint_check", "mcp_sonar_check"],
    "security":    ["grep_codebase", "read_file", "list_imports_and_usages", "semgrep_scan", "get_git_blame", "mcp_lint_check"],
    "performance": ["grep_codebase", "read_file", "list_imports_and_usages", "find_similar_patterns", "get_recent_commits", "mcp_sonar_check"],
    "syntax":      ["grep_codebase", "read_file", "mcp_lint_check"],
    "cloud":       ["grep_codebase", "read_file", "list_imports_and_usages"],
    "orgStd":      ["grep_codebase", "read_file", "find_similar_patterns", "list_imports_and_usages", "mcp_sonar_check"],
    "ckDesign":    ["grep_codebase", "read_file", "find_similar_patterns", "list_imports_and_usages", "mcp_sonar_check"],
    "bigquery":    ["grep_codebase", "read_file"],
    # Guided apply: user-supplied instruction is applied as a whole-file edit.
    # The agent investigates the codebase to ensure the edit stays consistent with
    # existing conventions and doesn't break callers before producing the new file.
    "guidedApply": ["grep_codebase", "read_file", "list_imports_and_usages", "find_similar_patterns", "get_recent_commits", "mcp_lint_check", "mcp_sonar_check"],
}

DEFAULT_TOOL_SET = ["grep_codebase", "read_file"]


def select_tool_names(review_type: str) -> list[str]:
    return TOOLS_BY_REVIEW_TYPE.get(review_type, DEFAULT_TOOL_SET)


def load_tools(names: list[str]):
    """Import the requested tools. Tools that fail to import are silently skipped so that a
    missing optional dep (tree-sitter, semgrep) degrades gracefully."""
    loaded = []
    for name in names:
        try:
            if name == "grep_codebase":
                from ..tools.grep_codebase import grep_codebase as t
            elif name == "read_file":
                from ..tools.read_file import read_file as t
            elif name == "get_git_blame":
                from ..tools.get_git_blame import get_git_blame as t
            elif name == "get_recent_commits":
                from ..tools.get_recent_commits import get_recent_commits as t
            elif name == "list_imports_and_usages":
                from ..tools.list_imports_and_usages import list_imports_and_usages as t
            elif name == "find_similar_patterns":
                from ..tools.find_similar_patterns import find_similar_patterns as t
            elif name == "semgrep_scan":
                from ..tools.semgrep_scan import semgrep_scan as t
            elif name == "mcp_lint_check":
                from ..tools.mcp_lint_check import mcp_lint_check as t
            elif name == "mcp_sonar_check":
                from ..tools.mcp_sonar_check import mcp_sonar_check as t
            else:
                continue
            loaded.append(t)
        except Exception:
            continue
    return loaded
