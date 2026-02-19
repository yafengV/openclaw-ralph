import type { OpenClawPluginApi, PluginCommandContext, PluginToolContext } from "openclaw/plugin-sdk";
import fs from "node:fs";
import path from "node:path";

// 从 package.json 动态读取版本号
let PLUGIN_VERSION = "1.0.3";
try {
  const pkgPath = path.join(import.meta.dirname || __dirname, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  if (pkg.version) {
    PLUGIN_VERSION = pkg.version;
  }
} catch {
  // 读取失败使用默认版本
}

type ToolName = "codex" | "claude";

type JobStatus = "queued" | "running" | "completed" | "failed" | "canceled";

type RalphJob = {
  version: 1;
  jobId: string;
  createdAt: string;
  updatedAt: string;

  repoPath: string;
  tool: ToolName;
  maxIterations: number;

  channel: string;
  to?: string;
  accountId?: string;
  messageThreadId?: number;

  status: JobStatus;
  iteration: number;
  lastCompletedStoryId?: string;
  lastCompletedCommit?: string;
  lastError?: string;
};

const CODEX_PROMPT = `# Ralph Agent Instructions

你是一个"自动化编码代理"，要在一个真实的软件项目里按 PRD（prd.json）逐条完成 user story。

## 你的任务（每次迭代只做一条）

1. 读取 \`scripts/ralph/prd.json\`
2. 读取 \`scripts/ralph/progress.txt\`（先看最上面的 **Codebase Patterns**）
3. **所有代码改动都在仓库根目录进行**（也就是包含 \`.git/\` 的目录）。
4. 确认当前 git 分支与 PRD 里的 \`branchName\` 一致：
   - 不一致则 \`git checkout <branchName>\`
   - 分支不存在则从 main/master 创建
5. 选取 **priority 最小**且 \`passes: false\` 的 user story
6. 只实现这 1 条 user story
7. 运行项目质量检查（按项目约定：typecheck/lint/test 等）
8. 如发现可复用模式/坑点：更新 \`progress.txt\` 顶部的 Codebase Patterns
9. 若检查通过：提交所有改动，commit message：\`feat: [Story ID] - [Story Title]\`
10. 更新 \`prd.json\`：将该 story 的 \`passes\` 改为 \`true\`
11. 在 \`progress.txt\` 末尾追加进展记录

## Stop Condition

如果所有 stories 都 \`passes: true\`，请在最后输出：

<promise>COMPLETE</promise>

## 重要约束
- **不要**在 \`scripts/ralph/\` 下创建 Next.js 项目文件（那里只放 ralph 的配置与进度）。
- Next.js / Prisma 等项目文件应位于仓库根目录（例如 \`app/\`、\`prisma/\`、\`package.json\` 等）。
`;

const CLAUDE_PROMPT = `# Ralph Agent Instructions (Claude Code)

你是一个自动化编码代理。每次只完成一条 user story。

必须：
- 读取 scripts/ralph/prd.json，选择 priority 最小且 passes=false 的 story
- 实现它并运行 typecheck/lint/test（按项目已有脚本）
- git commit（feat: [Story ID] - [Story Title]）
- prd.json 里把该 story passes 改为 true
- progress.txt 追加记录

完成全部后输出：
<promise>COMPLETE</promise>
`;

function nowIso() {
  return new Date().toISOString();
}

function parseKvArgs(raw: any): Record<string, string> {
  const out: Record<string, string> = {};
  const str = typeof raw === "string" ? raw : "";
  for (const token of str.split(/\s+/).filter(Boolean)) {
    const tokenStr = typeof token === "string" ? token : String(token);
    const idx = tokenStr.indexOf("=");
    if (idx <= 0) continue;
    const k = tokenStr.slice(0, idx).trim();
    const v = tokenStr.slice(idx + 1).trim();
    if (!k) continue;
    out[k] = v;
  }
  return out;
}

function readJson<T>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as T;
  } catch {
    return null;
  }
}

function prdPath(repoPath: string) {
  return path.join(repoPath, "scripts", "ralph", "prd.json");
}

