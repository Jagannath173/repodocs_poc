"""LangGraph plan -> tools -> synthesize loop for a single review type."""
import json
import os
import re
from typing import Annotated, TypedDict

from langchain_core.messages import AnyMessage, AIMessage, AIMessageChunk, HumanMessage, SystemMessage, ToolMessage
from langgraph.graph import StateGraph, END
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode

from . import streaming
from .llm import build_chat_model
from .system_prompts import build_system_prompt
from .tool_meta import describe_call, summarize_result


def _extract_active_file(prompt: str) -> str:
    """Pull the 'Active file: <path>' line out of the Jinja-rendered user prompt so the
    agent can call path-taking tools with a real workspace-relative path."""
    m = re.search(r"^Active file:\s*(.+)$", prompt, re.MULTILINE)
    return m.group(1).strip() if m else ""


class ReviewState(TypedDict):
    messages: Annotated[list[AnyMessage], add_messages]
    iterations: int
    max_iterations: int


def _plan_factory(llm_required, llm_auto):
    """Return a plan-node callable.

    `llm_required` is the model bound with tool_choice='any' and is used on iteration 0 so the
    agent is forced to start by investigating the codebase rather than answering from memory.
    `llm_auto` is the standard tool_choice='auto' binding used for later iterations so the
    agent can decide to produce findings once it has enough context.
    """
    def plan(state: ReviewState):
        iters = state.get("iterations", 0)
        max_iters = state.get("max_iterations", 8)
        if iters >= max_iters:
            return {"messages": [AIMessage(content='{"findings":[]}')], "iterations": iters + 1}

        # Emit an immediate "planning" event so the user sees progress BEFORE the first
        # LLM response arrives.
        thinking_msg = (
            "Planning investigation strategy"
            if iters == 0
            else f"Evaluating next investigation step (iteration {iters + 1})"
        )
        streaming.emit_tool_event("call", "agent", message=thinking_msg, icon="[PLAN]")

        # On the first iteration, force the model to call a tool (tool_choice='any') so it
        # cannot skip investigation entirely and answer from prior knowledge.
        model = llm_required if iters == 0 else llm_auto
        try:
            response = model.invoke(state["messages"])
        except Exception as e:
            # If tool_choice='any' isn't supported by the provider, fall back to auto so
            # the review at least completes.
            if iters == 0 and llm_required is not llm_auto:
                streaming.emit_tool_event(
                    "call", "agent",
                    message=f"Provider rejected forced tool call ({type(e).__name__}); retrying with automatic tool choice",
                    icon="[NOTE]",
                )
                response = llm_auto.invoke(state["messages"])
            else:
                raise
        tool_calls = getattr(response, "tool_calls", None) or []

        if tool_calls:
            for call in tool_calls:
                name = call.get("name", "") or ""
                args = call.get("args") or {}
                icon, message = describe_call(name, args)
                preview = json.dumps(args, ensure_ascii=False)[:200]
                streaming.emit_tool_event("call", name, message=message, icon=icon, preview=preview)
        else:
            if iters == 0:
                streaming.emit_tool_event(
                    "call", "agent",
                    message="Model produced findings without tool use — they may be grounded only in the snippet",
                    icon="[NOTE]",
                )
            streaming.emit_tool_event(
                "call", "synthesis",
                message="Consolidating findings and generating review report",
                icon="[SYNTH]",
            )

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
                    "result", name, message=summary, icon="[RESULT]", preview=raw[:200]
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
    if tools:
        llm_auto = llm.bind_tools(tools)
        try:
            llm_required = llm.bind_tools(tools, tool_choice="any")
        except TypeError:
            # Older langchain-openai versions don't accept tool_choice on bind_tools.
            llm_required = llm_auto
    else:
        llm_auto = llm
        llm_required = llm
    g = StateGraph(ReviewState)
    g.add_node("plan", _plan_factory(llm_required, llm_auto))
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

    active_file = _extract_active_file(prompt)
    workspace_root = os.environ.get("WORKSPACE_ROOT", "")
    system_prompt = build_system_prompt(review_type, active_file, workspace_root)

    # Immediate kick-off event so the webview switches from "Analyzing current code…"
    # to a live agent-activity line before the first LLM call returns.
    loaded_tool_names = [getattr(t, "name", "") for t in tools if getattr(t, "name", "")]
    streaming.emit_tool_event(
        "call", "agent",
        message=(
            f"Initializing {review_type} review agent | active file: "
            f"{active_file or '(unknown)'} | tools: {', '.join(loaded_tool_names) or 'none'}"
        ),
        icon="[INIT]",
    )

    messages = [SystemMessage(content=system_prompt), HumanMessage(content=prompt)]
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
