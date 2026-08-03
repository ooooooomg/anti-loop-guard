# Anti-Loop Guard（反循环守卫）

> 被动式 AI 编程代理循环检测 MCP 服务器。检测工具调用重复、语义相似度循环、模式周期和上下文预算耗尽 — **无需代理主动调用。**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## 为什么需要 Anti-Loop Guard？

现有所有 Claude Code 反循环工具有一个共同的致命缺陷：**它们需要代理主动调用**。一个陷入循环的代理不会去调用反循环工具——它只会继续循环。

**Anti-Loop Guard** 使用两种互补机制：

1. **MCP 服务器 + 工具** — `check_repetition`、`session_health` 以及 `anti-loop://status` / `anti-loop://history` 资源提供按需的循环状态。服务器还会**合并 hook 的记录**，因此它的视图包含所有被动记录的调用。
2. **可选的 Hooks** — `PreToolUse` 和 `Stop` hooks 在系统层面被动拦截和阻止循环行为，完全不需要代理配合。启用 `--hooks` 后每次工具调用都会被被动记录，代理无需再调用 `log_tool_call`。

## 快速开始

```bash
npx anti-loop-guard-init
```

这一个命令会：
- 将 MCP 服务器添加到你的 Claude Code 设置中
- 将反循环规则追加到项目的 `CLAUDE.md`
- 创建状态目录 `~/.anti-loop-guard/`

重启 Claude Code，保护即刻生效。

> **首次运行：** `npx` 会在第一次使用时下载包，所以首次运行可能需要几秒钟。

> **注意：** 默认安装只添加 MCP 服务器和 CLAUDE.md 规则。要获得真正的**被动**保护——工具调用被自动记录、循环在代理不调用任何工具时就被阻止——需要 `--hooks`。

### 安装 Hook 保护（推荐）

```bash
npx anti-loop-guard-init --hooks
```

hooks 是 Python 3 脚本。安装器会自动探测可用的解释器（Windows 上优先 `py -3`，然后 `python` / `python3`），并把正确的命令写入你的设置——无需手动配置 PATH。

额外安装被动 hooks，自动：
- 将每次工具调用记录到守卫的状态文件（合并进服务器的视图，`session_health` / `check_repetition` / 资源都能看到完整记录流）
- 阻止连续 8 次以上相同参数的工具调用
- 在连续 5 次相同调用时注入警告
- 检测模型输出中的退化 token 重复

## 工作原理

### 三层检测引擎

服务器的检测按需运行（通过 `log_tool_call`、`check_repetition` 或读取资源时）。启用 `--hooks` 后，PreToolUse hook 还会用固定阈值做实时连续重复检查。

| 层级 | 检测内容 | 置信度 | 响应 |
|------|---------|--------|------|
| **精确重复** | 相同 (工具, 归一化参数) ≥ 警告阈值 | 高 | 警告；建议停止 |
| **语义相似** | 不同调用但参数相似度 > 80% | 中 | 警告 |
| **模式周期** | 重复的 A→B→C→A→B→C 序列 | 高 | 强制中断（建议） |

### 自适应阈值

阈值随会话长度收紧——因为 LLM 退化是上下文长度的已知函数：

| 会话阶段 | 阈值乘数 | 精确重复 警告/阻止 |
|---------|---------|-------------------|
| < 50 次调用 | ×1.5（宽松） | 8 次警告，12 次阻止 |
| 50–200 次调用 | ×1.0（标准） | 5 次警告，8 次阻止 |
| 200+ 次调用 | ×0.7（严格） | 4 次警告，6 次阻止 |

> **关于「阻止」的说明：** 服务器的「阻止」是高置信度**建议**——它无法真正阻止工具调用。唯一真正拒绝的是 PreToolUse hook（`--hooks` 安装），它使用**固定**阈值（5 次警告 / 8 次阻止）且只做连续重复检查，不是服务器的三层检测。

### 上下文预算追踪

基于已发表的 LLM 注意力衰减研究（"Lost in the Middle", TACL 2024; QSAF, arXiv 2507.15330; Claude Code bug #80873）：

| 工具调用数 | 风险 | 建议 |
|----------|------|------|
| < 100 | 正常 | — |
| 100–300 | 注意 | 建议拆分任务 |
| 300–500 | 危险 | 强烈建议新开会话 |
| 500+ | 危急 | 退化几乎必然发生 |

### 语义指纹

参数在比较前经过归一化——UUID、时间戳、十六进制哈希、会话 ID 和易变字段全部被屏蔽，使语义相同的调用即使在原始参数不同时也能匹配：

