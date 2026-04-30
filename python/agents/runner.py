"""Public entry point invoked from copilot_client.py when GITHUB_COPILOT_AGENT_MODE=1."""
import os
import traceback
from . import streaming


def run_review_agent(prompt: str, session_token_b64: str, access_token: str = "") -> None:
    review_type = os.environ.get("REVIEW_TYPE", "quality")
    streaming.emit_tool_event(
        "call", "agent",
        message=f"Runner entered — dispatching {review_type} review to graph",
        icon="[INIT]",
    )
    try:
        from .graph import run_review_agent as _run
        _run(prompt=prompt, session_token_b64=session_token_b64, review_type=review_type)
    except ImportError as e:
        streaming.emit_error(
            f"LangGraph dependencies not installed: {e}. "
            "Reopen the extension to trigger `pip install -r requirements.txt` in the venv, "
            "or set codeReview.agentMode to false to use the non-agent path."
        )
    except Exception as e:
        detail = traceback.format_exc()
        streaming.emit_error(f"Agent run failed ({type(e).__name__}: {e})\n\n```\n{detail}\n```")
