# Anti-Loop Guard

> Passive loop detection MCP server for AI coding agents. Detects tool-call repetition, semantic similarity loops, pattern cycles, and context budget exhaustion — **no agent initiative required.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Why Anti-Loop Guard?

All existing anti-loop tools for Claude Code share the same fatal flaw: **they require the agent to call them**. An agent stuck in a loop doesn't call anti-loop tools — it just keeps looping.

**Anti-Loop Guard** uses two complementary mechanisms:

1. **MCP server + tools** — `check_repetition`, `session_health`, and the `anti-loop://status` / `anti-loop://history` resources give on-demand loop status. The server also **merges the hook's records** so its view includes every passively-recorded call.
2. **Optional Hooks** — `PreToolUse` and `Stop` hooks passively intercept and block looping behavior at the system level, with zero agent cooperation needed. With `--hooks`, every tool call is recorded passively, so the agent does not need to call `log_tool_call` at all.

## Quick Start

```bash
npx anti-loop-guard-init
```

This one command:
- Adds the MCP server to your Claude Code settings
- Appends anti-loop rules to your project's `CLAUDE.md`
- Creates the state directory `~/.anti-loop-guard/`

Restart Claude Code, and you're protected.

> **First run:** `npx` downloads the package on first use, so the very first run may take a few seconds.

> **Note:** The default install adds the MCP server and CLAUDE.md rules. For true **passive** protection — where tool calls are recorded automatically and loops are blocked without the agent calling any tool — you need `--hooks`.

### With Hook Protection (Recommended)

```bash
npx anti-loop-guard-init --hooks
```

The hooks are Python 3 scripts. The installer auto-detects an interpreter (`py -3` on Windows, then `python` / `python3`) and writes the correct command into your settings — no manual PATH setup needed.

Also installs passive hooks that automatically:
- Record every tool call to the guard's state file (merged into the server's view, so `session_health` / `check_repetition` / resources see the full stream)
- Block tool calls that repeat 8+ times with identical arguments
- Inject warnings when 5+ identical calls are detected
- Detect degenerate token repetition in model output

## How It Works

### Three-Layer Detection

The server's detection runs on-demand (via `log_tool_call`, `check_repetition`, or when a resource is read). With `--hooks`, the PreToolUse hook also does a real-time consecutive-repeat check with fixed thresholds.

| Layer | What it detects | Confidence | Response |
|-------|----------------|------------|----------|
| **Exact Repeat** | Same (tool, normalized_args) ≥ warn threshold | High | Warn; recommendation to stop |
| **Semantic Similarity** | Different calls with > 80% arg similarity | Medium | Warn |
| **Pattern Cycle** | Repeating A→B→C→A→B→C sequences | High | Force interrupt (recommendation) |

### Adaptive Thresholds

Thresholds tighten as the session lengthens — because LLM degradation is a known function of context length:

| Session phase | Threshold multiplier | Exact-repeat warn / block |
|--------------|---------------------|---------------------------|
| < 50 calls | ×1.5 (relaxed) | warn at 8, block at 12 |
| 50–200 calls | ×1.0 (standard) | warn at 5, block at 8 |
| 200+ calls | ×0.7 (strict) | warn at 4, block at 6 |

> **Note on "block":** the server's "block" is a high-confidence **recommendation** — it cannot stop a tool call. The only real deny comes from the PreToolUse hook (installed with `--hooks`), which uses **fixed** thresholds (warn 5 / block 8) and a consecutive-repeat check only, not the server's three layers.

### Context Budget Tracking

