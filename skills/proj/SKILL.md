---
name: proj
description: "初始化一个支持 Ralph 的项目目录（创建目录/可选 git init/可选绑定远程仓库）。在你想快速新建项目骨架时使用。输入：项目名称；可选：目录、远程 git 地址。"
user-invocable: true
---

# 项目初始化

目标：根据用户入参初始化一个项目目录。

## 入参

- 必填：`name` 项目名称（用于目录名）
- 可选：`dir` 目标父目录（默认使用当前 workspace 或用户指定路径）
- 可选：`remote` 远程 git 地址（如 `git@github.com:xxx/yyy.git`）

- `dir` 默认：`/Users/xuan/.openclaw/workspace`（若用户明确给了则使用用户值）
- 默认行为：总是 `git init`（若无 `.git`），并默认生成首个 commit。
- 若提供了 `remote`：默认 `git push -u origin main`（如分支名不同则 push 当前分支）。

## 流程

1) 解析参数并计算项目路径：
- `projectPath = dir/name`

2) 创建目录：
- `mkdir -p "${projectPath}"`

3) 初始化 git（默认开启；若目录下还没有 `.git`）：
- `cd "${projectPath}"`
- `git init`

4) 绑定远程（若提供了 remote）：
- `git remote remove origin`（忽略错误）
- `git remote add origin <remote>`
- 尽量确保默认分支为 `main`：`git branch -M main`

5) 复制 Ralph 模板（必须）：
- 源目录：`<openclaw-ralph>/skills/ralph/_bundle/`
- 目标目录：`${projectPath}/scripts/ralph/`
- 需要复制：`CODEX.md`、`CLAUDE.md`
- 若目标已存在同名文件：默认不覆盖（保留用户已有版本）

6) 生成基础 README（如不存在）：
- 写入项目名 + 简短说明

7) 首次提交（默认开启）：
- `git add -A`
- `git commit -m "chore: init project"`
  - 若失败（常见原因：未配置 `user.name/user.email`）：提示用户如何配置，并继续输出项目路径（不要硬失败）。

8) 远程 push（默认开启；仅当提供 remote 且 commit 成功时执行）：
- `git push -u origin main`
  - 如果 push 失败（权限/不存在/网络）：提示用户错误信息与下一步排查。

## 交付

向用户输出：
- 最终项目目录绝对路径
- 是否已绑定 remote
- 下一步如何使用：
  - 使用 `prd` skill 生成 `scripts/ralph/prd.json`
  - 然后使用 ralph-runner 插件运行：通过工具 `ralph_runner(action="run", ...)` 或命令 `/ralphrun`
