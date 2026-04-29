"""Emit SSE `data:` lines that the TS parser in codeReview.ts already understands.

The parser reads `choices[0].delta.content | message.content | text` and ignores other shapes,
so tool progress events are safe to emit alongside text deltas.
"""
import json
import sys


def emit_text_delta(text: str) -> None:
    if not text:
        return
    payload = {"choices": [{"delta": {"content": text}}]}
    print(f"data: {json.dumps(payload, ensure_ascii=False)}", flush=True)


def emit_final_text(text: str) -> None:
    if not text:
        return
    payload = {"choices": [{"message": {"content": text}}]}
    print(f"data: {json.dumps(payload, ensure_ascii=False)}", flush=True)


def emit_tool_event(
    event_type: str,
    name: str,
    message: str = "",
    icon: str = "",
    preview: str = "",
) -> None:
    """Emit a rich tool-activity line. The TS side renders `icon` + `message` directly
    and falls back to `name` + `preview` only if message/icon are missing. Payload also
    includes `preview` so logs retain the raw args/result for debugging."""
    payload = {
        "tool_event": {
            "type": event_type,
            "name": name,
            "message": (message or "")[:400],
            "icon": icon or "",
            "preview": (preview or "")[:240],
        }
    }
    print(f"data: {json.dumps(payload, ensure_ascii=False)}", flush=True)


def emit_done() -> None:
    print("data: [DONE]", flush=True)


def emit_error(message: str) -> None:
    emit_text_delta(f"\n\n**Agent error:** {message}\n")
    emit_done()
