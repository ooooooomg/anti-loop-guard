#!/usr/bin/env node

/**
 * anti-loop-guard init — one-command setup for Claude Code.
 *
 * Usage (from the cloned repository, after `npm install && npm run build`):
 *   node cli/init.js              install in current project
 *   node cli/init.js --global     install globally (user-level settings)
 *   node cli/init.js --hooks      also install PreToolUse + Stop hooks
 *
 * This CLI is SEPARATE from the MCP server. The server entry it writes into
 * MCP settings is an absolute `node <repo>/dist/src/index.js` path — no npm
 * package or npx involved.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CLAUDE_DIR = path.join(os.homedir(), ".claude");
const USER_SETTINGS = path.join(CLAUDE_DIR, "settings.json");
const USER_SETTINGS_LOCAL = path.join(CLAUDE_DIR, "settings.local.json");

// Absolute server entry inside this repository (dist/src/index.js after build).
// The init CLI ships inside the repo, so this always points at a real file.
const PKG_ROOT = path.resolve(__dirname, "..", "..");
const SERVER_ENTRY = path.join(PKG_ROOT, "dist", "src", "index.js");

const MCP_CONFIG = {
  antiLoopGuard: {
    command: process.execPath,
    args: [SERVER_ENTRY],
    // NOTE: no ANTI_LOOP_SESSION_ID here — the `{{session_id}}` token is a
    // literal placeholder the host doesn't substitute. The server auto-detects
    // and falls back to a per-process id.
  },
};

const CLAUDE_MD_APPEND = `

---

## Anti-Loop Guard

> These rules are enforced by the anti-loop-guard MCP server.
> See the project README for full documentation.

### Loop Prevention

1. **Repeat detection**: If you notice yourself repeating the same tool calls 3+ times with no progress, STOP and ask the user for direction.
2. **Single-task focus**: Work on ONE task at a time. Complete and verify before moving to the next.
3. **Input dedup**: If the user's message is substantially identical to their previous message, state what you already did and ask whether they want a different approach — you may be in a loop.
4. **Interrupt recovery**: When the user says "stop" or "loop", stop ALL actions immediately. Report current status in one sentence. Wait for explicit next instruction.
5. **Retry limit**: Maximum 2 retries for any failing command. Read error output first before retrying.

### Session Health

- After ~100 tool calls, consider suggesting a fresh session
- After ~300 tool calls, strongly recommend splitting remaining work
- The anti-loop-guard MCP server warns automatically via Resources
`;

/**
 * Find a usable Python 3 interpreter. On Windows, `py -3` launcher is
 * preferred (it resolves the modern Python without relying on PATH aliases);
 * otherwise `python3` then `python`.
 */
function detectPython(): string | null {
  const candidates: string[][] =
    process.platform === "win32"
      ? [["py", "-3"], ["python"], ["python3"]]
      : [["python3"], ["python"]];
  for (const c of candidates) {
    try {
      execFileSync(c[0], [...c.slice(1), "--version"], {
        stdio: "ignore",
        timeout: 5000,
      });
      return c.join(" ");
    } catch {
      // try the next candidate
    }
  }
  return null;
}

// ---- main ----

