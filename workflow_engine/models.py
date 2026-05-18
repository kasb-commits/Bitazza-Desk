"""
Data models for the workflow engine.

All are plain dataclasses — no ORM, no framework coupling.
"""
from __future__ import annotations
from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class ExecutionStatus(str, Enum):
    RUNNING          = "running"
    WAITING_MESSAGE  = "waiting_message"
    WAITING_TRIGGER  = "waiting_trigger"
    COMPLETED        = "completed"
    FAILED           = "failed"
    ABANDONED        = "abandoned"


@dataclass
class WorkflowTrigger:
    channel: str   # "widget" | "email" | "any"
    category: str  # "kyc_verification" | ... | "any"


@dataclass
class WorkflowNode:
    id: str
    kind: str          # "send_reply" | "ai_reply" | "account_lookup" | "condition" |
                       # "escalate" | "wait_for_reply" | "wait_for_trigger" |
                       # "resolve_ticket" | "set_variable"
    config: dict[str, Any]
    next_node_id: str | None = None
    on_error_next_id: str | None = None  # optional node to route to when this node raises


@dataclass
class Workflow:
    id: str
    name: str
    trigger: WorkflowTrigger
    nodes: list[WorkflowNode]
    edges: list[dict]
    published: bool
    version: int

    def get_node(self, node_id: str) -> WorkflowNode | None:
        for n in self.nodes:
            if n.id == node_id:
                return n
        return None

    def first_node(self) -> WorkflowNode | None:
        return self.nodes[0] if self.nodes else None


@dataclass
class WorkflowExecution:
    id: str
    workflow_id: str
    conversation_id: str
    current_node_id: str | None
    variables: dict[str, Any]
    status: ExecutionStatus
    waiting_for: str | None   # None | "message" | "external_trigger:{token}"
    channel: str
    category: str
    output_reply: str | None = None
    escalated: bool = False
    resolved: bool = False
    transition_message: str | None = None


@dataclass
class ExecutionContext:
    variables: dict[str, Any]
    conversation_id: str
    user_id: str | None   # None for guest (unauthenticated) sessions
    channel: str
    dry_run: bool = False


@dataclass
class NodeResult:
    output: dict[str, Any]
    next_node_id: str | None = None
    pause: bool = False
    waiting_for: str | None = None  # "message" | "external_trigger:{token}"


@dataclass
class RouterResult:
    matched_workflow: Workflow | None
    active_execution: WorkflowExecution | None
    fallthrough: bool
    category_upgrade: str | None = None
