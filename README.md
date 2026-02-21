# OpenClaw Ralph

Ralph 是一个自动化编码工作流，将产品需求文档（PRD）转换为可执行的用户故事，并通过 AI 编码代理逐步实现。

## 功能特性

- **PRD 生成**：将功能想法整理成结构化的产品需求文档
- **prd.json 转换**：将 PRD 转换为机器可读的 JSON 格式
- **自动化执行**：通过 Codex、Claude 或 Cursor Agent 逐个实现用户故事
- **进度追踪**：自动更新进度并回传消息（支持 Telegram 等渠道）

## 安装

### 前置条件

- OpenClaw >= 2026.1.26
- 至少安装以下 AI 工具之一：
  - [Codex CLI](https://github.com/openai/codex)
  - [Claude CLI](https://docs.anthropic.com/claude-cli)
  - [Cursor Agent CLI](https://cursor.com/cli)

### 安装 Skills 和 Plugin

首先克隆仓库到本地：

```bash
git clone https://github.com/yafengV/openclaw-ralph.git
cd openclaw-ralph
```

然后安装 Skills（Agent 能力扩展）：

```bash
openclaw skill install .
```

安装后可用的 Skills：

| Skill | 描述 | 调用方式 |
|-------|------|----------|
| `prd` | 生成产品需求文档 | 对话中说"生成 PRD" |
| `ralph` | 将 PRD 转换为 prd.json | 对话中说"用 ralph 生成 prd.json" |
| `proj` | 初始化支持 Ralph 的项目目录 | 对话中说"初始化项目" |

安装 Plugin（ralph-runner，后台扩展，提供工具和命令）：

```bash
cd extensions/ralph-runner
openclaw plugin install .
```

安装后重启 OpenClaw Gateway 使插件生效：

```bash
openclaw gateway restart
```

## 使用流程

### 1. 初始化项目

```
用 proj 初始化项目，name=my-project
```

这会创建项目目录并复制必要的模板文件（`CODEX.md`、`CLAUDE.md`、`CURSOR.md`）到 `scripts/ralph/`。

### 2. 生成 PRD

```
生成 PRD：我想实现一个用户认证功能，包括登录、注册、密码重置
```

### 3. 转换为 prd.json

```
用 ralph 生成 prd.json，repoPath=/path/to/my-project feature=user-auth
PRD：[粘贴 PRD 内容]
```

### 4. 运行 Ralph Runner

#### 通过命令

```
/ralphrun repoPath=/path/to/my-project tool=cursor maxIterations=10
```

#### 通过工具调用

```
ralph_runner(action="run", repoPath="/path/to/my-project", tool="cursor")
```

#### 可用参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `repoPath` | string | 项目路径（必填） |
| `tool` | string | AI 工具：`codex`、`claude` 或 `cursor` |
| `maxIterations` | number | 最大迭代次数 |
| `channel` | string | 消息回传渠道（如 `telegram`） |
| `to` | string | 消息回传目标（如 chat id） |

### 5. 管理任务

```bash
# 查看任务列表
/ralphjobs

# 取消任务
/ralphcancel jobId=ralph_xxx

# 绑定默认回传目标
/ralphbind
```

## 配置

### Plugin 配置

在 OpenClaw 插件配置中可设置：

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `defaultTool` | string | `codex` | 默认 AI 工具 |
| `maxIterationsDefault` | number | `20` | 默认最大迭代次数 |
| `iterationTimeoutSec` | number | `1800` | 单次迭代超时（秒） |

### 环境变量

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `RALPH_CODEX_CMD` | `codex exec --full-auto` | 自定义 Codex 命令 |
| `RALPH_CURSOR_CMD` | `agent -p --yolo --force` | 自定义 Cursor 命令 |

## 项目结构

```
openclaw-ralph/
├── index.ts                    # 插件入口
├── openclaw.plugin.json        # 插件清单
├── skills/                     # Agent Skills
│   ├── prd/SKILL.md           # PRD 生成
│   ├── ralph/SKILL.md         # PRD → prd.json
│   └── proj/                  # 项目初始化
│       ├── SKILL.md
│       └── _bundle/           # 模板文件
│           ├── CODEX.md
│           ├── CLAUDE.md
│           └── CURSOR.md
└── extensions/
    └── ralph-runner/          # Ralph Runner 插件
        ├── index.ts
        ├── package.json
        └── openclaw.plugin.json
```

## AI 工具对比

| 工具 | 命令 | 特点 |
|------|------|------|
| Codex | `codex exec --full-auto` | OpenAI 官方，完全自动模式 |
| Claude | `claude --dangerously-skip-permissions --print` | Anthropic 官方，跳过权限确认 |
| Cursor | `agent -p --yolo --force` | Cursor IDE Agent，需 YOLO 模式 |

## 故障排除

### Cursor 无法执行 git commit

Cursor Agent CLI 默认需要用户确认才能执行 git 命令。解决方案：

1. 确保使用 `--yolo --force` 参数
2. 或设置环境变量：`export RALPH_CURSOR_CMD="agent -p --yolo --force --sandbox=off"`
3. 或在 Cursor 设置中将 git 命令添加到 allowlist

### 找不到 prd.json

确保先用 `proj` skill 初始化项目，或手动创建 `scripts/ralph/` 目录。

### 插件未加载

1. 检查 OpenClaw 版本 >= 2026.1.26
2. 运行 `openclaw gateway restart` 重启网关
3. 检查日志：`openclaw logs`

## 许可证

MIT