async function main() {
  const args = process.argv.slice(2);
  const useGlobal = args.includes("--global") || args.includes("-g");
  const installHooks = args.includes("--hooks");

  console.log(`
╔══════════════════════════════════════╗
║   Anti-Loop Guard — Setup           ║
║   Passive loop detection for AI     ║
╚══════════════════════════════════════╝
`);

  // 1. Add MCP server to Claude Code settings
  const settingsPath = useGlobal ? USER_SETTINGS : USER_SETTINGS_LOCAL;
  console.log(`[1/4] Configuring MCP server in ${settingsPath}...`);

  if (!fs.existsSync(SERVER_ENTRY)) {
    console.error(
      `  ❌ Server entry not found: ${SERVER_ENTRY}\n` +
      "     Run `npm install && npm run build` in the repository first.",
    );
    process.exit(1);
  }

  let settings: any = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    } catch {
      // 解析失败绝不覆盖用户配置:留备份并中止(此前会以空对象覆写整个文件)
      const backup = settingsPath + ".bak";
      try {
        fs.copyFileSync(settingsPath, backup);
      } catch {
        /* 备份失败也要中止,不覆盖 */
      }
      console.error(
        `  ❌ Could not parse ${settingsPath} — NOT overwriting it.\n` +
        `     A backup was saved to ${backup}. Fix the JSON manually and re-run.`,
      );
      process.exit(1);
    }
  }

  if (!settings.mcpServers) {
    settings.mcpServers = {};
  }

  if (settings.mcpServers["anti-loop-guard"]) {
    console.log("  ℹ️  anti-loop-guard MCP server already configured. Skipping.");
  } else {
    settings.mcpServers["anti-loop-guard"] = MCP_CONFIG.antiLoopGuard;
    console.log("  ✅ MCP server configuration added.");
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  console.log(`  ✅ Settings saved.`);

  // 2. Append anti-loop rules to CLAUDE.md (--global 时写入用户级 ~/.claude/CLAUDE.md)
  console.log("[2/4] Updating CLAUDE.md...");
  const claudeMdPath = useGlobal
    ? path.join(CLAUDE_DIR, "CLAUDE.md")
    : path.join(process.cwd(), "CLAUDE.md");

  if (fs.existsSync(claudeMdPath)) {
    const existing = fs.readFileSync(claudeMdPath, "utf-8");
    if (existing.includes("Anti-Loop Guard")) {
      console.log("  ℹ️  Anti-loop rules already in CLAUDE.md. Skipping.");
    } else {
      const content = existing.endsWith("\n")
        ? existing + CLAUDE_MD_APPEND
        : existing + "\n" + CLAUDE_MD_APPEND;
      fs.writeFileSync(claudeMdPath, content, "utf-8");
      console.log("  ✅ Anti-loop rules appended to CLAUDE.md.");
    }
  } else {
    fs.writeFileSync(claudeMdPath, `# Project Configuration\n${CLAUDE_MD_APPEND}`, "utf-8");
    console.log("  ✅ CLAUDE.md created with anti-loop rules.");
  }

  // 3. Install hooks (optional)
  if (installHooks) {
    console.log("[3/4] Installing hooks...");

    const py = detectPython();
    if (!py) {
      // hooks 被显式要求却装不了:必须失败(此前只打印警告,最后仍输出 "is ready!")
      console.error(
        "  ❌ Could not find a Python 3 interpreter (tried `py -3`, `python`, `python3`). " +
        "Hooks require Python 3. Install Python and re-run with --hooks.",
      );
      process.exit(1);
    } else {
      console.log(`  ✅ Using Python interpreter: ${py}`);

      const hooksDir = path.join(CLAUDE_DIR, "hooks");
      if (!fs.existsSync(hooksDir)) {
        fs.mkdirSync(hooksDir, { recursive: true });
      }

      // Find hooks directory relative to this script (works on all platforms)
      // dist/cli/init.js → ../../hooks/
      const pkgRoot = path.resolve(__dirname, "..", "..");
      const pkgHooksDir = path.join(pkgRoot, "hooks");

      const preToolUseSrc = path.join(pkgHooksDir, "pre-tool-use.py");
      const stopGuardSrc = path.join(pkgHooksDir, "stop-guard.py");

      if (fs.existsSync(preToolUseSrc)) {
        const dest = path.join(hooksDir, "anti-loop-pre-tool-use.py");
        fs.copyFileSync(preToolUseSrc, dest);
        console.log(`  ✅ PreToolUse hook installed.`);
      } else {
        console.log(`  ⚠️  PreToolUse hook not found at ${preToolUseSrc}`);
      }

      if (fs.existsSync(stopGuardSrc)) {
        const dest = path.join(hooksDir, "anti-loop-stop-guard.py");
        fs.copyFileSync(stopGuardSrc, dest);
        console.log(`  ✅ Stop hook installed.`);
      } else {
        console.log(`  ⚠️  Stop hook not found at ${stopGuardSrc}`);
      }

      // Add hook config to settings
      if (!settings.hooks) settings.hooks = {};

      const hooksChanged = addHookConfigs(settings, hooksDir, py);

      // With hooks installed, the PreToolUse hook records every call passively,
      // so the MCP server should stop double-recording on log_tool_call.
      let mcpChanged = false;
      const mcpEntry = settings.mcpServers?.["anti-loop-guard"];
      if (mcpEntry) {
        if (!mcpEntry.env) mcpEntry.env = {};
        if (mcpEntry.env.ANTI_LOOP_HOOKS_ENABLED !== "true") {
          mcpEntry.env.ANTI_LOOP_HOOKS_ENABLED = "true";
          mcpChanged = true;
        }
      }

      if (hooksChanged || mcpChanged) {
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
        console.log("  ✅ Hook configurations added to settings.");
      }
    }
  } else {
    console.log("[3/4] Hooks not requested. Run with --hooks to install passive hook protection.");
  }

  // 4. Verify state directory
  console.log("[4/4] Creating state directory...");
  const stateDir = path.join(os.homedir(), ".anti-loop-guard");
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }
  console.log(`  ✅ State directory ready.`);

  console.log(`
┌──────────────────────────────────────┐
│  Anti-Loop Guard is ready!           │
│                                      │
│  Restart Claude Code to activate.    │
│                                      │
│  For hook protection, re-run with:   │
│    node cli/init.js --hooks          │
└──────────────────────────────────────┘
`);
}

function addHookConfigs(settings: any, hooksDir: string, py: string): boolean {
  let changed = false;

  const preToolUsePath = path.join(hooksDir, "anti-loop-pre-tool-use.py");
  const stopGuardPath = path.join(hooksDir, "anti-loop-stop-guard.py");

  if (!settings.hooks?.PreToolUse?.some((h: any) => h.command?.includes("anti-loop"))) {
    if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];

    settings.hooks.PreToolUse.push({
      matcher: "*",
      command: `${py} "${preToolUsePath}"`,
    });
    changed = true;
  }

  if (!settings.hooks?.Stop?.some((h: any) => h.command?.includes("anti-loop"))) {
    if (!settings.hooks.Stop) settings.hooks.Stop = [];

    settings.hooks.Stop.push({
      command: `${py} "${stopGuardPath}"`,
    });
    changed = true;
  }

  return changed;
}

main().catch((err) => {
  console.error("Installation failed:", err.message);
  process.exit(1);
});
