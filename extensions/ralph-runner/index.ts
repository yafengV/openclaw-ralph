import type { OpenClawPluginApi, OpenClawPluginService, PluginCommandContext } from "openclaw/plugin-sdk";
import fs from "node:fs";
import path from "node:path";

type ToolName = "codex" | "claude";

type JobStatus = "queued" | "running" | "paused" | "completed" | "failed" | "canceled";

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

function nowIso() {
  return new Date().toISOString();
}

function parseKvArgs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const token of raw.split(/\s+/).filter(Boolean)) {
    const idx = token.indexOf("=");
    if (idx <= 0) continue;
    const k = token.slice(0, idx).trim();
    const v = token.slice(idx + 1).trim();
    if (!k) continue;
    out[k] = v;
  }
  return out;
}

function readJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, "utf8")) as T;
}

function writeJson(p: string, v: unknown) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2) + "\n", "utf8");
}

function safeBasename(p: string) {
  return path.basename(p).replace(/[^a-zA-Z0-9._-]/g, "_");
}

function prdPath(repoPath: string) {
  return path.join(repoPath, "scripts", "ralph", "prd.json");
}

function progressPath(repoPath: string) {
  return path.join(repoPath, "scripts", "ralph", "progress.txt");
}

function ralphShPath(repoPath: string) {
  return path.join(repoPath, "scripts", "ralph", "ralph.sh");
}

function computeRemainingStories(repoPath: string): { done: number; total: number; next?: { id: string; title: string } } {
  const prd = readJson<any>(prdPath(repoPath));
  const stories = Array.isArray(prd.userStories) ? prd.userStories.slice() : [];
  stories.sort((a, b) => (a.priority ?? 9999) - (b.priority ?? 9999));
  const done = stories.filter((s) => s.passes === true).length;
  const total = stories.length;
  const nextStory = stories.find((s) => s.passes !== true);
  return {
    done,
    total,
    next: nextStory ? { id: String(nextStory.id ?? ""), title: String(nextStory.title ?? "") } : undefined,
  };
}

async function sendToCtx(api: OpenClawPluginApi, job: RalphJob, text: string) {
  if (!job.to) return;

  if (job.channel === "telegram") {
    await api.runtime.telegram.sendMessageTelegram(job.to, text, {
      accountId: job.accountId,
      messageThreadId: job.messageThreadId,
    });
    return;
  }

  if (job.channel === "slack") {
    await api.runtime.slack.sendMessageSlack(job.to, text, {
      accountId: job.accountId,
    });
    return;
  }

  if (job.channel === "discord") {
    await api.runtime.discord.sendMessageDiscord(job.to, text, {
      accountId: job.accountId,
    });
    return;
  }

  if (job.channel === "signal") {
    await api.runtime.signal.sendMessageSignal(job.to, text, {
      accountId: job.accountId,
    });
    return;
  }

  if (job.channel === "imessage") {
    await api.runtime.imessage.sendMessageIMessage(job.to, text, {
      accountId: job.accountId,
    });
    return;
  }

  // best-effort: if unknown channel, do nothing
}

function formatProgressMessage(params: {
  completed?: { id: string; title: string; sessionKey: string; commit: string; done: number; total: number };
  next?: { id: string; title: string; sessionKey: string };
  allDone?: boolean;
}) {
  if (params.allDone) {
    return [
      "已完成：",
      `- 全部完成`,
      `- 完成 story 的 subagent sessionKey：-`,
      `- 结果：commit -，done/total - / -`,
      "",
      "将进行：",
      `- 全部完成`,
      `- 下一个 story 的 subagent sessionKey：-`, 
    ].join("\n");
  }

  const c = params.completed;
  const n = params.next;
  return [
    "已完成：",
    `- [${c?.id}] ${c?.title}`,
    `- 完成 story 的 subagent sessionKey：${c?.sessionKey ?? "-"}`,
    `- 结果：commit ${c?.commit ?? "-"}，done/total ${c?.done ?? "-"} / ${c?.total ?? "-"}`,
    "",
    "将进行：",
    `- [${n?.id}] ${n?.title}`,
    `- 下一个 story 的 subagent sessionKey：${n?.sessionKey ?? "-"}`,
  ].join("\n");
}

