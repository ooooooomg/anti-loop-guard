/**
 * Fingerprint normalization tests.
 */
import { describe, it, expect } from "vitest";
import { fingerprint, similarity } from "../src/fingerprint.js";

describe("fingerprint", () => {
  it("produces identical fingerprints for identical args", () => {
    const a = fingerprint("Bash", { command: "echo hello" });
    const b = fingerprint("Bash", { command: "echo hello" });
    expect(a.hash).toBe(b.hash);
  });

  it("masks UUIDs in arguments", () => {
    const a = fingerprint("Read", {
      file_path: "/tmp/550e8400-e29b-41d4-a716-446655440000/output.json",
    });
    const b = fingerprint("Read", {
      file_path: "/tmp/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/output.json",
    });
    expect(a.hash).toBe(b.hash);
  });

  it("masks ISO timestamps in arguments", () => {
    const a = fingerprint("Bash", {
      command: 'echo "2024-01-15T09:30:00Z"',
    });
    const b = fingerprint("Bash", {
      command: 'echo "2025-12-25T23:59:59Z"',
    });
    expect(a.hash).toBe(b.hash);
  });

  it("strips volatile keys from objects", () => {
    const a = fingerprint("Tool", {
      query: "select * from users",
      request_id: "abc-123",
      trace_id: "xyz-456",
      timestamp: "2024-01-01T00:00:00Z",
    });
    const b = fingerprint("Tool", {
      query: "select * from users",
      request_id: "def-789",
      trace_id: "uvw-012",
      timestamp: "2025-12-31T23:59:59Z",
    });
    expect(a.hash).toBe(b.hash);
  });

  it("produces different fingerprints for different tool names", () => {
    const a = fingerprint("Bash", { command: "ls" });
    const b = fingerprint("Read", { command: "ls" });
    expect(a.hash).not.toBe(b.hash);
  });

  it("produces different fingerprints for meaningfully different args", () => {
    const a = fingerprint("Bash", { command: "npm test" });
    const b = fingerprint("Bash", { command: "npm run build" });
    expect(a.hash).not.toBe(b.hash);
  });
});

describe("similarity", () => {
  it("returns 1.0 for identical strings", () => {
    expect(similarity("hello world", "hello world")).toBe(1.0);
  });

  it("returns < 0.5 for completely different strings", () => {
    const a = "abcdefghijklmnop";
    const b = "zyxwvutsrqponmlk";
    expect(similarity(a, b)).toBeLessThan(0.5);
  });

  it("returns high value for nearly identical strings", () => {
    const a = fingerprint("Bash", { command: "echo test1" }).normalized;
    const b = fingerprint("Bash", { command: "echo test2" }).normalized;
    expect(similarity(a, b)).toBeGreaterThan(0.7);
  });
});

// 黄金向量:与 hooks/pre-tool-use.py(test/test_hooks.py)双侧逐位锁定。
// 任何一端改指纹算法,两边的这组断言会同时红 —— 必须同步改并更新向量。
describe("fingerprint golden vectors (TS/Python parity)", () => {
  const vectors: Array<[string, Record<string, unknown>, string]> = [
    ["deep", { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: { k: { l: 1 } } } } } } } } } } } }, "63342d7e93c34cff"],
    ["unicodeDigits", { cmd: "run １２３ times" }, "dff057a6c3c0c50c"],
    ["bigArray", { list: Array.from({ length: 25 }, (_, i) => i) }, "18714b9e1f891d26"],
    ["mixedTypes", { arr: [1, "a", true, null, ...Array(20).fill(2)] }, "61143e9826edd3e2"],
  ];
  for (const [name, args, expected] of vectors) {
    it(`matches golden vector: ${name}`, () => {
      expect(fingerprint("t", args).hash).toBe(expected);
    });
  }
});
