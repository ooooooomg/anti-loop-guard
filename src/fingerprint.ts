/**
 * Tool-call argument fingerprinting with noise normalization.
 *
 * Normalizes away volatile fields (UUIDs, timestamps, paths, IDs) so that
 * semantically-identical tool calls produce the same fingerprint even when
 * their raw arguments differ in non-meaningful ways.
 */

import crypto from "node:crypto";

// ---- patterns that carry no semantic signal ----

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const TIMESTAMP_ISO_RE = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g;
const TIMESTAMP_UNIX_RE = /\b\d{10,13}\b/g;
const HEX64_RE = /\b[0-9a-f]{64}\b/gi;
const HEX32_RE = /\b[0-9a-f]{32}\b/gi;
const SEMVER_RE = /\b\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?\b/g;

// keys whose values carry no structural meaning
const VOLATILE_KEYS = new Set([
  "request_id", "trace_id", "span_id", "correlation_id",
  "created_at", "updated_at", "timestamp", "date",
  "session_id", "run_id", "execution_id", "job_id",
  "task_id", "tool_use_id", "conversation_id",
  "cache_key", "etag", "x-request-id",
]);

// ---- public API ----

export interface FingerprintResult {
  /** stable hash of the normalized input */
  hash: string;
  /** normalized string used to produce the hash */
  normalized: string;
}

/**
 * Produce a stable fingerprint for a tool call.
 *
 * The same tool called with the same *intent* will get the same fingerprint
 * even if UUIDs, timestamps, or generated IDs differ.
 */
export function fingerprint(toolName: string, args: Record<string, unknown>): FingerprintResult {
  const safe = normalizeDeep(args);
  const normalized = toolName + "\x00" + stableJson(safe);
  const hash = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return { hash, normalized };
}

/**
 * Lightweight similarity between two normalized-arg strings (0-1).
 * Uses a hybrid of Jaccard token overlap and normalized Levenshtein.
 */
export function similarity(a: string, b: string): number {
  if (a === b) return 1.0;

  const tokensA = new Set(tokenize(a));
  const tokensB = new Set(tokenize(b));
  const intersection = [...tokensA].filter((t) => tokensB.has(t)).length;
  const union = new Set([...tokensA, ...tokensB]).size;
  const jaccard = union === 0 ? 1 : intersection / union;

  const lev = normalizedLevenshtein(a, b);

  return 0.6 * jaccard + 0.4 * lev;
}

// ---- internal helpers ----

function normalizeDeep(value: unknown): unknown {
  if (typeof value === "string") {
    return maskNoise(value);
  }
  if (Array.isArray(value)) {
    // if the array is large, sort to eliminate order effects (for sets)
    const arr = value.map(normalizeDeep);
    if (arr.length > 20) {
      return [...arr].sort(); // treat as set
    }
    return arr;
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      if (VOLATILE_KEYS.has(key)) {
        out[key] = "<VOLATILE>";
      } else {
        out[key] = normalizeDeep(obj[key]);
      }
    }
    // limit nesting depth
    return limitDepth(out, 10);
  }
  return value;
}

function maskNoise(s: string): string {
  return s
    .replace(UUID_RE, "<UUID>")
    .replace(TIMESTAMP_ISO_RE, "<TIMESTAMP>")
    .replace(HEX64_RE, "<HASH>")
    .replace(HEX32_RE, "<HASH>")
    .replace(TIMESTAMP_UNIX_RE, "<UNIX_TS>")
    .replace(SEMVER_RE, "<SEMVER>")
    .replace(/\d+/g, (m) => (m.length >= 5 ? "<NUM>" : m)); // large numbers → generic
}

function limitDepth(obj: Record<string, unknown>, maxDepth: number, depth = 0): unknown {
  if (depth >= maxDepth) return "<DEEP>";
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      out[key] = limitDepth(v as Record<string, unknown>, maxDepth, depth + 1);
    } else {
      out[key] = v;
    }
  }
  return out;
}

/** Deterministic JSON serialization (sorted keys). */
function stableJson(obj: unknown): string {
  return JSON.stringify(obj, (_, v) => {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(v).sort()) {
        sorted[key] = (v as Record<string, unknown>)[key];
      }
      return sorted;
    }
    return v;
  });
}

function tokenize(s: string): string[] {
  return s.split(/[\x00\s,;:{}[\]"']+/).filter(Boolean);
}

function normalizedLevenshtein(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;

  let prev = new Uint16Array(b.length + 1);
  let curr = new Uint16Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }

  return 1 - prev[b.length] / maxLen;
}
