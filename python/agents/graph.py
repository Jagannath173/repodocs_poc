"""LangGraph plan -> tools -> synthesize loop for a single review type."""
import json
import os
from typing import Annotated, TypedDict

from langchain_core.messages import AnyMessage, AIMessage, AIMessageChunk, HumanMessage, SystemMessage, ToolMessage
from langgraph.graph import StateGraph, END
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode

from . import streaming
from .llm import build_chat_model
from .tool_meta import describe_call, summarize_result


AGENT_SYSTEM_PROMPT = (
    "You are a senior code reviewer. You have been given a file to review and a set of tools to "
    "investigate the codebase. Before emitting findings, use tools when they will meaningfully "
    "improve the review (e.g. confirm a symbol is used elsewhere, check recent history, scan for "
    "security patterns, find similar implementations).\n\n"
    "Rules:\n"
    "1. Call tools only when the extra context is likely to change what you report.\n"
    "2. Do not call the same tool with the same arguments twice.\n"
    "3. When you have enough context, respond with a single JSON object matching this shape:\n"
    '   {"findings":[{"severity":"critical|high|medium|low|info","category":"<short>","title":"<short>","detail":"<explanation>","suggestion":"<concrete code-level fix>"}]}\n'
    "4. Output ONLY the JSON object in your final message. No commentary, no markdown fence.\n"
    "5. Each finding must be directly fixable in the file under review. Omit speculative or style-only nits.\n"
    "6. Merge duplicates. Prefer the smallest possible edit."
)


class ReviewState(TypedDict):
    messages: Annotated[list[AnyMessage], add_messages]
    iterations: int
    max_iterations: int


def _plan_factory(llm_with_tools):
    def plan(state: ReviewState):
        iters = state.get("iterations", 0)
        max_iters = state.get("max_iterations", 8)
        if iters >= max_iters:
            return {"messages": [AIMessage(content='{"findings":[]}')], "iterations": iters + 1}
        # When run under stream_mode="messages", LangGraph intercepts the LLM call and
        # emits AIMessageChunk events for each token. We still call .invoke() so the
        # returned message is the fully-aggregated one for state bookkeeping.
        response = llm_with_tools.invoke(state["messages"])
        tool_calls = getattr(response, "tool_calls", None) or []
        for call in tool_calls:
            name = call.get("name", "") or ""
            args = call.get("args") or {}
            icon, message = describe_call(name, args)
            preview = json.dumps(args, ensure_ascii=False)[:200]
            streaming.emit_tool_event("call", name, message=message, icon=icon, preview=preview)
        return {"messages": [response], "iterations": iters + 1}
    return plan


def _tools_node_factory(tools: list):
    tool_node = ToolNode(tools)

    def tools_step(state: ReviewState):
        result = tool_node.invoke(state)
        for msg in result.get("messages", []):
            if isinstance(msg, ToolMessage):
                name = msg.name or "tool"
                raw = str(msg.content)
                summary = summarize_result(name, raw)
                streaming.emit_tool_event(
                    "result", name, message=summary, icon="↳", preview=raw[:200]
                )
        return result
    return tools_step


def _route(state: ReviewState) -> str:
    last = state["messages"][-1]
    iters = state.get("iterations", 0)
    max_iters = state.get("max_iterations", 8)
    if iters > max_iters:
        return "finalize"
    if isinstance(last, AIMessage) and getattr(last, "tool_calls", None):
        return "tools"
    return "finalize"


def _finalize(state: ReviewState):
    """No-op terminal node. Streaming happens at the run_review_agent level via
    stream_mode='messages', so nothing needs to be emitted here. We keep the node to give
    the graph a clean END transition."""
    return state


def build_graph(tools: list, llm):
    llm_with_tools = llm.bind_tools(tools) if tools else llm
    g = StateGraph(ReviewState)
    g.add_node("plan", _plan_factory(llm_with_tools))
    g.add_node("tools", _tools_node_factory(tools))
    g.add_node("finalize", _finalize)
    g.set_entry_point("plan")
    g.add_conditional_edges("plan", _route, {"tools": "tools", "finalize": "finalize"})
    g.add_edge("tools", "plan")
    g.add_edge("finalize", END)
    return g.compile()


def run_review_agent(prompt: str, session_token_b64: str, review_type: str) -> None:
    from .tool_config import select_tool_names, load_tools

    max_iters = int(os.environ.get("GITHUB_COPILOT_AGENT_MAX_ITERATIONS", "8"))
    tool_names = select_tool_names(review_type)
    tools = load_tools(tool_names)
    llm = build_chat_model(session_token_b64)

    messages = [SystemMessage(content=AGENT_SYSTEM_PROMPT), HumanMessage(content=prompt)]
    graph = build_graph(tools, llm)

    # stream_mode="messages" yields (chunk, metadata) pairs as the LLM inside a node
    # produces tokens. We forward AIMessageChunk text tokens as SSE `delta.content` so the
    # TS webview renders progressively, exactly like the non-agent generate_response path.
    # Chunks produced during tool-calling iterations typically have empty content (only
    # `tool_call_chunks`) and are naturally skipped by the emit guard.
    for chunk, _metadata in graph.stream(
        {"messages": messages, "iterations": 0, "max_iterations": max_iters},
        stream_mode="messages",
    ):
        if not isinstance(chunk, AIMessageChunk):
            continue
        content = chunk.content
        if isinstance(content, list):
            # Some providers return list-of-parts; join text parts.
            content = "".join(
                p.get("text", "") if isinstance(p, dict) else str(p) for p in content
            )
        if isinstance(content, str) and content:
            streaming.emit_text_delta(content)

    streaming.emit_done()
