---
name: ralph
description: "把 PRD 文本转换成 ralph 的 prd.json 并写入指定项目路径。仅负责 PRD→prd.json，不负责执行 ralph.sh（执行由 run-ralph skill 负责）。每次调用由用户传入 repo 路径。"
user-invocable: true
---

# OpenClaw Ralph（PRD → prd.json）

你要做两件事：
1) 收到用户给的 **PRD 文本**（Markdown 或纯文本）
2) 在用户指定的项目仓库里生成 `scripts/ralph/prd.json`

> 约定：本 skill 自带一份 `ralph.sh / CODEX.md / CLAUDE.md`，运行时拷贝到目标仓库的 `scripts/ralph/`。

---

## 需要向用户确认的参数（缺任何一个就先问）

- `repoPath`：目标项目本地路径（必须是 git repo）
- `featureName`：用于生成分支名 `ralph/<feature-name-kebab>`
- （可选）`projectName`：默认从 repo 目录名推断

---

## 步骤 A：准备目标目录与 Ralph 脚本

在 `repoPath` 下执行：

1) 确保目录存在：`mkdir -p scripts/ralph`
2) 将本 skill 的 bundle 文件复制进去：
   - `ralph.sh`
   - `CODEX.md`
   - `CLAUDE.md`
3) `chmod +x scripts/ralph/ralph.sh`
4) 确保依赖存在：`jq`、以及用户选择的工具（codex 或 claude）在 PATH 中

**注意**：Ralph 读取的是 `scripts/ralph/prd.json` 和 `scripts/ralph/progress.txt`。

---

## 步骤 B：将 PRD 文本转换成 prd.json

把用户提供的 PRD 文本解析为 JSON，写到：`<repoPath>/scripts/ralph/prd.json`

### prd.json 格式

```json
{
  "project": "[Project Name]",
  "branchName": "ralph/[feature-name-kebab-case]",
  "description": "[从 PRD 标题/导语提炼]",
  "userStories": [
    {
      "id": "US-001",
      "title": "[Story title]",
      "description": "As a [user], I want [feature] so that [benefit]",
      "acceptanceCriteria": ["...", "Typecheck passes"],
      "priority": 1,
      "passes": false,
      "notes": ""
    }
  ]
}
```

### 转换规则（必须遵守）

- 每条 user story 必须足够小：能在 **一次迭代**完成
- priority：依赖优先（schema → backend → UI），同级按 PRD 顺序
- 每条 acceptanceCriteria 最后一条必须包含：`Typecheck passes`
- 需要跑测试的 story：增加 `Tests pass`
- 涉及 UI 的 story：增加 `Verify in browser`（若当前环境无法浏览器验证，标注需要人工验证）
- 所有 story：`passes=false`，`notes` 为空

---

## 执行边界（重要）

`ralph` skill **不执行** `ralph.sh`。当用户要进入迭代开发阶段时：
- 明确引导用户改用 `run-ralph` skill
- 或在当前会话中直接切换到 run-ralph 的调度流程

---

## 推荐的对话式调用模板（你可以引导用户这样发）

用户消息示例：

- “用 ralph 生成 prd.json。repoPath=/path/to/repo feature=task-priority。PRD：<粘贴PRD>”

你要从消息里解析出参数并开始执行；若用户要求直接迭代实现，转交 `run-ralph` skill。
