#!/usr/bin/env python3
"""Hooks 回归测试(unittest,标准库):黄金向量与 TS 端逐位一致、records 窗口有界、
混合类型不崩溃、会话内计数。CI 中与 vitest 并行跑(python -m unittest)。

黄金向量与 test/fingerprint.test.ts 共享 —— 两端任意一侧改动指纹算法都会立刻红。
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
HOOK = REPO / "hooks" / "pre-tool-use.py"

GOLDEN = [
    # (name, args, expected-hash) — 由 src/fingerprint.ts 计算并双侧锁定
    ("deep", {"a": {"b": {"c": {"d": {"e": {"f": {"g": {"h": {"i": {"j": {"k": {"l": 1}}}}}}}}}}}},
     "63342d7e93c34cff"),
    ("unicodeDigits", {"cmd": "run １２３ times"}, "dff057a6c3c0c50c"),
    ("bigArray", {"list": list(range(25))}, "18714b9e1f891d26"),
    ("mixedTypes", {"arr": [1, "a", True, None] + [2] * 20}, "61143e9826edd3e2"),
]


def load_hook_module():
    import importlib.util
    spec = importlib.util.spec_from_file_location("ptu_under_test", HOOK)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class TestFingerprintParity(unittest.TestCase):
    def setUp(self):
        self.mod = load_hook_module()

    def test_golden_vectors(self):
        for name, args, expected in GOLDEN:
            with self.subTest(name):
                digest, _ = self.mod.fingerprint("t", args)
                self.assertEqual(digest, expected)

    def test_mixed_type_array_does_not_crash(self):
        # 旧实现 bare sorted() 在混合类型上 TypeError → 该次调用漏检
        digest, _ = self.mod.fingerprint("t", {"arr": [1, "a"] + [2] * 20})
        self.assertEqual(len(digest), 16)


class TestHookRecordsWindow(unittest.TestCase):
    """回归:records 必须真正有界(旧实现只重绑局部名,state 里无限增长)。"""

    def test_records_bounded_after_many_calls(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = dict(os.environ, ANTI_LOOP_STATE_DIR=tmp)
            for i in range(50):
                subprocess.run(
                    [sys.executable, str(HOOK)],
                    input=json.dumps({"tool_name": "Bash", "tool_input": {"cmd": f"echo {i}"},
                                      "session_id": "s1"}),
                    capture_output=True, text=True, env=env, check=True,
                )
            state_file = Path(tmp) / "hook_records.json"
            state = json.loads(state_file.read_text(encoding="utf-8"))
            self.assertLessEqual(len(state["records"]), self.mod_window(),
                                 "records 超出窗口:截断 bug 复现")
            self.assertEqual(state["totalCalls"], 50)

    @staticmethod
    def mod_window():
        mod = load_hook_module()
        return mod.WINDOW_SIZE


class TestSessionScopedCounting(unittest.TestCase):
    """hook 端按 session 计连击:不同 session 的相同调用不互相累计。"""

    def test_sessions_do_not_cross_count(self):
        mod = load_hook_module()
        records = [
            {"fingerprint": "x", "sessionId": "s1"},
            {"fingerprint": "x", "sessionId": "s1"},
            {"fingerprint": "x", "sessionId": "s2"},  # 换会话即断链
        ]
        self.assertEqual(mod.count_consecutive(records, "x", "s1"), 2)
        self.assertEqual(mod.count_consecutive(records, "x", "s2"), 1)


if __name__ == "__main__":
    unittest.main()
