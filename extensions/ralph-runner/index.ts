import type { AnyAgentTool, OpenClawPluginApi, PluginCommandContext } from "openclaw/plugin-sdk";
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

type CallbackTarget = {
  channel: string;
  to: string;
  accountId?: string;
  messageThreadId?: number;
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

function callbackStatePath() {
  const home = process.env.HOME || "/tmp";
  return path.join(home, ".openclaw", "extensions", "ralph-runner", "state.json");
}

function readCallbackTarget(): CallbackTarget | null {
  try {
    const p = callbackStatePath();
    if (!fs.existsSync(p)) return null;
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!raw || typeof raw !== "object") return null;
    const channel = typeof raw.channel === "string" ? raw.channel.trim() : "";
    const to = typeof raw.to === "string" ? raw.to.trim() : "";
    if (!channel || !to) return null;
    const accountId = typeof raw.accountId === "string" && raw.accountId.trim() ? raw.accountId.trim() : undefined;
    const messageThreadId = Number.isFinite(Number(raw.messageThreadId)) ? Number(raw.messageThreadId) : undefined;
    return { channel, to, accountId, messageThreadId };
  } catch {
    return null;
  }
}

function writeCallbackTarget(target: CallbackTarget | null) {
  const p = callbackStatePath();
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  if (!target) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
    return;
  }
  fs.writeFileSync(p, JSON.stringify(target, null, 2), "utf8");
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