function newJobId() {
  return `ralph_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export default function register(api: OpenClawPluginApi) {
  const logger = api.logger;
  const stateDir = api.runtime.state.resolveStateDir();
  const jobsDir = path.join(stateDir, "ralph-runner", "jobs");

  const running: { current?: Promise<void> } = {};

  function jobPath(jobId: string) {
    return path.join(jobsDir, `${jobId}.json`);
  }

  function listJobs(): RalphJob[] {
    if (!fs.existsSync(jobsDir)) return [];
    const files = fs.readdirSync(jobsDir).filter((f) => f.endsWith(".json"));
    const out: RalphJob[] = [];
    for (const f of files) {
      try {
        out.push(readJson<RalphJob>(path.join(jobsDir, f)));
      } catch {
        // ignore corrupt
      }
    }
    out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return out;
  }

  function saveJob(job: RalphJob) {
    job.updatedAt = nowIso();
    writeJson(jobPath(job.jobId), job);
  }

  async function runOneIteration(job: RalphJob) {
    const { done, total, next } = computeRemainingStories(job.repoPath);
    if (!next) {
      job.status = "completed";
      saveJob(job);
      await sendToCtx(api, job, formatProgressMessage({ allDone: true }));
      return;
    }

    // NOTE: In MVP we rely on repo-local scripts/ralph/ralph.sh.
    const sh = ralphShPath(job.repoPath);
    if (!fs.existsSync(sh)) {
      throw new Error(`missing ralph.sh at ${sh} (MVP requirement)`);
    }

    const iterId = `${job.jobId}#${job.iteration + 1}`;

    const beforeCommit = await api.runtime.system.runCommandWithTimeout({
      cmd: `cd ${JSON.stringify(job.repoPath)} && git rev-parse --short HEAD`,
      timeoutMs: 60_000,
    });

    await api.runtime.system.runCommandWithTimeout({
      cmd: `cd ${JSON.stringify(path.join(job.repoPath, "scripts", "ralph"))} && ./ralph.sh --tool ${job.tool} 1`,
      timeoutMs: (api.pluginConfig?.iterationTimeoutSec as number | undefined ?? 1800) * 1000,
    });

    const after = computeRemainingStories(job.repoPath);
    const commit = await api.runtime.system.runCommandWithTimeout({
      cmd: `cd ${JSON.stringify(job.repoPath)} && git log -1 --pretty=%h`,
      timeoutMs: 60_000,
    });

    const completed = {
      id: next.id,
      title: next.title,
      sessionKey: iterId,
      commit: String(commit.stdout ?? "").trim() || String(beforeCommit.stdout ?? "").trim(),
      done: after.done,
      total: after.total,
    };

    const nextStory = after.next;

    job.iteration += 1;
    job.lastCompletedStoryId = completed.id;
    job.lastCompletedCommit = completed.commit;

    if (!nextStory || after.done === after.total) {
      job.status = "completed";
      saveJob(job);
      await sendToCtx(api, job, formatProgressMessage({ completed, next: { id: completed.id, title: "全部完成", sessionKey: "-" }, allDone: false }));
      return;
    }

    saveJob(job);
    const msg = formatProgressMessage({
      completed,
      next: {
        id: nextStory.id,
        title: nextStory.title,
        sessionKey: `${job.jobId}#${job.iteration + 1}`,
      },
    });
    await sendToCtx(api, job, msg);
  }

  async function tick() {
    if (running.current) return;

    const jobs = listJobs();
    const job = jobs.find((j) => j.status === "queued" || j.status === "running");
    if (!job) return;

    running.current = (async () => {
      try {
        if (job.status === "queued") {
          job.status = "running";
          saveJob(job);
        }

        // recompute remaining each tick; cap iterations
        const remaining = computeRemainingStories(job.repoPath).total - computeRemainingStories(job.repoPath).done;
        const cap = Math.min(remaining, job.maxIterations);
        if (job.iteration >= cap) {
          job.status = "paused";
          saveJob(job);
          await sendToCtx(api, job, `已暂停：达到本次上限（iteration=${job.iteration}/${cap}）。如需继续：/ralphrun repoPath=${job.repoPath} tool=${job.tool}`);
          return;
        }

        await runOneIteration(job);
      } catch (err: any) {
        job.status = "failed";
        job.lastError = err?.message || String(err);
        saveJob(job);
        await sendToCtx(api, job, `执行失败：${job.lastError}`);
      } finally {
        running.current = undefined;
      }
    })();
  }

  const service: OpenClawPluginService = {
    id: "ralph-runner-service",
    start: async () => {
      fs.mkdirSync(jobsDir, { recursive: true });
      setInterval(() => {
        tick().catch(() => {});
      }, 3_000).unref?.();

      logger.info("ralph-runner: service started", { jobsDir });
    },
  };

  api.registerService(service);

  api.registerCommand({
    name: "ralphrun",
    description: "Run Ralph iteratively with progress pushed back to this chat. Usage: /ralphrun repoPath=... tool=codex|claude maxIterations=10",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: PluginCommandContext) => {
      const kv = parseKvArgs(ctx.args ?? "");
      const repoPath = kv.repoPath || kv.repo || "";
      if (!repoPath) {
        return { text: "缺少参数：repoPath。示例：/ralphrun repoPath=/path/to/repo tool=codex maxIterations=10" };
      }

      const tool = (kv.tool as ToolName) || ((api.pluginConfig?.defaultTool as ToolName) ?? "codex");
      const maxIterations = Number(kv.maxIterations || kv.iterations || api.pluginConfig?.maxIterationsDefault || 20);

      // compute remaining if user omitted maxIterations
      const remaining = computeRemainingStories(repoPath).remaining;
      const effectiveMax = Number.isFinite(maxIterations) ? Math.max(1, Math.floor(maxIterations)) : remaining;
      const finalMax = Math.max(1, Math.min(remaining || 1, effectiveMax));

      const jobId = newJobId();
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

      // basic preflight
      if (!fs.existsSync(prdPath(repoPath))) {
        return { text: `找不到 prd.json：${prdPath(repoPath)}` };
      }
      if (!fs.existsSync(progressPath(repoPath))) {
        // best effort: don't fail
      }

      saveJob(job);
      await tick();

      const summary = computeRemainingStories(repoPath);
      const next = summary.nextStory;
      return {
        text:
          `已创建任务：${jobId}\n` +
          `repo=${safeBasename(repoPath)} tool=${tool} maxIterations=${finalMax}\n` +
          `done/total=${summary.done}/${summary.total}` +
          (next ? `\nnext=[${next.id}] ${next.title}` : "\nnext=全部完成"),
      };
    },
  });

  api.registerCommand({
    name: "ralphjobs",
    description: "List ralph-runner jobs",
    acceptsArgs: false,
    requireAuth: true,
    handler: async () => {
      const jobs = listJobs();
      if (jobs.length === 0) return { text: "暂无任务。" };
      const lines = jobs.map((j) => `${j.jobId} ${j.status} iter=${j.iteration}/${j.maxIterations} repo=${j.repoPath}`);
      return { text: lines.join("\n") };
    },
  });
}