Based on published research on LLM attention decay ("Lost in the Middle", TACL 2024; QSAF, arXiv 2507.15330; Claude Code bug #80873):

| Tool calls | Risk | Recommendation |
|------------|------|----------------|
| < 100 | Normal | — |
| 100–300 | Warning | Consider splitting tasks |
| 300–500 | Danger | Strongly suggest fresh session |
| 500+ | Critical | Degradation practically guaranteed |

### Semantic Fingerprinting

Arguments are normalized before comparison — UUIDs, timestamps, hex hashes, session IDs, and volatile keys are all masked so that semantically identical calls match even when raw arguments differ:

```
# These produce the SAME fingerprint:
Read({ file_path: "/tmp/550e8400-e29b-41d4-a716-446655440000/output.json" })
Read({ file_path: "/tmp/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/output.json" })
# Both normalize to: Read → file_path: /tmp/<UUID>/output.json
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `log_tool_call` | Record a tool call and get loop status. With hooks installed this is a no-op (the hook records passively) — call it to check status. Without hooks, call after each tool invocation. |
| `check_repetition` | Explicitly check if currently looping. Returns pattern, confidence, advice. |
| `session_health` | Full health report: budget, repetition rate, degradation indicators. |
| `reset_session` | Reset all tracking (server state, hook records, and the Stop-hook output cache). Use after clearing context or when starting fresh work. |

## MCP Resources

> The `anti-loop://status` and `anti-loop://history` resources are **snapshots** read at request time — they are not injected into context every turn. For live passive enforcement, install the hooks (`--hooks`); the server's detection runs on-demand when a tool is called or a resource is read.

| Resource | Description |
|----------|-------------|
| `anti-loop://status` | Current loop detection status: `isStuck`, `riskLevel`, `degradationIndicators`. |
| `anti-loop://history` | Last 10 tool call fingerprints. |

> **Note:** hook records live in a single global file (`~/.anti-loop-guard/hook_records.json`) scoped by session id. With multiple concurrent sessions, treat its counters as approximate.

## Comparison

| Feature | unloop-mcp | agent-guard | claude-focus | **anti-loop-guard** |
|---------|-----------|-------------|-------------|-------------------|
| Passive (no agent call needed) | No | No | Yes (hooks) | Yes (Resources + hooks) |
| One-command install | Yes | Yes | No | Yes |
| Semantic fingerprints | Yes | No | No | Yes |
| Context budget tracking | No | No | No | Yes |
| Adaptive thresholds | No | Yes | No | Yes |
| Pattern cycle detection | No | Yes | No | Yes |
| Degenerate token detection | No | No | No | Yes |
| Academic literature grounding | No | No | No | Yes |

## Installation

### Manual

Add to `.claude/settings.json` or `.claude/settings.local.json`:

```json
{
  "mcpServers": {
    "anti-loop-guard": {
      "command": "npx",
      "args": ["anti-loop-guard"]
    }
  }
}
```

> **Note on `ANTI_LOOP_SESSION_ID`:** the `{{session_id}}` token in older versions of this README was a literal placeholder — Claude Code's MCP config does not substitute it. The server now detects that case and falls back to a per-process id automatically, so you can omit the env var entirely.

### Global install

```bash
npm install -g anti-loop-guard
```

Then configure with `"command": "anti-loop-guard"` instead of `"command": "npx"`.

## Research Background

This tool is grounded in peer-reviewed research on LLM degradation in long contexts:

- **Liu et al., "Lost in the Middle," TACL 2024** — U-shaped attention curve; mid-context information is systematically ignored
- **Pipis et al., "Wait, Wait, Wait... Why Do Reasoning Models Loop?" ICML 2026** — Token-level self-reinforcement causes loop entrapment
- **"Frayed RoPE," arXiv 2603.18017** — Positional encoding collapse at extreme sequence lengths
- **"Contextual Inertia," ACL 2026 Findings** — Agents increasingly reproduce prior patterns as sessions lengthen
- **QSAF (arXiv 2507.15330)** — Cognitive degradation framework for agentic AI
- **Claude Code bug #80873** — CLAUDE.md rules "fade" after 5-10 turns

## License

MIT — see [LICENSE](./LICENSE) for details.

## Contributing

Issues and PRs welcome. Before submitting, please:

1. Run `npm test` to verify all tests pass
2. Run `npm run build` to verify TypeScript compilation
3. Add tests for new detection patterns

## Limitations

- **Heuristic-based**: loop detection relies on pattern heuristics (repetition counts, similarity thresholds). It may produce false positives on legitimate repetitive workflows, or miss novel loop shapes.
- **CLI-centric**: currently hooks into shell tool-call patterns; coverage of other agent channels (MCP, sub-agents) is limited.
- **No ML models**: intentionally rule-based for transparency and low overhead, so it does not learn adaptively.

## Contact

This project is under active improvement. For suggestions, bug reports, or collaboration, contact the author:

**AshMe** — <AshMe37@outlook.com>

