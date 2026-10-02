#!/usr/bin/env python3
"""
Anti-Loop Guard — Stop Hook

Checks assistant output for degradation patterns:
- Degenerate token repetition (same substring repeated dozens of times)
- Near-identical consecutive outputs (similarity > threshold)

Deliberately does NOT block on "stalling" phrases: such phrases are
common in normal cooperative output, and Stop-hook output only supports
block/allow (no soft warning), so blocking on them caused a
block → regenerate → block cascade.

Install: node cli/init.js --hooks   (from the cloned repository)
"""

import json
import os
import sys
from difflib import SequenceMatcher
from pathlib import Path

# 与 pre-tool-use.py / src/config.ts 相同的目录解析规则
STATE_DIR = Path(os.environ.get("ANTI_LOOP_STATE_DIR") or (Path.home() / ".anti-loop-guard"))
OUTPUT_CACHE = STATE_DIR / "output_cache.json"
MAX_CACHE = 3
SIMILARITY_THRESHOLD = 0.92


def main():
    try:
        input_data = json.loads(sys.stdin.read())
    except json.JSONDecodeError:
        sys.exit(0)

    assistant_text = extract_assistant_text(input_data)
    if not assistant_text or len(assistant_text) < 50:
        sys.exit(0)

    # Check 1: degenerate repetition
    rep_issue = check_degenerate_repetition(assistant_text)
    if rep_issue:
        sys.stdout.write(json.dumps({
            "decision": "block",
            "reason": f"ANTI-LOOP: {rep_issue}"
        }))
        return

    # Check 2: near-identical consecutive outputs
    sim_issue = check_output_similarity(assistant_text)
    if sim_issue:
        sys.stdout.write(json.dumps({
            "decision": "block",
            "reason": f"ANTI-LOOP: {sim_issue}"
        }))
        return

    sys.exit(0)


def extract_assistant_text(data):
    """Extract the assistant's latest message text from hook input."""
    # Stop hook provides the full conversation context
    # The last assistant message is what we want to check
    messages = data.get("messages", data.get("conversation", []))
    if not messages:
        # Fallback: try transcript_path
        transcript = data.get("transcript_path", "")
        if transcript and Path(transcript).exists():
            try:
                with open(transcript) as f:
                    lines = f.readlines()
                # Get last few assistant lines
                assistant_lines = [l for l in lines[-20:] if '"role":"assistant"' in l or '"type":"assistant"' in l]
                if assistant_lines:
                    # transcript 行是完整 JSON —— 解析出纯文本再做重复/相似检测
                    # (此前直接返回整行 JSON,与 messages 分支的纯文本语义不一致)
                    for line in reversed(assistant_lines):
                        try:
                            entry = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        msg = entry.get("message", entry)
                        content = msg.get("content", "")
                        if isinstance(content, list):
                            text = " ".join(c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text")
                        else:
                            text = str(content)
                        if text:
                            return text
                    return ""
            except Exception:
                pass
        return ""

    # messages provided directly
    for msg in reversed(messages):
        if isinstance(msg, dict) and msg.get("role") == "assistant":
            content = msg.get("content", "")
            if isinstance(content, list):
                return " ".join(c.get("text", "") for c in content if c.get("type") == "text")
            return str(content)
    return ""


def check_degenerate_repetition(text):
    """Detect if the same substring is repeated dozens of times (token collapse)."""
    # Check for repeated lines
    lines = text.strip().split("\n")
    if len(lines) > 10:
        from collections import Counter
        line_counts = Counter(lines)
        most_common_count = line_counts.most_common(1)[0][1]
        if most_common_count > len(lines) * 0.5 and most_common_count > 8:
            return f"Degenerate repetition detected: {most_common_count}/{len(lines)} lines are identical. Token collapse likely."

    # Check for repeated phrases within a single line
    words = text.split()
    if len(words) > 30:
        from collections import Counter
        # Check 5-grams
        ngrams = [" ".join(words[i:i+5]) for i in range(len(words) - 4)]
        ngram_counts = Counter(ngrams)
        top_count = ngram_counts.most_common(1)[0][1]
        if top_count > 10:
            return f"Phrase repeated {top_count} times — possible token-level degeneration."

    return None


def check_output_similarity(text):
    """Check if this output is nearly identical to previous outputs.

    IMPORTANT: a blocked output must NOT be cached — if it were, the
    regenerated reply would be compared against the blocked text and get
    blocked again, creating an infinite block/regenerate cascade.
    """
    STATE_DIR.mkdir(parents=True, exist_ok=True)

    cache = []
    if OUTPUT_CACHE.exists():
        try:
            with open(OUTPUT_CACHE) as f:
                cache = json.load(f)
        except Exception:
            pass

    for prev in cache:
        sim = SequenceMatcher(None, prev, text).ratio()
        if sim > SIMILARITY_THRESHOLD:
            return f"Output is {sim*100:.0f}% similar to a previous output. You may be repeating yourself."

    cache.append(text)
    if len(cache) > MAX_CACHE:
        cache = cache[-MAX_CACHE:]
    try:
        with open(OUTPUT_CACHE, "w") as f:
            json.dump(cache, f)
    except Exception:
        pass

    return None


if __name__ == "__main__":
    main()