function computeStoryState(repoPath: string, logger: any): {
  done: number;
  total: number;
  remaining: number;
  next?: { id: string; title: string; priority?: number };
  passesById: Record<string, boolean>;
} | null {
  const p = prdPath(repoPath);
  try {
    if (!fs.existsSync(p)) {
      logger.warn(`[ralph-runner] prd.json 不存在：${p}`);
      return { done: 0, total: 0, remaining: 0, passesById: {} };
    }
    const content = fs.readFileSync(p, "utf8");
    if (!content || content.trim().length === 0) {
      logger.error(`[ralph-runner] prd.json 为空：${p}`);
      return { done: 0, total: 0, remaining: 0, passesById: {} };
    }
    const prd = JSON.parse(content);
    if (!prd || !Array.isArray(prd.userStories)) {
      logger.error(`[ralph-runner] prd.json 格式错误：${p}`);
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
    logger.info(`[ralph-runner] 读取 prd.json 成功：done=${done}/${total}, next=${nextStory?.id || "无"}`);
    return {
      done,
      total,
      remaining: total - done,
      next: nextStory
        ? { id: String(nextStory.id ?? ""), title: String(nextStory.title ?? ""), priority: nextStory.priority }
        : undefined,
      passesById,
    };
  } catch (err: any) {
    logger.error(`[ralph-runner] 读取 prd.json 失败：${p}`, err);
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

async function tryPushIfClean(api: OpenClawPluginApi, repoRoot: string, logger: any) {
  try {
    logger.info(`[ralph-runner] 检查是否需要 push...`);
    const status = await git(api, repoRoot, ["status", "--porcelain"]).catch(() => ({ stdout: "" }));
    const stdout = status && typeof status.stdout === "string" ? status.stdout : "";
    if (stdout.trim().length > 0) {
      logger.info(`[ralph-runner] 工作区未清，跳过 push`);
      return;
    }
    const hasOrigin = await git(api, repoRoot, ["remote", "get-url", "origin"]).then(r => r && typeof r.stdout === "string" && r.stdout.trim()).catch(() => null);
    if (!hasOrigin) {
      logger.info(`[ralph-runner] 没有 remote origin，跳过 push`);
      return;
    }
    const branch = await git(api, repoRoot, ["branch", "--show-current"]).then(r => r && typeof r.stdout === "string" ? r.stdout.trim() : "").catch(() => "");
    if (!branch) {
      logger.info(`[ralph-runner] 无法获取当前分支，跳过 push`);
      return;
    }
    logger.info(`[ralph-runner] 推送到 ${branch}...`);
    await git(api, repoRoot, ["push", "-u", "origin", branch], 180).catch(() => null);
    logger.info(`[ralph-runner] push 完成`);
  } catch (err: any) {
    logger.error(`[ralph-runner] push 失败（非致命）：${err?.message || String(err)}`);
  }
}

async function runOneStory(api: OpenClawPluginApi, job: RalphJob, logger: any) {
  logger.info(`[ralph-runner][ITER_START] job=${job.jobId} iter=${job.iteration + 1}`);

  const before = computeStoryState(job.repoPath, logger);
  if (!before || !before.next) {
    logger.info(`[ralph-runner] [${job.jobId}] 所有任务已完成`);
    job.status = "completed";
    return;
  }

  const repoRoot = await git(api, job.repoPath, ["rev-parse", "--show-toplevel"])
    .then(r => r && typeof r.stdout === "string" ? r.stdout.trim() : "")
    .catch(() => "");
  if (!repoRoot) {
    logger.error(`[ralph-runner] [${job.jobId}] repoPath 不是有效 git 仓库：${job.repoPath}`);
    throw new Error("repoPath 不是有效 git 仓库（缺少 .git）");
  }

  logger.info(`[ralph-runner] [${job.jobId}] 仓库根目录：${repoRoot}`);

  const iterationId = `${job.jobId}#${job.iteration + 1}`;

  // Run tool (single iteration)
  const timeoutSec = Number(api.pluginConfig?.iterationTimeoutSec ?? 1800);
  logger.info(`[ralph-runner][ITER_EXEC] job=${job.jobId} iter=${job.iteration + 1} tool=${job.tool} timeoutSec=${timeoutSec}`);
  await sendText(api, job, `[ralph-runner] 开始迭代 ${job.iteration + 1}：执行 ${job.tool}`);

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

  logger.info(`[ralph-runner][ITER_POST] job=${job.jobId} iter=${job.iteration + 1} step=tool_done`);

  await tryPushIfClean(api, repoRoot, logger);

  const after = computeStoryState(job.repoPath, logger);
  if (!after) {
    logger.error(`[ralph-runner] [${job.jobId}] 无法读取 prd.json`);
    throw new Error("无法读取 prd.json");
  }
  const commit = await git(api, repoRoot, ["log", "-1", "--pretty=%h"])
    .then(r => r && typeof r.stdout === "string" ? r.stdout.trim() : "-")
    .catch(() => "-");

  logger.info(`[ralph-runner] [${job.jobId}] 当前 commit：${commit}`);

  // Validate that the story we attempted is now marked passes=true
  const completedId = before.next.id;
  const wasMarked = after.passesById[completedId] === true;
  if (!wasMarked) {
    logger.error(`[ralph-runner] [${job.jobId}] 该轮执行后 story 未标记完成：${completedId}`);
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

  logger.info(`[ralph-runner][ITER_DONE] job=${job.jobId} iter=${job.iteration} done=${after.done}/${after.total} commit=${commit}`);

  if (!after.next || after.done === after.total) {
    job.status = "completed";
    logger.info(`[ralph-runner][JOB_DONE] job=${job.jobId} total=${after.total} done=${after.done}`);
  }
}

async function runJob(api: OpenClawPluginApi, logger: any, jobs: Map<string, RalphJob>, cancels: Set<string>, job: RalphJob) {
  logger.info(`[ralph-runner][JOB_START] job=${job.jobId} tool=${job.tool} repo=${job.repoPath} maxIterations=${job.maxIterations}`);

  job.status = "running";
  job.updatedAt = nowIso();
  await sendText(api, job, `[ralph-runner] 任务开始：job=${job.jobId} tool=${job.tool} maxIterations=${job.maxIterations}`);

  const failedIterations: number[] = [];
  const prdPathFull = prdPath(job.repoPath);
  let originalPrd: any = null;

  // 备份原始 prd.json
  try {
    if (fs.existsSync(prdPathFull)) {
      originalPrd = fs.readFileSync(prdPathFull, "utf8");
      logger.info(`[ralph-runner] [${job.jobId}] 备份 prd.json`);
    }
  } catch (err: any) {
    logger.error(`[ralph-runner] [${job.jobId}] 备份 prd.json 失败：${err?.message || String(err)}`);
  }

  try {
    while (job.status === "running") {
      if (cancels.has(job.jobId)) {
        job.status = "canceled";
        logger.info(`[ralph-runner] [${job.jobId}] 任务被取消`);
        break;
      }

      const state = computeStoryState(job.repoPath, logger);
      if (!state) {
        job.status = "failed";
        job.lastError = "无法读取 prd.json";
        job.updatedAt = nowIso();
        await sendText(api, job, `执行失败（job=${job.jobId}）：${job.lastError}`);
        break;
      }

      const remaining = state.remaining;
      const cap = job.maxIterations;
      logger.info(`[ralph-runner][JOB_LOOP] job=${job.jobId} iter=${job.iteration + 1} remaining=${remaining} cap=${cap}`);
      if (remaining <= 0 || job.iteration >= cap) {
        job.status = "completed";
        await sendText(api, job, `所有任务完成！total=${state.total} done=${state.done}`);
        break;
      }

      try {
        await runOneStory(api, job, logger);
      } catch (err: any) {
        // 单个任务失败，记录错误但继续执行下一个
        const errorMsg = err?.message || String(err);
        failedIterations.push(job.iteration + 1);
        job.iteration += 1;
        job.updatedAt = nowIso();
        logger.error(`[ralph-runner] [${job.jobId}] 迭代 ${job.iteration} 失败：${errorMsg}`);
        await sendText(api, job, `第 ${job.iteration} 轮失败：${errorMsg}，继续执行下一个任务`);

        // 检查 prd.json 是否损坏，如果是则恢复备份
        if (originalPrd && failedIterations.length >= 3) {
          logger.warn(`[ralph-runner] [${job.jobId}] 失败次数过多，尝试恢复 prd.json`);
          try {
            fs.writeFileSync(prdPathFull, originalPrd, "utf8");
            logger.info(`[ralph-runner] [${job.jobId}] prd.json 已恢复`);
          } catch (restoreErr: any) {
            logger.error(`[ralph-runner] [${job.jobId}] 恢复 prd.json 失败：${restoreErr?.message || String(restoreErr)}`);
          }
        }

        // 避免连续失败导致无限循环，暂停一下
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  } catch (err: any) {
    job.status = "failed";
    job.lastError = err?.message || String(err);
    job.updatedAt = nowIso();
    await sendText(api, job, `执行失败（job=${job.jobId}）：${job.lastError}`);
    logger.error(`[ralph-runner] [${job.jobId}] 严重错误：${job.lastError}`);
  } finally {
    // 清理任务
    if (job.status === "completed" || job.status === "failed" || job.status === "canceled") {
      jobs.delete(job.jobId);
      cancels.delete(job.jobId);
      logger.info(`[ralph-runner] [${job.jobId}] 任务结束，清理完成`);
    }
  }
}

export default function register(api: OpenClawPluginApi) {
  const logger = api.logger;

  logger.info(`[ralph-runner] 插件加载 v${PLUGIN_VERSION}`);

  const MAX_CONCURRENCY = 3;
  const jobs = new Map<string, RalphJob>();
  const cancels = new Set<string>();

  // 注册健康检查方法
  api.registerGatewayMethod("ralph-runner.health", async ({ respond }) => {
    try {
      const running = Array.from(jobs.values()).filter(j => j.status === "running").length;
      const queued = Array.from(jobs.values()).filter(j => j.status === "queued").length;
      respond(true, {
        version: PLUGIN_VERSION,
        running,
        queued,
        total: jobs.size,
        maxConcurrency: MAX_CONCURRENCY,
      });
    } catch (err: any) {
      respond(false, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  function runningCount() {
    let n = 0;
    for (const j of jobs.values()) if (j.status === "running" || j.status === "queued") n += 1;
    return n;
  }

  // Register tool interface (compatible API)
  api.registerTool({
    name: "ralph_runner",
    label: "Ralph Runner",
    description: "Run/list/cancel Ralph jobs. action=run|list|cancel",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["run", "list", "cancel"] },
        repoPath: { type: "string", description: "Repository path (required for action=run)" },
        tool: { type: "string", enum: ["codex", "claude"], description: "Tool for action=run" },
        maxIterations: { type: "number", description: "Max iterations for action=run" },
        jobId: { type: "string", description: "Job ID for action=cancel" },
        channel: { type: "string", description: "回传消息的渠道（如 telegram）" },
        to: { type: "string", description: "回传消息目标（chat id）" },
        accountId: { type: "string", description: "可选账号 id" },
        messageThreadId: { type: "number", description: "可选线程 id" },
      },
      required: ["action"],
    },
    async execute(_toolCallId, params: any) {
      const toResult = (payload: unknown) => ({
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
        details: payload,
      });

      try {
        const action = typeof params?.action === "string" ? params.action : "";

        if (action === "list") {
          const jobList = Array.from(jobs.values()).map((j) => ({
            jobId: j.jobId,
            status: j.status,
            iteration: j.iteration,
            maxIterations: j.maxIterations,
            tool: j.tool,
            repoPath: j.repoPath,
            lastError: j.lastError,
          }));
          return toResult({ success: true, jobs: jobList });
        }

        if (action === "cancel") {
          const jobId = String(params?.jobId ?? "").trim();
          if (!jobId) return toResult({ success: false, message: "缺少 jobId" });
          if (!jobs.has(jobId)) return toResult({ success: false, message: `未找到 job：${jobId}` });
          cancels.add(jobId);
          const job = jobs.get(jobId)!;
          job.status = "canceled";
          job.updatedAt = nowIso();
          return toResult({ success: true, message: `已取消：${jobId}` });
        }

        if (action === "run") {
          const repoPath = String(params?.repoPath ?? "").trim();
          const tool = (String(params?.tool ?? "") as ToolName) || ((api.pluginConfig?.defaultTool as ToolName) ?? "codex");

          if (!repoPath) return toResult({ success: false, message: "缺少参数：repoPath" });
          if (tool !== "codex" && tool !== "claude") {
            return toResult({ success: false, message: `tool 必须是 codex 或 claude，当前=${String(tool)}` });
          }
          if (runningCount() >= MAX_CONCURRENCY) {
            return toResult({ success: false, message: `任务达上限：当前并发上限=${MAX_CONCURRENCY}` });
          }
          if (!fs.existsSync(prdPath(repoPath))) {
            return toResult({ success: false, message: `找不到 prd.json：${prdPath(repoPath)}` });
          }

          const state = computeStoryState(repoPath, logger);
          if (!state || state.remaining <= 0) {
            return toResult({ success: false, message: "没有未完成 story（passes=false 为 0）" });
          }

          const remaining = state.remaining;
          const maxIterationsRaw = params?.maxIterations;
          const maxIterationsParsed = maxIterationsRaw ? Number(maxIterationsRaw) : remaining;
          const effectiveMax = Number.isFinite(maxIterationsParsed) ? Math.max(1, Math.floor(maxIterationsParsed)) : remaining;
          const finalMax = Math.min(remaining, effectiveMax);

          const jobId = `ralph_${Date.now()}_${Math.random().toString(16).slice(2)}`;
          const explicitChannel = typeof params?.channel === "string" && params.channel.trim() ? params.channel.trim() : "";
          const explicitTo = typeof params?.to === "string" && params.to.trim() ? params.to.trim() : "";
          const explicitAccountId = typeof params?.accountId === "string" && params.accountId.trim() ? params.accountId.trim() : undefined;
          const explicitThreadId = Number.isFinite(Number(params?.messageThreadId)) ? Number(params.messageThreadId) : undefined;

          const bound = readCallbackTarget();
          const channel = explicitChannel || bound?.channel || "";
          const to = explicitTo || bound?.to || "";
          const accountId = explicitAccountId ?? bound?.accountId;
          const messageThreadId = explicitThreadId ?? bound?.messageThreadId;

          if (!channel || !to) {
            return toResult({
              success: false,
              message: "缺少 channel/to。可在参数里传 channel=... to=...，或先用 /ralphbind 绑定默认回传目标。",
            });
          }

          const job: RalphJob = {
            version: 1,
            jobId,
            createdAt: nowIso(),
            updatedAt: nowIso(),
            repoPath,
            tool,
            maxIterations: finalMax,
            channel,
            to,
            accountId,
            messageThreadId,
            status: "queued",
            iteration: 0,
          };

          logger.info(`[ralph-runner][JOB_TARGET] job=${jobId} channel=${channel} to=${to} accountId=${accountId ?? "-"} messageThreadId=${messageThreadId ?? "-"}`);

          jobs.set(jobId, job);
          if (!to) {
            logger.warn(`[ralph-runner] job=${jobId} 未提供 to，进度只会写日志不会消息回传`);
          }
          runJob(api, logger, jobs, cancels, job).catch((err) => {
            logger.error(`[ralph-runner] 任务崩溃：${jobId}`, err);
            job.status = "failed";
            job.lastError = err instanceof Error ? err.message : String(err);
            job.updatedAt = nowIso();
            jobs.delete(jobId);
          });

          return toResult({
            success: true,
            jobId,
            message: `[ralph-runner v${PLUGIN_VERSION}] 已启动 job=${jobId} tool=${tool} maxIterations=${finalMax}`,
            callback: to
              ? { enabled: true, channel, to, accountId: accountId ?? null, messageThreadId: messageThreadId ?? null }
              : { enabled: false, reason: "未提供 channel/to，进度仅写入 gateway 日志" },
            progress: { done: state.done, total: state.total, next: state.next ?? null },
          });
        }

        return toResult({ success: false, message: `未知 action：${String(action)}` });
      } catch (err: any) {
        logger.error(`[ralph-runner] tool execute error: ${err?.message || String(err)}`);
        return toResult({ success: false, message: `处理失败：${err?.message || String(err)}` });
      }
    },
  } as AnyAgentTool);

// Keep command interface for backward compatibility and manual use
  api.registerCommand({
    name: "ralphrun",
    description:
      "Run Ralph as a plugin background job (no subagents). Usage: /ralphrun repoPath=... tool=codex|claude maxIterations=10",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: PluginCommandContext) => {
      try {
        logger.info(`[ralph-runner] 命令调用：ralphrun`, { args: ctx.args });

        if (!ctx.args || typeof ctx.args !== "string") {
          logger.error(`[ralph-runner] 无效的命令参数`, { args: ctx.args });
          return { text: "缺少参数。示例：/ralphrun repoPath=/path/to/repo tool=codex maxIterations=10" };
        }

        const kv = parseKvArgs(ctx.args);
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

        const state = computeStoryState(repoPath, logger);
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

        logger.info(`[ralph-runner][JOB_TARGET] job=${jobId} channel=${job.channel} to=${job.to ?? "-"} accountId=${job.accountId ?? "-"} messageThreadId=${job.messageThreadId ?? "-"}`);

        jobs.set(jobId, job);
        logger.info(`[ralph-runner] 任务创建（命令）：${jobId} ${repoPath} ${tool} max=${finalMax}`);

        // 启动任务并添加错误处理
        runJob(api, logger, jobs, cancels, job).catch(err => {
          logger.error(`[ralph-runner] 任务崩溃：${jobId}`, err);
          job.status = "failed";
          job.lastError = err instanceof Error ? err.message : String(err);
          job.updatedAt = nowIso();
          jobs.delete(jobId);
        });

        const next = state.next;
        return {
          text:
            `[ralph-runner v${PLUGIN_VERSION}] ` +
            `已启动 job=${jobId} tool=${tool} maxIterations=${finalMax} done/total=${state.done}/${state.total}` +
            (next ? `\nnext=[${next.id}] ${next.title}` : "\nnext=全部完成"),
        };
      } catch (err: any) {
        logger.error(`[ralph-runner] 命令处理失败：${err?.message || String(err)}`);
        return { text: `处理失败：${err?.message || String(err)}` };
      }
    },
  });

  api.registerCommand({
    name: "ralphjobs",
    description: "List current ralph-runner jobs",
    requireAuth: true,
    handler: async () => {
      logger.info(`[ralph-runner] 命令调用：ralphjobs`);
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
        logger.info(`[ralph-runner] 命令调用：ralphcancel`, { args: ctx.args });

        if (!ctx.args || typeof ctx.args !== "string") {
          logger.error(`[ralph-runner] 无效的命令参数`, { args: ctx.args });
          return { text: "缺少 jobId。示例：/ralphcancel jobId=ralph_xxx" };
        }

        const kv = parseKvArgs(ctx.args);
        const jobId = kv.jobId || kv.id || ctx.args.trim();
        if (!jobId) return { text: "缺少 jobId。示例：/ralphcancel jobId=ralph_xxx" };
        if (!jobs.has(jobId)) return { text: `未找到 job：${jobId}` };
        cancels.add(jobId);
        const job = jobs.get(jobId)!;
        job.status = "canceled";
        job.updatedAt = nowIso();
        logger.info(`[ralph-runner] 任务取消（命令）：${jobId}`);
        return { text: `已取消：${jobId}` };
      } catch (err: any) {
        logger.error(`[ralph-runner] 取消命令失败：${err?.message || String(err)}`);
        return { text: `处理失败：${err?.message || String(err)}` };
      }
    },
  });

  api.registerCommand({
    name: "ralphbind",
    description: "Bind default callback target from current session. Usage: /ralphbind [show|clear]",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: PluginCommandContext) => {
      try {
        const mode = typeof ctx.args === "string" ? ctx.args.trim().toLowerCase() : "";
        if (mode === "show") {
          const current = readCallbackTarget();
          if (!current) return { text: "当前未绑定回传目标。" };
          return { text: `已绑定：channel=${current.channel} to=${current.to}${current.accountId ? ` accountId=${current.accountId}` : ""}${current.messageThreadId != null ? ` messageThreadId=${current.messageThreadId}` : ""}` };
        }
        if (mode === "clear") {
          writeCallbackTarget(null);
          return { text: "已清除 ralph 默认回传绑定。" };
        }

        if (!ctx.channel || !ctx.to) {
          return { text: "当前会话无 channel/to，无法绑定。请改用参数传 channel/to。" };
        }

        const target: CallbackTarget = {
          channel: String(ctx.channel),
          to: String(ctx.to),
          accountId: ctx.accountId,
          messageThreadId: ctx.messageThreadId,
        };
        writeCallbackTarget(target);
        return { text: `已绑定默认回传：channel=${target.channel} to=${target.to}` };
      } catch (err: any) {
        logger.error(`[ralph-runner] ralphbind 失败：${err?.message || String(err)}`);
        return { text: `处理失败：${err?.message || String(err)}` };
      }
    },
  });

  logger.info("[ralph-runner] 插件初始化完成");
}
