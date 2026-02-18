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
- `maxIterations`：最多执行多少轮（默认 10）

可选：
- `branch`：如果用户希望固定在某分支跑（默认读 `scripts/ralph/prd.json.branchName`）

## 调度逻辑（主会话）

### Step 0：前置校验

在主会话使用 `exec` 检查：
- `repoPath/scripts/ralph/prd.json` 存在
- `repoPath/scripts/ralph/ralph.sh` 存在且可执行
- `jq` 可用（用于读取 prd.json）

### Step 1：找“下一条要做的 story”

用 `jq` 读取：
- 选出 `passes=false` 且 `priority` 最小的 story
- 取 `id/title/description/acceptanceCriteria`

若不存在未完成 story：进入 **Step 4（总结并结束）**。

### Step 2：先在当前会话汇报“下一条任务”

给当前会话发一条消息（简洁但信息足够）：
- 本轮编号（iteration k / maxIterations）
- 将要执行的 story：`[id] title`
- 1 句 description
- 关键验收点（列 3-6 条，太长就截断）

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

subagent 完成后，主会话对用户发一条“本轮完成情况”消息：
- 本轮结果：成功/失败
- 是否产生 commit（hash + message）/ 是否 push（如有 remote）
- 当前进度 done/total + 下一条 story（若还有）

### Step 3c：自动继续或结束（**不要再问用户“是否继续”**）

- 计数 `k += 1`
- 若仍有未完成 story 且 `k < maxIterations`：**自动回到 Step 1 并继续下一轮**
- 若达到 `maxIterations` 仍未完成：输出“达到上限”总结，并停止
- 只有在出现下列“阻塞”时才暂停并问用户：
  - 需要新增/更换外部依赖（例如 API Key、付费服务、账号登录）
  - 需要重大架构取舍（多种方案且会影响后续实现）
  - 质量门禁（typecheck/lint/test）无法通过且需要用户裁决是否接受临时跳过

### Step 4：全部完成后的总结

当所有 story 都 `passes=true`：
- 汇总：实现了什么（按 story 列）
- 当前分支/远程推送状态（如可得）
- 如何运行/验证（最短指令：dev / build / start）

## 重要约束

- 主会话永远不要一次性跑很久：每轮只 spawn 一个 subagent。
- subagent 只负责执行与总结，不要在 subagent 里再 spawn 新 subagent。
- 如果发现 `ralph.sh` 没有 push 但用户希望 push：主会话可以在 subagent 返回后用 `exec` 补一次 `git push`（前提：工作区干净且有 remote）。
