#!/usr/bin/env python3
"""
Anti-Loop Guard — PreToolUse Hook

Passively records every tool call to the anti-loop-guard state file
(~/.anti-loop-guard/hook_records.json) so the MCP server can detect loops
even when the agent never calls log_tool_call.

The fingerprint here mirrors src/fingerprint.ts (same regexes, same order,
same depth limit, same set-style sort) so the server (which merges this
file) and the hook agree on identities. Known accepted divergences are
documented next to normalize_deep().

Install: node cli/init.js --hooks   (from the cloned repository)
"""

import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path

# Honors the same override as src/config.ts (ANTI_LOOP_STATE_DIR), so the
# server and the hooks always read/write the same directory.
STATE_DIR = Path(os.environ.get("ANTI_LOOP_STATE_DIR") or (Path.home() / ".anti-loop-guard"))
__VERSION__ = "1.1.0"  # 与 package.json 同步;cli/init.js 据此检测已安装 hooks 是否过期
STATE_FILE = STATE_DIR / "hook_records.json"
WINDOW_SIZE = 32
WARN_REPEATS = 5
BLOCK_REPEATS = 8
# Safety cap against pathological multi-megabyte args; the window is bounded
# (WINDOW_SIZE) so full normalized strings are stored by default.
MAX_NORMALIZED_LEN = 100_000
VOLATILE_KEYS = frozenset([
    "request_id", "trace_id", "span_id", "correlation_id",
    "created_at", "updated_at", "timestamp", "date",
    "session_id", "run_id", "execution_id", "job_id",
    "task_id", "tool_use_id", "conversation_id",
    "cache_key", "etag", "x-request-id",
])

# Regexes below mirror fingerprint.ts — same patterns, same ORDER.
UUID_RE = re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", re.IGNORECASE)
TIMESTAMP_ISO_RE = re.compile(r"\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b")
TIMESTAMP_UNIX_RE = re.compile(r"\b\d{10,13}\b")
HEX64_RE = re.compile(r"\b[0-9a-f]{64}\b", re.IGNORECASE)
HEX32_RE = re.compile(r"\b[0-9a-f]{32}\b", re.IGNORECASE)
SEMVER_RE = re.compile(r"\b\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?\b")


def mask_noise(s):
    """Order of replacements must match fingerprint.ts maskNoise()."""
    s = UUID_RE.sub("<UUID>", s)
    s = TIMESTAMP_ISO_RE.sub("<TIMESTAMP>", s)
    s = HEX64_RE.sub("<HASH>", s)
    s = HEX32_RE.sub("<HASH>", s)
    s = TIMESTAMP_UNIX_RE.sub("<UNIX_TS>", s)
    s = SEMVER_RE.sub("<SEMVER>", s)
    s = re.sub(r"\d+", lambda m: "<NUM>" if len(m.group(0)) >= 5 else m.group(0), s)
    return s


def _js_str(value):
    """JS String() 语义(bool/None 的小写形式),保证大数组排序与 TS 侧一致。"""
    if value is True:
        return "true"
    if value is False:
        return "false"
    if value is None:
        return "null"
    return str(value)


def normalize_deep(value, depth=0):
    """Mirror fingerprint.ts normalizeDeep(): volatile keys are REPLACED
    by the placeholder value (not dropped), keys sorted recursively,
    nesting beyond 10 levels collapses to "<DEEP>" (same as limitDepth()).

    Known accepted divergences from the TS side, kept deliberately small:
    - floats format as Python str (1.0 -> "1.0") vs JS String (1.0 -> "1");
      integers, strings and bools are identical.
    - arrays of >20 objects sort by Python str(dict) here vs "[object Object]"
      (i.e. original order) in JS; scalar arrays sort identically (key=str
      matches JS default sort, which stringifies elements).
    """
    if isinstance(value, str):
        return mask_noise(value)
    if isinstance(value, list):
        # TS 侧 limitDepth 只沿 dict 链计数、数组原样传递,数组内的 dict 从自身
        # 重新计深度 —— 这里用 depth=0 逐元素调用以保持两端一致
        arr = [normalize_deep(v, 0) for v in value]
        if len(arr) > 20:
            # key=_js_str 不抛异常且与 JS 默认 sort(元素字符串化)同序
            # (旧的裸 sorted() 在 [1, "a"] 这类混合类型上直接崩溃,导致该次调用漏检)
            arr = sorted(arr, key=_js_str)
        return arr
    if isinstance(value, dict):
        if depth >= 10:
            return "<DEEP>"
        out = {}
        for k in sorted(value.keys()):
            if k in VOLATILE_KEYS:
                out[k] = "<VOLATILE>"
            else:
                out[k] = normalize_deep(value[k], depth + 1)
        return out
    return value


