#!/usr/bin/env node
/**
 * run-ralph handler helper
 *
 * Purpose:
 * - Deterministically read PRD progress
 * - Persist resumable state
 * - Render fixed user-facing progress format
 *
 * Usage examples:
 *   node handler.js inspect --repoPath /path/to/repo
 *   node handler.js save-state --repoPath /path --state '{"tool":"codex"}'
 *   node handler.js load-state --repoPath /path
 *   node handler.js clear-state --repoPath /path
 *   node handler.js report \
 *     --completedId US-001 --completedTitle "初始化" \
 *     --completedSessionKey agent:main:subagent:xxx \
 *     --commit abc123 --done 1 --total 6 \
 *     --nextId US-002 --nextTitle "时间范围选择" \
 *     --nextSessionKey agent:main:subagent:yyy
 */

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      out[k] = v;
    } else {
      out._.push(a);
    }
  }
  return out;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function prdPath(repoPath) {
  return path.join(repoPath, 'scripts', 'ralph', 'prd.json');
}

function statePath(repoPath) {
  return path.join(repoPath, 'scripts', 'ralph', 'run-ralph-state.json');
}

function inspect(repoPath) {
  const prd = readJson(prdPath(repoPath));
  const stories = Array.isArray(prd.userStories) ? prd.userStories.slice() : [];
  stories.sort((a, b) => (a.priority ?? 9999) - (b.priority ?? 9999));
  const done = stories.filter(s => s.passes === true).length;
  const total = stories.length;
  const next = stories.find(s => s.passes !== true) || null;
  return {
    project: prd.project || path.basename(repoPath),
    branchName: prd.branchName || null,
    done,
    total,
    remaining: total - done,
    nextStory: next
      ? { id: next.id || '', title: next.title || '', priority: next.priority ?? null }
      : null,
  };
}

function renderReport(args) {
  const completed = args.completedId
    ? `[${args.completedId}] ${args.completedTitle || ''}`.trim()
    : '（无）';
  const next = args.nextId
    ? `[${args.nextId}] ${args.nextTitle || ''}`.trim()
    : '全部完成';

  return [
    '已完成：',
    `- ${completed}`,
    `- 完成 story 的 subagent sessionKey：${args.completedSessionKey || '-'}`,
    `- 结果：commit ${args.commit || '-'}，done/total ${args.done || '-'} / ${args.total || '-'}`,
    '',
    '将进行：',
    `- ${next}`,
    `- 下一个 story 的 subagent sessionKey：${args.nextSessionKey || (args.nextId ? '待启动' : '-')}`,
  ].join('\n');
}

function main() {
  const args = parseArgs(process.argv);
  const cmd = args._[0];

  if (!cmd) {
    console.error('Missing command: inspect|save-state|load-state|clear-state|report');
    process.exit(1);
  }

  if (cmd === 'inspect') {
    if (!args.repoPath) throw new Error('--repoPath is required');
    console.log(JSON.stringify(inspect(args.repoPath), null, 2));
    return;
  }

  if (cmd === 'save-state') {
    if (!args.repoPath) throw new Error('--repoPath is required');
    const p = statePath(args.repoPath);
    const prev = fs.existsSync(p) ? readJson(p) : {};
    const patch = args.state ? JSON.parse(args.state) : {};
    const next = { ...prev, ...patch, updatedAt: new Date().toISOString() };
    writeJson(p, next);
    console.log(JSON.stringify(next, null, 2));
    return;
  }

  if (cmd === 'load-state') {
    if (!args.repoPath) throw new Error('--repoPath is required');
    const p = statePath(args.repoPath);
    if (!fs.existsSync(p)) {
      console.log('{}');
      return;
    }
    console.log(fs.readFileSync(p, 'utf8'));
    return;
  }

  if (cmd === 'clear-state') {
    if (!args.repoPath) throw new Error('--repoPath is required');
    const p = statePath(args.repoPath);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    console.log('OK');
    return;
  }

  if (cmd === 'report') {
    console.log(renderReport(args));
    return;
  }

  throw new Error(`Unknown command: ${cmd}`);
}

try {
  main();
} catch (err) {
  console.error(err.message || String(err));
  process.exit(1);
}
