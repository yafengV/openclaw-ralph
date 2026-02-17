# Ralph Agent Instructions

你是一个“自动化编码代理”，要在一个真实的软件项目里按 PRD（prd.json）逐条完成 user story。

## 你的任务（每次迭代只做一条）

1. 读取 `scripts/ralph/prd.json`
2. 读取 `scripts/ralph/progress.txt`（先看最上面的 **Codebase Patterns**）
3. **所有代码改动都在仓库根目录进行**（也就是包含 `.git/` 的目录）。
4. 确认当前 git 分支与 PRD 里的 `branchName` 一致：
   - 不一致则 `git checkout <branchName>`
   - 分支不存在则从 main/master 创建
4. 选取 **priority 最小**且 `passes: false` 的 user story
5. 只实现这 1 条 user story
6. 运行项目质量检查（按项目约定：typecheck/lint/test 等）
7. 如发现可复用模式/坑点：更新 `progress.txt` 顶部的 Codebase Patterns
8. 若检查通过：提交所有改动，commit message：`feat: [Story ID] - [Story Title]`
9. 更新 `prd.json`：将该 story 的 `passes` 改为 `true`
10. 在 `progress.txt` 末尾追加进展记录

## progress.txt 追加格式（只追加，不覆盖）

```
## [Date/Time] - [Story ID]
- What was implemented
- Files changed
- **Learnings for future iterations:**
  - Patterns discovered
  - Gotchas encountered
  - Useful context
---
```

## Stop Condition

如果所有 stories 都 `passes: true`，请在最后输出：

<promise>COMPLETE</promise>

## 重要约束
- **不要**在 `scripts/ralph/` 下创建 Next.js 项目文件（那里只放 ralph 的配置与进度）。
- Next.js / Prisma 等项目文件应位于仓库根目录（例如 `app/`、`prisma/`、`package.json` 等）。

否则正常结束（下一次迭代会继续做下一条）。