def fingerprint(tool_name, args):
    normalized = tool_name + "\x00" + json.dumps(normalize_deep(args), sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:16]
    return digest, normalized


def load_state():
    try:
        if STATE_FILE.exists():
            with open(STATE_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
    except Exception:
        pass
    return {"sessionId": "unknown", "records": [], "totalCalls": 0, "blockedCount": 0}


def save_state(state):
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILE.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, STATE_FILE)  # atomic on POSIX and Windows


def count_consecutive(records, fp, session_id=None):
    # 会话过滤优先(其他会话的记录不参与本会话的连击计数),再数尾链
    if session_id is not None:
        records = [r for r in records if r.get("sessionId") in (None, session_id)]
    count = 0
    for r in reversed(records):
        if r.get("fingerprint") == fp:
            count += 1
        else:
            break
    return count


def allow_output(extra_context=None):
    out = {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow"}}
    if extra_context:
        out["hookSpecificOutput"]["additionalContext"] = extra_context
    sys.stdout.write(json.dumps(out))
    return


def deny_output(reason):
    sys.stdout.write(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }))
    return


def main():
    try:
        input_data = json.loads(sys.stdin.read())
    except json.JSONDecodeError:
        # Not valid JSON — allow through
        allow_output()
        return

    tool_name = input_data.get("tool_name", "unknown")
    tool_input = input_data.get("tool_input", {})
    tool_use_id = input_data.get("tool_use_id", "") or ""
    session_id = input_data.get("session_id", "unknown")

    fp, normalized = fingerprint(tool_name, tool_input)

    state = load_state()
    records = state.setdefault("records", [])
    records.append({
        "toolName": tool_name,
        "toolUseId": tool_use_id,
        "sessionId": session_id,
        "fingerprint": fp,
        "normalized": normalized[:MAX_NORMALIZED_LEN],
        # milliseconds, matching the server's Date.now() so cross-source dedup works
        "timestamp": time.time() * 1000,
    })
    state["sessionId"] = session_id
    state["totalCalls"] = state.get("totalCalls", 0) + 1
    # 必须写回 state["records"]:此前 `records = records[-WINDOW_SIZE:]` 只重绑了
    # 局部名,state 里仍是无限增长的数组,长会话下每次调用都全量读写越来越大的 JSON
    if len(records) > WINDOW_SIZE:
        state["records"] = records[-WINDOW_SIZE:]
        records = state["records"]
    save_state(state)

    repeats = count_consecutive(records, fp, session_id)
    if repeats >= BLOCK_REPEATS:
        state["blockedCount"] = state.get("blockedCount", 0) + 1
        save_state(state)
        deny_output(
            f"ANTI-LOOP: Same tool+args repeated {repeats} times. You are in a loop. Stop and report to user."
        )
        return
    elif repeats >= WARN_REPEATS:
        allow_output(
            f"⚠️ ANTI-LOOP WARNING: Tool '{tool_name}' with similar arguments was called "
            f"{repeats} consecutive times. You may be in a loop. Consider stopping and asking "
            f"the user if you should continue."
        )
        return
    else:
        allow_output()


if __name__ == "__main__":
    main()
