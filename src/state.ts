/**
 * State persistence — sliding window of tool-call records stored as JSON on disk.
 *
 * Two writers feed this state:
 *   - The MCP server records calls when the agent invokes log_tool_call.
 *   - The PreToolUse hook (~/.anti-loop-guard/hook_records.json) records every
 *     tool call passively. syncFromHookFile() merges those records in so that
 *     loop detection sees the full stream even if the agent never calls the tool.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { WINDOW_SIZE, DEFAULT_STATE_DIR } from "./config.js";

export interface ToolCallRecord {
  toolName: string;
  fingerprint: string;
  normalized: string;
  timestamp: number;
  /** Populated when the caller supplies a tool_use_id; enables exact dedup. */
  toolUseId?: string;
}

export interface SessionState {
  records: ToolCallRecord[];
  totalCalls: number;
  blockedCount: number;
  sessionId: string;
}

interface HookStateFile {
  sessionId?: string;
  records?: Array<{
    toolName?: string;
    fingerprint?: string;
    normalized?: string;
    timestamp?: number;
    toolUseId?: string;
  }>;
  totalCalls?: number;
  blockedCount?: number;
}

// in-memory state (the authoritative source while the MCP server is alive)
let state: SessionState = {
  records: [],
  totalCalls: 0,
  blockedCount: 0,
  sessionId: "unknown",
};

// last hook file signature seen — avoids re-merging unchanged data
let lastHookSync: { mtimeMs: number; size: number } | null = null;

function stateDir(): string {
  return DEFAULT_STATE_DIR || path.join(os.homedir(), ".anti-loop-guard");
}

function stateFilePath(): string {
  return path.join(stateDir(), "session_state.json");
}

function hookFilePath(): string {
  return path.join(stateDir(), "hook_records.json");
}

function outputCacheFilePath(): string {
  return path.join(stateDir(), "output_cache.json");
}

// ---- public API ----

export function init(sessionId: string): void {
  ensureDir();
  const loaded = loadFromDisk();
  // Only reuse disk state if it's from the same session.
  // Otherwise start fresh — prevents leaking sensitive info across projects.
  if (loaded && loaded.sessionId === sessionId) {
    state = loaded;
  } else {
    state = {
      records: [],
      totalCalls: 0,
      blockedCount: 0,
      sessionId,
    };
  }
  syncFromHookFile();
}

export function record(toolCall: ToolCallRecord): void {
  state.records.push(toolCall);
  state.totalCalls++;
  if (state.records.length > WINDOW_SIZE) {
    state.records = state.records.slice(-WINDOW_SIZE);
  }
  // persist every 10 calls as a recovery checkpoint
  if (state.totalCalls % 10 === 0) {
    flushToDisk();
  }
}

export function recordIfNew(toolCall: ToolCallRecord): boolean {
  if (toolCall.toolUseId) {
    const seen = state.records.some((m) => m.toolUseId === toolCall.toolUseId);
    if (seen) return false;
  }
  record(toolCall);
  return true;
}

export function recentRecords(n: number = WINDOW_SIZE): ToolCallRecord[] {
  return state.records.slice(-n);
}

export function getTotalCalls(): number {
  return state.totalCalls;
}

export function getBlockedCount(): number {
  return state.blockedCount;
}

export function getSessionId(): string {
  return state.sessionId;
}

export function reset(): void {
  state = {
    records: [],
    totalCalls: 0,
    blockedCount: 0,
    sessionId: state.sessionId,
  };
  flushToDisk();
  clearHookFiles();
  lastHookSync = null;
}

export function getState(): SessionState {
  return { ...state };
}

/**
 * Merge the PreToolUse hook's records (~/.anti-loop-guard/hook_records.json)
 * into in-memory state. Records are deduped: a hook record is skipped when a
 * memory record matches on (toolName, fingerprint) with a timestamp within 3s.
 * Counters are the max of both sources so double-writes don't inflate totals.
 */
export function syncFromHookFile(): void {
  const file = hookFilePath();
  let stats: fs.Stats | null = null;
  try {
    stats = fs.statSync(file);
  } catch {
    return; // no hook file yet
  }
  if (
    lastHookSync &&
    lastHookSync.mtimeMs === stats.mtimeMs &&
    lastHookSync.size === stats.size
  ) {
    return; // unchanged since last merge
  }

  let hook: HookStateFile | null = null;
  try {
    hook = JSON.parse(fs.readFileSync(file, "utf-8")) as HookStateFile;
  } catch {
    return; // corrupt or unreadable — ignore, don't wipe state
  }
  if (!hook || !Array.isArray(hook.records)) return;

  // Snapshot pre-existing records and dedup only against those — hook records
  // arriving in quick succession must not dedup against each other.
  const existing = state.records.slice();

  const isDup = (rec: ToolCallRecord): boolean => {
    if (rec.toolUseId) {
      return existing.some((m) => m.toolUseId && m.toolUseId === rec.toolUseId);
    }
    // fallback when no id is present: same tool+fingerprint within 3s
    return existing.some(
      (m) =>
        m.toolName === rec.toolName &&
        m.fingerprint === rec.fingerprint &&
        Math.abs(m.timestamp - rec.timestamp) < 3000
    );
  };

  for (const h of hook.records) {
    if (typeof h.toolName !== "string" || typeof h.fingerprint !== "string") continue;
    const rec: ToolCallRecord = {
      toolName: h.toolName,
      fingerprint: h.fingerprint,
      normalized: typeof h.normalized === "string" ? h.normalized : "",
      timestamp: typeof h.timestamp === "number" ? h.timestamp : 0,
      toolUseId: typeof h.toolUseId === "string" && h.toolUseId ? h.toolUseId : undefined,
    };
    if (!isDup(rec)) {
      state.records.push(rec);
    }
  }

  if (state.records.length > WINDOW_SIZE) {
    state.records = state.records.slice(-WINDOW_SIZE);
  }
  state.totalCalls = Math.max(state.totalCalls, typeof hook.totalCalls === "number" ? hook.totalCalls : 0);
  state.blockedCount = Math.max(state.blockedCount, typeof hook.blockedCount === "number" ? hook.blockedCount : 0);

  lastHookSync = { mtimeMs: stats.mtimeMs, size: stats.size };
}

// ---- disk persistence (best-effort recovery) ----

function ensureDir(): void {
  const dir = path.dirname(stateFilePath());
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadFromDisk(): SessionState | null {
  try {
    if (fs.existsSync(stateFilePath())) {
      const raw = fs.readFileSync(stateFilePath(), "utf-8");
      return JSON.parse(raw) as SessionState;
    }
  } catch {
    // corrupt or missing — start fresh
  }
  return null;
}

function flushToDisk(): void {
  try {
    ensureDir();
    fs.writeFileSync(stateFilePath(), JSON.stringify(state, null, 2), "utf-8");
  } catch {
    // best-effort; don't crash the server on disk errors
  }
}

function clearHookFiles(): void {
  // reset_session must also clear the hook's state, or stale records would
  // cause spurious loop warnings after a reset.
  for (const file of [hookFilePath(), outputCacheFilePath()]) {
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      // best-effort
    }
  }
}
