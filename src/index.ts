#!/usr/bin/env node

/**
 * Anti-Loop Guard MCP Server
 *
 * Passive loop detection for AI coding agents. Provides:
 * - 4 Tools: log_tool_call, check_repetition, session_health, reset_session
 * - 2 Resources: anti-loop://status, anti-loop://history
 *
 * Live passive enforcement comes from the PreToolUse/Stop hooks
 * (installed with --hooks). The MCP server merges the hook's records via
 * syncFromHookFile() and gives on-demand status; the Resources are
 * snapshots read at connection time, not per-turn injections.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { detectLoop, logAndDetect } from "./detector.js";
import { init, reset, getState, syncFromHookFile } from "./state.js";
import { assessBudget } from "./budget.js";

const SESSION_ID_RAW = process.env.ANTI_LOOP_SESSION_ID || "";
// The `{{session_id}}` in the README/manual config is a literal placeholder the
// MCP host does NOT substitute. Fall back to a per-process id so state files
// don't collide and dedup stays correct.
const SESSION_ID =
  !SESSION_ID_RAW || SESSION_ID_RAW.trim() === "" || SESSION_ID_RAW.includes("{{")
    ? `session_${process.pid}_${Date.now()}`
    : SESSION_ID_RAW;
init(SESSION_ID);

// When the PreToolUse hook is installed it records every call passively,
// so log_tool_call becomes a manual status check instead of a second write.
const HOOKS_ENABLED = process.env.ANTI_LOOP_HOOKS_ENABLED === "true";

const server = new Server(
  {
    name: "anti-loop-guard",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

// ---- Tools ----

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "log_tool_call",
      description:
        "Record a tool call for loop detection, or check loop status. " +
        (HOOKS_ENABLED
          ? "The PreToolUse hook records every call passively — this call only checks status."
          : "Call this after every tool invocation. Returns the current loop detection status."),
      inputSchema: {
        type: "object",
        properties: {
          tool_name: {
            type: "string",
            description: "Name of the tool that was called (e.g. 'Bash', 'Read', 'Edit')",
          },
          args: {
            type: "object",
            description: "The arguments passed to the tool (will be normalized for fingerprinting)",
          },
          tool_use_id: {
            type: "string",
            description: "Optional: the tool use id of the call, if available. Used to dedup against hook-recorded calls.",
          },
        },
        required: ["tool_name", "args"],
      },
    },
    {
      name: "check_repetition",
      description:
        "Explicitly check whether the agent is currently in a loop. Returns detection result " +
        "with pattern type, confidence, and a recommendation.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "session_health",
      description:
        "Get a full session health report: tool call count, context budget risk level, " +
        "repetition rate, and degradation indicators based on published LLM research.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "reset_session",
      description:
        "Reset all tracking state. Use when starting a fresh task or after clearing context.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "log_tool_call": {
      if (HOOKS_ENABLED) {
        // The hook already recorded this call; dedup would skip it anyway.
        // Return the current loop status so the call doubles as a manual check.
        syncFromHookFile();
        const detection = detectLoop();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  recorded: false,
                  note: "PreToolUse hook records calls passively; nothing recorded here.",
                  totalCalls: getState().totalCalls,
                  detection: {
                    isStuck: detection.isStuck,
                    confidence: detection.confidence,
                    pattern: detection.pattern,
                  },
                  warning:
                    detection.isStuck && detection.confidence >= 0.6
                      ? `⚠️  ${detection.recommendation}`
                      : undefined,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // No hook installed — record manually, then detect.
      const { record: rec, detection } = logAndDetect(
        (args as any).tool_name,
        (args as any).args || {},
        typeof (args as any).tool_use_id === "string" ? (args as any).tool_use_id : undefined
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                recorded: true,
                fingerprint: rec.fingerprint,
                totalCalls: getState().totalCalls,
                detection: {
                  isStuck: detection.isStuck,
                  confidence: detection.confidence,
                  pattern: detection.pattern,
                },
                warning:
                  detection.isStuck && detection.confidence >= 0.6
                    ? `⚠️  ${detection.recommendation}`
                    : undefined,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    case "check_repetition": {
      const detection = detectLoop();
      const budget = assessBudget();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                loopDetection: detection,
                contextBudget: {
                  riskLevel: budget.riskLevel,
                  recommendation: budget.recommendation,
                },
                state: {
                  totalCalls: getState().totalCalls,
                  blockedCalls: getState().blockedCount,
                },
              },
              null,
              2
            ),
          },
        ],
      };
    }

    case "session_health": {
      const budget = assessBudget();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(budget, null, 2),
          },
        ],
      };
    }

    case "reset_session": {
      reset();
      return {
        content: [
          {
            type: "text",
            text: "Session state has been reset. All tracking counters are back to zero.",
          },
        ],
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// ---- Resources (passive monitoring) ----

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: "anti-loop://status",
      name: "Anti-Loop Guard Status",
      description:
        "Current loop detection status (snapshot at read time). On-demand — the hooks, not this resource, provide live passive enforcement.",
      mimeType: "application/json",
    },
    {
      uri: "anti-loop://history",
      name: "Anti-Loop Guard Recent History",
      description:
        "Last 10 tool call fingerprints (snapshot at read time).",
      mimeType: "application/json",
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri as string;

  switch (uri) {
    case "anti-loop://status": {
      const detection = detectLoop();
      const budget = assessBudget();

      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(
              {
                _heading: "ANTI-LOOP GUARD STATUS",
                _instruction:
                  "If isStuck=true or riskLevel=danger/critical, STOP and report to user. " +
                  "Do NOT continue with the same approach.",
                loopDetection: {
                  isStuck: detection.isStuck,
                  confidence: detection.confidence,
                  pattern: detection.pattern,
                  details: detection.details,
                },
                contextBudget: {
                  riskLevel: budget.riskLevel,
                  totalCalls: budget.totalToolCalls,
                  recommendation: budget.recommendation,
                },
                degradationIndicators: budget.degradationIndicators,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    case "anti-loop://history": {
      syncFromHookFile();
      const st = getState();
      const recent = st.records.slice(-10);

      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(
              {
                totalCalls: st.totalCalls,
                recentCalls: recent.map((r) => ({
                  tool: r.toolName,
                  fingerprint: r.fingerprint,
                  timestamp: new Date(r.timestamp).toISOString(),
                })),
              },
              null,
              2
            ),
          },
        ],
      };
    }

    default:
      throw new Error(`Unknown resource: ${uri}`);
  }
});

// ---- Startup ----

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[anti-loop-guard] Started. Session: ${SESSION_ID}`);
}

main().catch((err) => {
  console.error("[anti-loop-guard] Fatal error:", err);
  process.exit(1);
});