function computeStoryState(repoPath: string): {
  done: number;
  total: number;
  remaining: number;
  next?: { id: string; title: string; priority?: number };
  passesById: Record<string, boolean>;
} | null {
  try {
    const prd = readJson<any>(prdPath(repoPath));
    if (!prd || !Array.isArray(prd.userStories)) {
      return { done: 0, total: 0, remaining: 0, passesById: {} };
    }
    const stories = prd.userStories.slice();
    stories.sort((a, b) => (a.priority ?? 9999) - (b.priority ?? 9999));
    const done = stories.filter((s) => s.passes === true).length;
    const total = stories.length;
    const nextStory = stories.find((s) => s.passes !== true);
    const passesById: Record<string, boolean> = {};
    for (const s of stories) {
      if (s?.id) passesById[String(s.id)] = s.passes === true;
    }
    return {
      done,
      total,
      remaining: total - done,
      next: nextStory
        ? { id: String(nextStory.id ?? ""), title: String(nextStory.title ?? ""), priority: nextStory.priority }
        : undefined,
      passesById,
    };
  } catch {
    return null;
  }
}

async function sendText(api: OpenClawPluginApi, job: RalphJob, text: string) {
  try {
    if (!job.to) {
      // 工具调用时没有 channel 信息，使用 logger 记录
      api.logger.info(`ralph-runner [${job.jobId}]: ${text}`);
      return;
    }
    const channel = api.runtime[job.channel as keyof typeof api.runtime];
    if (channel && typeof channel === "object" && "sendMessage" in channel) {
      const channelObj = channel as any;
      if (typeof channelObj.sendMessage === "function") {
        await channelObj.sendMessage(job.to, text, {
          accountId: job.accountId,
          messageThreadId: job.messageThreadId,
        });
        return;
      }
    }
    // 降级：尝试 telegram 的直接方法
    if (job.channel === "telegram" && api.runtime.telegram && typeof api.runtime.telegram.sendMessageTelegram === "function") {
      await api.runtime.telegram.sendMessageTelegram(job.to, text, {
        accountId: job.accountId,
        messageThreadId: job.messageThreadId,
      });
      return;
    }
  } catch (err: any) {
    // 发送消息失败不影响任务执行，只记录错误
    api.logger.error(`ralph-runner [${job.jobId}] sendText failed: ${err?.message || String(err)}`);
  }
}

function formatProgress(params: {
  completed: { id: string; title: string; sessionKey: string; commit: string; done: number; total: number };
  next?: { id: string; title: string; sessionKey: string };
}) {
  const nextBlock = params.next
    ? [
        "将进行：",
        `- [${params.next.id}] ${params.next.title}`,
        `- 下一个 story 的 jobId/iteration：${params.next.sessionKey}`,
      ]
    : ["将进行：", "- 全部完成", "- 下一个 story 的 jobId/iteration：-"];

  return [
    "已完成：",
    `- [${params.completed.id}] ${params.completed.title}`,
    `- 完成 story 的 jobId/iteration：${params.completed.sessionKey}`,
    `- 结果：commit ${params.completed.commit}，done/total ${params.completed.done} / ${params.completed.total}`,
    "",
    ...nextBlock,
  ].join("\n");
}

async function run(argv: string[], api: OpenClawPluginApi, opts: { timeoutSec: number; cwd?: string; input?: string }) {
  return api.runtime.system.runCommandWithTimeout(argv, {
    timeoutMs: opts.timeoutSec * 1000,
    cwd: opts.cwd,
    input: opts.input,
    env: {},
  });
}

async function git(api: OpenClawPluginApi, repoRoot: string, args: string[], timeoutSec = 60) {
  return run(["git", ...args], api, { timeoutSec, cwd: repoRoot });
}

async function tryPushIfClean(api: OpenClawPluginApi, repoRoot: string) {
  try {
    const status = await git(api, repoRoot, ["status", "--porcelain"]);
    if ((status.stdout ?? "").trim().length > 0) return;
    const hasOrigin = await git(api, repoRoot, ["remote", "get-url", "origin"]).catch(() => null);
    if (!hasOrigin) return;
    const branch = await git(api, repoRoot, ["branch", "--show-current"]).then(r => r?.stdout?.trim() || "").catch(() => "");
    if (!branch) return;
    await git(api, repoRoot, ["push", "-u", "origin", branch], 180).catch(() => null);
  } catch {
    // best-effort
  }
}

