"""Wire ChatOpenAI to the GitHub Copilot proxy using existing auth machinery."""
import base64
import os
from langchain_openai import ChatOpenAI


def _copilot_headers(session_token_b64: str) -> dict[str, str]:
    session_token = base64.b64decode(session_token_b64).decode("utf-8")
    return {
        "Authorization": f"Bearer {session_token}",
        "Editor-Version": "vscode/1.93.1",
        "Editor-Plugin-Version": "copilot-chat/0.20.3",
        "User-Agent": "GitHubCopilot/1.155.0",
        "Accept-Encoding": "gzip, deflate, br",
        "Copilot-Integration-Id": "vscode-chat",
    }


def build_chat_model(session_token_b64: str) -> ChatOpenAI:
    base_url = os.environ.get(
        "GITHUB_COPILOT_LLM_CHAT_URL",
        "https://api.githubcopilot.com/chat/completions",
    )
    if base_url.endswith("/chat/completions"):
        base_url = base_url[: -len("/chat/completions")]

    model = os.environ.get("GITHUB_COPILOT_AGENT_MODEL") or os.environ.get("GITHUB_COPILOT_MODEL") or "gpt-5.5"
    temperature = float(os.environ.get("GITHUB_COPILOT_TEMPERATURE", "0.1"))

    session_token = base64.b64decode(session_token_b64).decode("utf-8")

    return ChatOpenAI(
        model=model,
        temperature=temperature,
        base_url=base_url,
        api_key=session_token,
        default_headers=_copilot_headers(session_token_b64),
        max_retries=1,
        timeout=120,
        streaming=True,
    )
