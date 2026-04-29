import ast
from langchain_core.tools import tool
from .base import workspace_root, iter_workspace_files

try:
    from tree_sitter_languages import get_parser  # type: ignore
    _TREE_SITTER_OK = True
except Exception:
    get_parser = None  # type: ignore
    _TREE_SITTER_OK = False


MAX_HITS = 40


def _python_function_shapes(source: str) -> set[str]:
    shapes: set[str] = set()
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return shapes
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            arg_count = len(node.args.args) + len(node.args.kwonlyargs)
            body_kinds = tuple(type(n).__name__ for n in node.body[:8])
            shapes.add(f"args={arg_count};body={'>'.join(body_kinds)}")
    return shapes


@tool
def find_similar_patterns(path: str, line: int) -> str:
    """For a function or block around the given line in the given file, find up to 40 other
    functions in the codebase with a structurally similar shape (same arg count and top-level body
    node kinds). Useful for detecting convention drift or finding reference implementations.

    Args:
        path: Workspace-relative file path containing the target function/block.
        line: 1-based line number inside the target function.
    """
    root = workspace_root()
    target = (root / path).resolve()
    try:
        target.relative_to(root)
    except ValueError:
        return "(error: path escapes workspace)"
    if not target.exists() or not target.is_file():
        return f"(error: file not found: {path})"
    if target.suffix != ".py":
        if not _TREE_SITTER_OK:
            return "(tree-sitter not installed; this tool only supports .py files in fallback mode)"
        return "(non-Python AST matching not yet implemented; use grep_codebase or list_imports_and_usages)"

    try:
        src = target.read_text(encoding="utf-8", errors="ignore")
        tree = ast.parse(src)
    except (OSError, SyntaxError) as e:
        return f"(error parsing target: {e})"

    target_node = None
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            start = node.lineno
            end = getattr(node, "end_lineno", start)
            if start <= line <= end:
                target_node = node
                break
    if target_node is None:
        return "(no function found at that line)"

    target_args = len(target_node.args.args) + len(target_node.args.kwonlyargs)
    target_body = tuple(type(n).__name__ for n in target_node.body[:8])

    hits: list[str] = []
    for p in iter_workspace_files(root):
        if p.suffix != ".py" or p == target:
            continue
        try:
            src2 = p.read_text(encoding="utf-8", errors="ignore")
            tree2 = ast.parse(src2)
        except (OSError, SyntaxError):
            continue
        for node in ast.walk(tree2):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                if len(node.args.args) + len(node.args.kwonlyargs) != target_args:
                    continue
                body = tuple(type(n).__name__ for n in node.body[:8])
                if body == target_body:
                    rel = p.relative_to(root).as_posix()
                    hits.append(f"{rel}:{node.lineno}: def {node.name}(...)")
                    if len(hits) >= MAX_HITS:
                        return "\n".join(hits)
    return "\n".join(hits) if hits else "(no similar functions found)"
