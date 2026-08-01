#!/usr/bin/env python3
"""
Anti-Loop Guard — PreToolUse Hook

Passively records every tool call to the anti-loop-guard state file
(~/.anti-loop-guard/hook_records.json) so the MCP server can detect loops
even when the agent never calls log_tool_call.

The fingerprint here is a byte-for-byte port of src/fingerprint.ts so that
the server (which merges this file) and the hook agree on identities.

Install: npx anti-loop-guard init --hooks
"""

import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path

STATE_DIR = Path.home() / ".anti-loop-guard"
STATE_FILE = STATE_DIR / "hook_records.json"
WINDOW_SIZE = 32
WARN_REPEATS = 5
BLOCK_REPEATS = 8
MAX_NORMALIZED_LEN = 2000
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


def normalize_deep(value):
    """Mirror fingerprint.ts normalizeDeep(): volatile keys are REPLACED
    by the placeholder value (not dropped), keys sorted recursively."""
    if isinstance(value, str):
        return mask_noise(value)
    if isinstance(value, list):
        arr = [normalize_deep(v) for v in value]
        if len(arr) > 20:
            arr = sorted(arr)  # treat as set, like fingerprint.ts
        return arr
    if isinstance(value, dict):
        out = {}
        for k in sorted(value.keys()):
            if k in VOLATILE_KEYS:
                out[k] = "<VOLATILE>"
            else:
                out[k] = normalize_deep(value[k])
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


def count_consecutive(records, fp):
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
        "fingerprint": fp,
        "normalized": normalized[:MAX_NORMALIZED_LEN],
        # milliseconds, matching the server's Date.now() so cross-source dedup works
        "timestamp": time.time() * 1000,
    })
    state["sessionId"] = session_id
    state["totalCalls"] = state.get("totalCalls", 0) + 1
    if len(records) > WINDOW_SIZE:
        records = records[-WINDOW_SIZE:]
    save_state(state)

    repeats = count_consecutive(records, fp)
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
