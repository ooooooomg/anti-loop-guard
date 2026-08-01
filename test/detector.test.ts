/**
 * Loop detector tests.
 *
 * NOTE: Thresholds are adaptive — in early sessions (< 50 calls) thresholds
 * are relaxed (×1.5). Exact repeat warn fires at ceil(5 × 1.5) = 8 consecutive,
 * block at ceil(8 × 1.5) = 12 consecutive. Use enough calls to exceed thresholds.
 */
import crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { detectLoop, logAndDetect } from "../src/detector.js";
import { reset, getTotalCalls } from "../src/state.js";

const TEST_STATE_DIR = process.env.ANTI_LOOP_STATE_DIR!;

describe("detectLoop", () => {
  beforeEach(() => {
    reset();
  });

  it("returns healthy when no tool calls recorded", () => {
    const result = detectLoop();
    expect(result.isStuck).toBe(false);
    expect(result.pattern).toBe("healthy");
  });

  it("detects exact repeat after exceeding adaptive threshold (9 calls)", () => {
    // logAndDetect records internally, then detects
    for (let i = 0; i < 9; i++) {
      logAndDetect("Bash", { command: "echo test" });
    }
    // 9 > ceil(5 * 1.5) = 8 → exact repeat should fire
    const result = detectLoop();
    expect(result.isStuck).toBe(true);
    expect(result.pattern).toBe("exact_repeat");
  });

  it("detects exact repeat with block-level confidence after 13 identical calls", () => {
    for (let i = 0; i < 13; i++) {
      logAndDetect("Bash", { command: "echo test" });
    }
    // 13 > ceil(8 * 1.5) = 12 → block-level confidence >= 0.9
    const result = detectLoop();
    expect(result.isStuck).toBe(true);
    expect(result.pattern).toBe("exact_repeat");
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("does not flag when different tools are called in between", () => {
    const calls = [
      { tool: "Bash", args: { command: "echo a" } },
      { tool: "Read", args: { file_path: "/tmp/a.txt" } },
      { tool: "Bash", args: { command: "echo b" } },
      { tool: "Read", args: { file_path: "/tmp/b.txt" } },
    ];
    for (const c of calls) {
      logAndDetect(c.tool, c.args);
    }
    const result = detectLoop();
    expect(result.isStuck).toBe(false);
  });

  it("masks UUIDs so calls are detected as identical (after normalization)", () => {
    for (let i = 0; i < 9; i++) {
      logAndDetect("Read", {
        file_path: `/tmp/${crypto.randomUUID()}/output.json`,
      });
    }
    // After fingerprint normalization, all UUID paths are identical
    const result = detectLoop();
    expect(result.isStuck).toBe(true);
    expect(result.pattern).toBe("exact_repeat");
  });

  it("detects a 2-cycle A→B stuck loop after 4 repetitions (8 calls)", () => {
    for (let i = 0; i < 4; i++) {
      logAndDetect("Bash", { command: "npm test" });
      logAndDetect("Read", { file_path: "/tmp/log.txt" });
    }
    const result = detectLoop();
    expect(result.isStuck).toBe(true);
    expect(result.pattern).toBe("pattern_cycle");
  });

  it("detects semantic similarity across near-identical consecutive calls", () => {
    // 6 near-identical calls: only the log name differs, the shared command
    // dominates → pairwise similarity ~0.89, above the 0.80 threshold.
    for (const n of [1, 2, 3, 4, 5, 6]) {
      logAndDetect("Bash", {
        command: `cat /var/log/app-${n}.txt && echo done && grep error /var/log/app-${n}.txt && tail -20 /var/log/app-${n}.txt`,
      });
    }
    const result = detectLoop();
    expect(result.isStuck).toBe(true);
    expect(result.pattern).toBe("semantic_similarity");
  });

  it("merges PreToolUse hook records so the passive path is visible", () => {
    const hookFile = path.join(TEST_STATE_DIR, "hook_records.json");
    const nowSec = Date.now() / 1000;
    const records = Array.from({ length: 9 }, (_, i) => ({
      toolName: "Bash",
      fingerprint: "aabbccddeeff0011",
      normalized: `Bash\x00{"command":"echo x"}`,
      timestamp: nowSec + i,
    }));
    fs.writeFileSync(
      hookFile,
      JSON.stringify({ sessionId: "test", records, totalCalls: 9, blockedCount: 0 }),
      "utf-8"
    );

    // server-side detectLoop must see the hook's records (merged, not re-recorded)
    const result = detectLoop();
    expect(getTotalCalls()).toBe(9);
    expect(result.isStuck).toBe(true);
    expect(result.pattern).toBe("exact_repeat");
  });

  it("does not double-count a call recorded by both hook and log_tool_call", () => {
    const hookFile = path.join(TEST_STATE_DIR, "hook_records.json");
    const nowMs = Date.now();
    const record = {
      toolName: "Bash",
      toolUseId: "call_abc123",
      fingerprint: "aabbccddeeff0011",
      normalized: `Bash\x00{"command":"echo x"}`,
      timestamp: nowMs,
    };
    fs.writeFileSync(
      hookFile,
      JSON.stringify({ sessionId: "test", records: [record], totalCalls: 1, blockedCount: 0 }),
      "utf-8"
    );

    // Server records the same call (same tool_use_id) → deduped exactly
    logAndDetect("Bash", { command: "echo x" }, "call_abc123");
    const total = getTotalCalls();
    expect(total).toBe(1); // merged, not 2
  });

  it("keeps distinct tool_use_ids even when fingerprints and timestamps match", () => {
    const hookFile = path.join(TEST_STATE_DIR, "hook_records.json");
    const nowMs = Date.now();
    const records = Array.from({ length: 9 }, (_, i) => ({
      toolName: "Bash",
      toolUseId: `call_${i}`,
      fingerprint: "aabbccddeeff0011",
      normalized: "x",
      timestamp: nowMs,
    }));
    fs.writeFileSync(
      hookFile,
      JSON.stringify({ sessionId: "test", records, totalCalls: 9, blockedCount: 0 }),
      "utf-8"
    );
    const result = detectLoop();
    expect(getTotalCalls()).toBe(9); // all distinct ids kept, none deduped
    expect(result.isStuck).toBe(true);
    expect(result.pattern).toBe("exact_repeat");
  });
});
