"""
condition node — evaluates variable(s) against value(s) and routes to
true_next or false_next.

Single condition (legacy):
  config: { variable, operator, value, true_next, false_next }

Compound conditions (new):
  config: { logic: "AND"|"OR", conditions: [{variable, operator, value}, ...],
            true_next, false_next }

Operators: == != contains starts_with > <
Missing variable always evaluates to False.
"""
from __future__ import annotations
import logging
from workflow_engine.models import WorkflowNode, ExecutionContext, NodeResult

logger = logging.getLogger(__name__)


def _resolve(variables: dict, path: str):
    """Resolve a dot-notation path against the variables dict.
    'account.status' → variables['account']['status']
    Falls back to a flat key lookup for backwards compatibility.
    """
    if path in variables:
        return variables[path]
    parts = path.split(".")
    val = variables
    for part in parts:
        if isinstance(val, dict) and part in val:
            val = val[part]
        else:
            return None
    return val


def _evaluate_one(variable_value, operator: str, test_value: str) -> bool:
    if variable_value is None:
        return False
    try:
        if operator == "==":
            return str(variable_value).lower() == str(test_value).lower()
        if operator == "!=":
            return str(variable_value).lower() != str(test_value).lower()
        if operator == "contains":
            return str(test_value).lower() in str(variable_value).lower()
        if operator == "starts_with":
            return str(variable_value).lower().startswith(str(test_value).lower())
        if operator == ">":
            return float(variable_value) > float(test_value)
        if operator == "<":
            return float(variable_value) < float(test_value)
    except (ValueError, TypeError):
        pass
    return False


class ConditionNode:

    def run(self, node: WorkflowNode, ctx: ExecutionContext) -> NodeResult:
        true_next  = node.config.get("true_next")
        false_next = node.config.get("false_next")

        # ── Compound conditions ───────────────────────────────────────────────
        conditions = node.config.get("conditions")
        if conditions and isinstance(conditions, list):
            logic = node.config.get("logic", "AND").upper()
            results = []
            for clause in conditions:
                var_path = clause.get("variable", "")
                operator = clause.get("operator", "==")
                value    = clause.get("value", "")
                var_value = _resolve(ctx.variables, var_path)
                results.append(_evaluate_one(var_value, operator, value))

            if logic == "OR":
                passed = any(results)
            else:
                passed = all(results)

            branch  = "true" if passed else "false"
            next_id = true_next if passed else false_next
            logger.info("condition_evaluated", extra={
                "node_id": node.id, "conv_id": ctx.conversation_id,
                "logic": logic, "num_clauses": len(conditions),
                "result": passed, "branch_taken": branch,
            })
            return NodeResult(
                output={"branch": branch, "next_node_id": next_id},
                next_node_id=next_id,
            )

        # ── Single condition (legacy) ─────────────────────────────────────────
        variable  = node.config.get("variable", "")
        operator  = node.config.get("operator", "==")
        value     = node.config.get("value", "")

        var_value = _resolve(ctx.variables, variable)
        if var_value is None:
            branch  = "false"
            next_id = false_next
        elif _evaluate_one(var_value, operator, value):
            branch  = "true"
            next_id = true_next
        else:
            branch  = "false"
            next_id = false_next

        logger.info("condition_evaluated", extra={
            "node_id": node.id, "conv_id": ctx.conversation_id,
            "variable": variable, "operator": operator, "value": value,
            "result": branch == "true", "branch_taken": branch,
        })
        return NodeResult(
            output={"branch": branch, "next_node_id": next_id},
            next_node_id=next_id,
        )