async function runOneStory(api: OpenClawPluginApi, job: RalphJob) {
  const before = computeStoryState(job.repoPath);
  if (!before || !before.next) {
    job.status = "completed";
    return;
  }

  const repoRoot = await git(api, job.repoPath, ["rev-parse", "--show-toplevel"]).then(r => r?.stdout?.trim() || "").catch(() => "");
  if (!repoRoot) throw new Error("repoPath 不是有效 git 仓库（缺少 .git）");

  const iterationId = `${job.jobId}#${job.iteration + 1}`;

  // Run tool (single iteration)
  const timeoutSec = Number(api.pluginConfig?.iterationTimeoutSec ?? 1800);

  if (job.tool === "codex") {
    await run(
      ["codex", "exec", "--full-auto", "-C", repoRoot, "--add-dir", path.join(repoRoot, "scripts", "ralph")],
      api,
      { timeoutSec, cwd: repoRoot, input: CODEX_PROMPT },
    );
  } else {
    const args = [
      "--dangerously-skip-permissions",
      "--print",
      "--verbose",
      "--output-format=stream-json",
      "--include-partial-messages",
    ];
    await run(["claude", ...args], api, { timeoutSec, cwd: repoRoot, input: CLAUDE_PROMPT });
  }

  await tryPushIfClean(api, repoRoot);

  const after = computeStoryState(job.repoPath);
  if (!after) throw new Error("无法读取 prd.json");
  const commit = await git(api, repoRoot, ["log", "-1", "--pretty=%h"]).then(r => r?.stdout?.trim() || "-").catch(() => "-");

  // Validate that the story we attempted is now marked passes=true
  const completedId = before.next.id;
  const wasMarked = after.passesById[completedId] === true;
  if (!wasMarked) {
    throw new Error(`该轮执行后 story 未标记完成：${completedId}`);
  }

  const completed = {
    id: completedId,
    title: before.next.title,
    sessionKey: iterationId,
    commit,
    done: after.done,
    total: after.total,
  };

  const next = after.next
    ? {
        id: after.next.id,
        title: after.next.title,
        sessionKey: `${job.jobId}#${job.iteration + 2}`,
      }
    : undefined;

  job.iteration += 1;
  job.lastCompletedStoryId = completed.id;
  job.lastCompletedCommit = completed.commit;
  job.updatedAt = nowIso();

  await sendText(api, job, formatProgress({ completed, next }));

  if (!after.next || after.done === after.total) {
    job.status = "completed";
  }
}