```
# 以下两者产生相同的指纹：
Read({ file_path: "/tmp/550e8400-e29b-41d4-a716-446655440000/output.json" })
Read({ file_path: "/tmp/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/output.json" })
# 两者归一化为：Read → file_path: /tmp/<UUID>/output.json
```

## MCP 工具

| 工具 | 描述 |
|------|------|
| `log_tool_call` | 记录一次工具调用并获取循环状态。安装 hooks 后此调用为空操作（hook 已被动记录）——调用它来检查状态。未安装 hooks 时，每次工具调用后调用。 |
| `check_repetition` | 显式检查当前是否在循环。返回模式、置信度、建议。 |
| `session_health` | 完整健康报告：预算、重复率、退化指标。 |
| `reset_session` | 重置所有追踪状态（服务器状态、hook 记录、Stop-hook 输出缓存）。在清空上下文后或开始新工作时使用。 |

## MCP Resources

> `anti-loop://status` 和 `anti-loop://history` 资源是**请求时读取的快照**——它们不会每轮自动注入上下文。要获得实时的被动强制，请安装 hooks（`--hooks`）；服务器的检测在工具被调用或资源被读取时按需运行。

| Resource | 描述 |
|----------|------|
| `anti-loop://status` | 当前循环检测状态：`isStuck`、`riskLevel`、`degradationIndicators`。 |
| `anti-loop://history` | 最近 10 次工具调用指纹。 |

> **注意：** hook 记录存放在单个全局文件（`~/.anti-loop-guard/hook_records.json`）中，按会话 ID 区分。存在多个并发会话时，其计数器只能视为近似值。

## 对比

| 特性 | unloop-mcp | agent-guard | claude-focus | **anti-loop-guard** |
|------|-----------|-------------|-------------|-------------------|
| 被动监控（无需代理调用） | ❌ | ❌ | ✅ (hooks) | ✅ (Resources + hooks) |
| 一键安装 | ✅ | ✅ | ❌ | ✅ |
| 语义指纹（非精确匹配） | ✅ | ❌ | ❌ | ✅ |
| 上下文预算追踪 | ❌ | ❌ | ❌ | ✅ |
| 自适应阈值 | ❌ | ✅ | ❌ | ✅ |
| 模式周期检测 | ❌ | ✅ | ❌ | ✅ |
| 退化 token 检测 | ❌ | ❌ | ❌ | ✅ |
| 学术文献支撑 | ❌ | ❌ | ❌ | ✅ |

## 安装

### 手动配置

在 `.claude/settings.json` 或 `.claude/settings.local.json` 中添加：

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

> **关于 `ANTI_LOOP_SESSION_ID` 的说明：** 旧版 README 中的 `{{session_id}}` 是字面占位符——Claude Code 的 MCP 配置不会替换它。服务器现在会自动检测这种情况并回退为按进程生成的 ID，所以你可以完全省略该环境变量。

### 全局安装

```bash
npm install -g anti-loop-guard
```

然后将配置中的 `"command": "npx"` 替换为 `"command": "anti-loop-guard"`。

## 研究背景

本工具基于同行评审的 LLM 长上下文退化研究：

- **Liu et al., "Lost in the Middle," TACL 2024** — U 形注意力曲线；中间段落信息被系统性忽视
- **Pipis et al., "Wait, Wait, Wait... Why Do Reasoning Models Loop?" ICML 2026** — Token 级自强化导致循环陷入
- **"Frayed RoPE," arXiv 2603.18017** — 极端序列长度下的位置编码坍缩
- **"Contextual Inertia," ACL 2026 Findings** — 会话越长，代理越倾向于重复已有模式
- **QSAF (arXiv 2507.15330)** — 代理 AI 的认知退化框架
- **Claude Code bug #80873** — CLAUDE.md 规则在 5-10 轮后"衰减"

## 许可证

MIT — 详见 [LICENSE](./LICENSE)

## 贡献

欢迎提 Issue 和 PR。提交前请：

1. 运行 `npm test` 确认所有测试通过
2. 运行 `npm run build` 确认 TypeScript 编译通过
3. 为新的检测模式添加测试

## 局限性

- **基于启发式**：循环检测依赖模式启发式（重复次数、相似度阈值），在合法的重复性工作流上可能误报，也可能漏掉新型循环形态。
- **面向 CLI**：当前主要钩住 shell 工具调用模式，对其他代理通道（MCP、子代理）的覆盖有限。
- **不含 ML 模型**：为透明性和低开销刻意采用规则方法，不具备自适应学习能力。

## 联系

本项目仍在改进中。如有建议、bug 报告或合作意向，欢迎联系作者：

**AshMe** — <AshMe37@outlook.com>

