---
name: prd
description: "生成产品需求文档（PRD）。当你要把一个想法/功能整理成可落地的需求文档时使用。"
user-invocable: true
---

# PRD 生成器

把用户的功能想法整理成清晰、可执行的 PRD（Markdown）。

## 目标

1) 接收用户的功能描述
2) 提 3-5 个关键澄清问题（每题给 A/B/C/D 选项，方便用户快速回答，如“1A 2C 3B”）
3) 基于答案输出结构化 PRD
4) **将 PRD 保存到用户指定的项目路径**（由用户传入），建议路径：`<repo>/tasks/prd-[feature-name].md`

**重要：不要开始写代码，只写 PRD。**

## PRD 结构

- # PRD: [标题]
- ## 1. 背景 / 目标
- ## 2. Goals（可衡量）
- ## 3. User Stories（US-001…）
  - 每条包含：Description + Acceptance Criteria（可验证）
  - UI 相关 story：必须包含“Verify in browser …”（若当前环境不具备浏览器工具，则写明需人工验证）
- ## 4. Functional Requirements（FR-1…）
- ## 5. Non-Goals（明确不做什么）
- ## 6. Design Considerations（可选）
- ## 7. Technical Considerations（可选）
- ## 8. Success Metrics
- ## 9. Open Questions

## 输出与落盘

- 文件：Markdown
- 目录：`<repo>/tasks/`
- 文件名：`prd-[feature-name].md`（kebab-case）

在写文件前确保目录存在；用 `exec` 创建目录并写入文件。
