import os
from pathlib import Path


class ToolUnavailable(Exception):
    pass


def workspace_root() -> Path:
    root = os.environ.get("WORKSPACE_ROOT") or os.getcwd()
    return Path(root).resolve()


def resolve_in_workspace(rel_or_abs_path: str) -> Path:
    root = workspace_root()
    p = Path(rel_or_abs_path)
    candidate = p if p.is_absolute() else (root / p)
    candidate = candidate.resolve()
    try:
        candidate.relative_to(root)
    except ValueError:
        raise ValueError(f"Path '{rel_or_abs_path}' escapes workspace root '{root}'.")
    return candidate


EXCLUDED_DIR_NAMES = {
    "node_modules", "out", ".git", "venv", "__pycache__",
    ".cursor", ".vscode", "dist", "build", ".next", ".turbo",
    "coverage", ".pytest_cache", ".mypy_cache",
}


def iter_workspace_files(root: Path, max_files: int = 5000):
    count = 0
    for current, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDED_DIR_NAMES and not d.startswith(".")]
        for name in filenames:
            if name.startswith("."):
                continue
            p = Path(current) / name
            yield p
            count += 1
            if count >= max_files:
                return
