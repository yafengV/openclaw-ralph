---
name: run-ralph
description: "在指定项目路径中按 Ralph 的 prd.json 自动循环迭代：每次先在当前会话报告下一条 user story，然后启动 subagent 运行 1 次 Ralph 迭代；subagent 完成后回报结果与总体进度；若还有未完成 story 则继续，直到全部完成后输出项目总结。适用于：持续跑 ralph、分轮汇报进度、需要把执行放到后台子会话。"
user-invocable: true
---

# Run Ralph（自动循环调度 + subagent 执行）

目标：把 Ralph 的多轮迭代变成**自动循环的回合制调度器**。

- 每一轮只跑 1 次 Ralph（`./ralph.sh ... 1`）
- **主会话自动循环**：汇报下一条 story → spawn subagent 执行 → 回报结果与总体进度 → 继续下一条
- 直到：全部完成 / 达到 `maxIterations` / 遇到需要用户确认的阻塞

> 关键点：**主会话负责调度与对用户汇报；subagent 只负责执行 1 轮并总结**。

## 入参（从用户消息里解析；缺的就追问）

- `repoPath`：项目本地路径（必须是 git repo）
- `tool`：`codex` | `claude`（默认 `codex`）
- `maxIterations`：可选。最多执行多少轮。

可选：
- `branch`：如果用户希望固定在某分支跑（默认读 `scripts/ralph/prd.json.branchName`）

### maxIterations 默认策略（必须执行）

如果用户**未提供** `maxIterations`，则自动计算：
- `maxIterations = 当前未完成 story 数量`
- 读取 `scripts/ralph/prd.json` 统计 `passes=false` 的数量

说明：
- 若未完成数为 0，直接输出“已全部完成”总结并结束
- 若用户提供了 `maxIterations`，使用用户值（但主会话可提示“当前未完成数为 X”）

## 调度逻辑（主会话）

### Step 0：前置校验 + 恢复状态（B 方案）

在主会话使用 `exec` 检查：
- `repoPath/scripts/ralph/prd.json` 存在
- `repoPath/scripts/ralph/ralph.sh` 存在且可执行
- `jq` 可用（用于读取 prd.json）

并使用持久化状态文件（必须）：
- `repoPath/scripts/ralph/run-ralph-state.json`

状态文件最小结构：
```json
{
  "repoPath": "...",
  "branch": "...",
  "tool": "claude",
  "maxIterations": 6,
  "iteration": 2,
  "lastStoryId": "US-002",
  "updatedAt": "2026-02-18T13:40:00+08:00"
}
```

恢复规则：
- 若状态文件存在且 `repoPath/branch/tool` 与当前请求一致：从 `iteration+1` 继续
- 若用户明确要求“从头重跑”：删除状态文件并从第 1 轮开始
- 每轮开始前与结束后都更新状态文件，保证异常中断后可恢复

### Step 1：找“下一条要做的 story”

用 `jq` 读取：
- 选出 `passes=false` 且 `priority` 最小的 story
- 取 `id/title/description/acceptanceCriteria`

若不存在未完成 story：进入 **Step 4（总结并结束）**。

### Step 2：先在当前会话汇报“下一条任务”

给当前会话发一条消息，必须使用固定格式（见下方“回复格式约束”里的“将进行”段）。

### Step 3：启动 subagent 执行“单轮 Ralph”

用 `sessions_spawn` 启动 subagent（建议 label：`run-ralph:<repoName>`），任务内容必须包含：
- `repoPath`
- `tool`
- 明确要求：**只跑 1 次 iteration**（把 max_iterations 传 1）
- 执行命令示例（subagent 里用 exec 运行）：
  - `cd <repoPath>/scripts/ralph && ./ralph.sh --tool <tool> 1`

subagent 输出要求：
- 本轮 Ralph 的关键日志摘要（成功/失败、是否 commit/push、错误原因）
- 读取 `scripts/ralph/prd.json`，汇报：
  - 本轮 story 是否从 `passes=false` 变为 `true`
  - 当前总体完成进度：`done/total` + 未完成列表（最多列 3 条）

### Step 3b：subagent 回调后，主会话汇报

subagent 完成后，主会话对用户发一条“本轮完成情况”消息，必须使用固定格式（见下方“回复格式约束”）。

### Step 3c：自动继续或结束（**不要再问用户“是否继续”**）

- 计数 `k += 1`
- 若仍有未完成 story 且 `k < maxIterations`：**自动回到 Step 1 并继续下一轮**
- 若达到 `maxIterations` 仍未完成：输出“达到上限”总结，并停止
- 只有在出现下列“阻塞”时才暂停并问用户：
  - 需要新增/更换外部依赖（例如 API Key、付费服务、账号登录）
  - 需要重大架构取舍（多种方案且会影响后续实现）
  - 质量门禁（typecheck/lint/test）无法通过且需要用户裁决是否接受临时跳过

### Step 3d：失败重试与兜底汇报（必须）

若 subagent 返回异常（例如 `fetch failed`、输出为空、超时）
- 对同一 story 最多自动重试 1 次
- 若重试后仍失败：
  - 主会话用 `git log -1`、`git status`、`prd.json` 现状生成兜底进度汇报
  - 明确告知“实现可能已落盘但子会话汇报失败”
  - 然后暂停并请用户确认是否继续

### Step 4：全部完成后的总结

当所有 story 都 `passes=true`：
- 汇总：实现了什么（按 story 列）
- 当前分支/远程推送状态（如可得）
- 如何运行/验证（最短指令：dev / build / start）
- 删除 `run-ralph-state.json`（或写入 `status=completed`），避免下次误恢复

## 回复格式约束（必须遵守）

每次对用户汇报都使用下面结构：

已完成：
- 完成的 story 信息（`[US-xxx] 标题`）
- 完成 story 的 subagent sessionKey
- 结果（`commit` + `done/total`）

将进行：
- 下一个 story 信息（`[US-yyy] 标题`；若无则写“全部完成”）
- 下一个 story 的 subagent sessionKey（若尚未启动则写“待启动”；若全部完成则写“-”）

示例：
```text
已完成：
- [US-004] 双语摘要生成
- sessionKey: agent:main:subagent:xxxx
- 结果: commit 9afd842, done/total 4/6

将进行：
- [US-005] 前端语言切换（ZH/EN）
- sessionKey: agent:main:subagent:yyyy
```

## 重要约束

- 主会话永远不要一次性跑很久：每轮只 spawn 一个 subagent。
- subagent 只负责执行与总结，不要在 subagent 里再 spawn 新 subagent。
- 如果发现 `ralph.sh` 没有 push 但用户希望 push：主会话可以在 subagent 返回后用 `exec` 补一次 `git push`（前提：工作区干净且有 remote）。