export default function register(api: OpenClawPluginApi) {
  const logger = api.logger;

  const MAX_CONCURRENCY = 3;
  const jobs = new Map<string, RalphJob>();
  const cancels = new Set<string>();

  function runningCount() {
    let n = 0;
    for (const j of jobs.values()) if (j.status === "running" || j.status === "queued") n += 1;
    return n;
  }

  async function runJob(job: RalphJob) {
    job.status = "running";
    job.updatedAt = nowIso();

    const failedIterations: number[] = [];

    try {
      while (job.status === "running") {
        if (cancels.has(job.jobId)) {
          job.status = "canceled";
          break;
        }

        const state = computeStoryState(job.repoPath);
        if (!state) {
          job.status = "failed";
          job.lastError = "无法读取 prd.json";
          job.updatedAt = nowIso();
          await sendText(api, job, `执行失败（job=${job.jobId}）：${job.lastError}`);
          break;
        }

        const remaining = state.remaining;
        const cap = Math.min(remaining, job.maxIterations);
        if (remaining <= 0 || job.iteration >= cap) {
          job.status = remaining <= 0 ? "completed" : "completed";
          await sendText(api, job, `所有任务完成！total=${state.total} done=${state.done}`);
          break;
        }

        try {
          await runOneStory(api, job);
        } catch (err: any) {
          // 单个任务失败，记录错误但继续执行下一个
          const errorMsg = err?.message || String(err);
          failedIterations.push(job.iteration + 1);
          job.iteration += 1;
          job.updatedAt = nowIso();
          api.logger.error(`ralph-runner [${job.jobId}] 迭代 ${job.iteration} 失败：${errorMsg}`);
          await sendText(api, job, `第 ${job.iteration} 轮失败：${errorMsg}，继续执行下一个任务`);

          // 避免连续失败导致无限循环，暂停一下
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    } catch (err: any) {
      job.status = "failed";
      job.lastError = err?.message || String(err);
      job.updatedAt = nowIso();
      await sendText(api, job, `执行失败（job=${job.jobId}）：${job.lastError}`);
    }
  }

  // Register tool interface for agent calls
  api.registerTool(
    (ctx: PluginToolContext) => {
      return {
        ralph_run: {
          description: "Run Ralph background job. Parameters: repoPath (string), tool (codex|claude, default=codex), maxIterations (number, optional). Returns: { success: boolean, jobId?: string, message?: string }",
          input_schema: {
            type: "object",
            properties: {
              repoPath: { type: "string", description: "Path to repository" },
              tool: { type: "string", enum: ["codex", "claude"], description: "Tool to use", default: "codex" },
              maxIterations: { type: "number", description: "Maximum iterations (optional, defaults to remaining stories)" },
            },
            required: ["repoPath"],
          },
        },
        ralph_list: {
          description: "List Ralph jobs. Returns: { jobs: Array<{jobId, status, iteration, maxIterations, tool, repoPath, lastError}> }",
          input_schema: {
            type: "object",
            properties: {},
          },
        },
        ralph_cancel: {
          description: "Cancel a Ralph job. Parameters: jobId (string). Returns: { success: boolean, message?: string }",
          input_schema: {
            type: "object",
            properties: {
              jobId: { type: "string", description: "Job ID to cancel" },
            },
            required: ["jobId"],
          },
        },
      };
    },
    {
      names: ["ralph_run", "ralph_list", "ralph_cancel"],
      handler: async (toolName: string, input: any) => {
        try {
          if (toolName === "ralph_run") {
            logger.info("ralph-run: input received", { toolName, input });
            const repoPath = input.repoPath ? String(input.repoPath) : "";
            const tool = (input.tool as ToolName) || ((api.pluginConfig?.defaultTool as ToolName) ?? "codex");

            if (!repoPath) {
              return { success: false, message: "缺少参数：repoPath" };
            }

            if (tool !== "codex" && tool !== "claude") {
              return { success: false, message: `tool 必须是 codex 或 claude，当前=${String(tool)}` };
            }

            if (runningCount() >= MAX_CONCURRENCY) {
              return { success: false, message: `任务达上限：当前并发上限=${MAX_CONCURRENCY}` };
            }

            if (!fs.existsSync(prdPath(repoPath))) {
              return { success: false, message: `找不到 prd.json：${prdPath(repoPath)}` };
            }

            const state = computeStoryState(repoPath);
            if (!state || state.remaining <= 0) {
              return { success: false, message: "没有未完成 story（passes=false 为 0）" };
            }
            const remaining = state.remaining;

            const maxIterationsRaw = input.maxIterations;
            const maxIterationsParsed = maxIterationsRaw ? Number(maxIterationsRaw) : remaining;
            const effectiveMax = Number.isFinite(maxIterationsParsed) ? Math.max(1, Math.floor(maxIterationsParsed)) : remaining;
            const finalMax = Math.min(remaining, effectiveMax);

            const jobId = `ralph_${Date.now()}_${Math.random().toString(16).slice(2)}`;
            const job: RalphJob = {
              version: 1,
              jobId,
              createdAt: nowIso(),
              updatedAt: nowIso(),
              repoPath,
              tool,
              maxIterations: finalMax,
              channel: "agent",
              status: "queued",
              iteration: 0,
            };

            jobs.set(jobId, job);
            void runJob(job);

            logger.info("ralph-runner: job started (via tool)", { jobId, repoPath, tool, maxIterations: finalMax });

            return {
              success: true,
              jobId,
              message: `[ralph-runner v${PLUGIN_VERSION}] 已启动 job=${jobId} tool=${tool} maxIterations=${finalMax} done/total=${state.done}/${state.total}${state.next ? ` next=[${state.next.id}] ${state.next.title}` : " next=全部完成"}`,
            };
          }

          if (toolName === "ralph_list") {
            if (jobs.size === 0) {
              return { jobs: [] };
            }
            const jobList: any[] = [];
            for (const j of jobs.values()) {
              jobList.push({
                jobId: j.jobId,
                status: j.status,
                iteration: j.iteration,
                maxIterations: j.maxIterations,
                tool: j.tool,
                repoPath: j.repoPath,
                lastError: j.lastError,
              });
            }
            return { jobs: jobList };
          }

          if (toolName === "ralph_cancel") {
            const jobId = input.jobId ? String(input.jobId).trim() : "";
            if (!jobId) {
              return { success: false, message: "缺少 jobId" };
            }
            if (!jobs.has(jobId)) {
              return { success: false, message: `未找到 job：${jobId}` };
            }
            cancels.add(jobId);
            const job = jobs.get(jobId)!;
            job.status = "canceled";
            job.updatedAt = nowIso();
            logger.info("ralph-runner: job canceled (via tool)", { jobId });
            return { success: true, message: `已取消：${jobId}` };
          }

          return { success: false, message: `未知工具：${toolName}` };
        } catch (err: any) {
          logger.error(`ralph-runner: handler error: ${err?.message || String(err)}`, { toolName, input });
          return { success: false, message: `处理失败：${err?.message || String(err)}` };
        }
      },
    },
  );

  // Keep command interface for backward compatibility and manual use
  api.registerCommand({
    name: "ralphrun",
    description:
      "Run Ralph as a plugin background job (no subagents). Usage: /ralphrun repoPath=... tool=codex|claude maxIterations=10",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: PluginCommandContext) => {
      try {
        const kv = parseKvArgs(ctx.args ?? "");
        const repoPath = kv.repoPath || kv.repo || "";
        if (!repoPath) {
          return { text: "缺少参数：repoPath。示例：/ralphrun repoPath=/path/to/repo tool=codex maxIterations=10" };
        }

        if (runningCount() >= MAX_CONCURRENCY) {
          return { text: `任务达上限：当前并发上限=${MAX_CONCURRENCY}。请稍后再试或先 /ralphjobs 查看状态。` };
        }

        if (!fs.existsSync(prdPath(repoPath))) {
          return { text: `找不到 prd.json：${prdPath(repoPath)}` };
        }

        const tool = (kv.tool as ToolName) || ((api.pluginConfig?.defaultTool as ToolName) ?? "codex");
        if (tool !== "codex" && tool !== "claude") {
          return { text: `tool 必须是 codex 或 claude，当前=${String(tool)}` };
        }

        const state = computeStoryState(repoPath);
        if (!state || state.remaining <= 0) {
          return { text: "没有未完成 story（passes=false 为 0）。" };
        }
        const remaining = state.remaining;

        const maxIterationsRaw = kv.maxIterations || kv.iterations;
        const maxIterationsParsed = maxIterationsRaw ? Number(maxIterationsRaw) : remaining;
        const effectiveMax = Number.isFinite(maxIterationsParsed) ? Math.max(1, Math.floor(maxIterationsParsed)) : remaining;
        const finalMax = Math.min(remaining, effectiveMax);

        const jobId = `ralph_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        const job: RalphJob = {
          version: 1,
          jobId,
          createdAt: nowIso(),
          updatedAt: nowIso(),
          repoPath,
          tool,
          maxIterations: finalMax,
          channel: ctx.channel,
          to: ctx.to,
          accountId: ctx.accountId,
          messageThreadId: ctx.messageThreadId,
          status: "queued",
          iteration: 0,
        };

        jobs.set(jobId, job);
        void runJob(job);

        logger.info("ralph-runner: job started (via command)", { jobId, repoPath, tool, maxIterations: finalMax });

        const next = state.next;
        return {
          text:
            `[ralph-runner v${PLUGIN_VERSION}] ` +
            `已启动 job=${jobId} tool=${tool} maxIterations=${finalMax} done/total=${state.done}/${state.total}` +
            (next ? `\nnext=[${next.id}] ${next.title}` : "\nnext=全部完成"),
        };
      } catch (err: any) {
        logger.error(`ralph-runner: command handler error: ${err?.message || String(err)}`);
        return { text: `处理失败：${err?.message || String(err)}` };
      }
    },
  });

  api.registerCommand({
    name: "ralphjobs",
    description: "List current ralph-runner jobs",
    requireAuth: true,
    handler: async () => {
      if (jobs.size === 0) return { text: "暂无任务。" };
      const lines: string[] = [];
      for (const j of jobs.values()) {
        lines.push(
          `${j.jobId} ${j.status} iter=${j.iteration}/${j.maxIterations} tool=${j.tool} repo=${j.repoPath}` +
            (j.lastError ? ` err=${j.lastError}` : ""),
        );
      }
      return { text: lines.join("\n") };
    },
  });

  api.registerCommand({
    name: "ralphcancel",
    description: "Cancel a running job. Usage: /ralphcancel jobId=...",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: PluginCommandContext) => {
      try {
        const argsStr = typeof ctx.args === "string" ? ctx.args : "";
        const kv = parseKvArgs(argsStr);
        const jobId = kv.jobId || kv.id || argsStr.trim();
        if (!jobId) return { text: "缺少 jobId。示例：/ralphcancel jobId=ralph_xxx" };
        if (!jobs.has(jobId)) return { text: `未找到 job：${jobId}` };
        cancels.add(jobId);
        const job = jobs.get(jobId)!;
        job.status = "canceled";
        job.updatedAt = nowIso();
        return { text: `已取消：${jobId}` };
      } catch (err: any) {
        logger.error(`ralph-runner: ralphcancel error: ${err?.message || String(err)}`);
        return { text: `处理失败：${err?.message || String(err)}` };
      }
    },
  });
}
