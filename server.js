#!/usr/bin/env node
// 圓桌：cywang（human 主持人）與 Claude、Copilot CLI 共用同一個對話紀錄。
// 啟動:  node server.js   →  http://localhost:3457

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT) || 3457;
const TIMEOUT_MS = 180_000;
const HOP_LIMIT = 6;
const RECAP_LOOKBACK = 40; // 每次 dispatch 最多回顧幾則歷史訊息

// 避免巢狀 CLI 偵測到彼此的環境變數而行為異常
function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith('CLAUDE') || k.startsWith('ANTHROPIC') || k.startsWith('COPILOT') || k.startsWith('GITHUB_COPILOT')) delete env[k];
  }
  return env;
}

// CLI 的專用工作目錄：限縮 AI agent 能接觸的檔案範圍（不要用家目錄）
const WORKSPACE = path.join(os.homedir(), '.fox-ai-roundtable');
fs.mkdirSync(WORKSPACE, { recursive: true });

// 清掉上次留下的上傳圖片
for (const f of fs.readdirSync(WORKSPACE)) {
  if (/^img-[a-z0-9]+\.(png|jpe?g|webp|gif)$/.test(f)) fs.unlinkSync(path.join(WORKSPACE, f));
}

const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

// 圖片檔名只允許伺服器自己產生的格式，避免路徑穿越
function imagePath(name) {
  if (typeof name === 'string' && /^img-[a-z0-9]+\.(png|jpe?g|webp|gif)$/.test(name)) {
    const p = path.join(WORKSPACE, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Claude 沒有 --image 參數，但是能讀檔的 agent：把路徑寫進 prompt
function promptWithImage(prompt, img) {
  return img ? `附件圖片 / attached image: ${img}\n\n${prompt}` : prompt;
}

function relPath(p) {
  if (typeof p !== 'string') return p;
  return p.startsWith(WORKSPACE) ? p.slice(WORKSPACE.length + 1) : p;
}

// ---------------------------------------------------------------------------
// 圓桌成員與共用狀態
// ---------------------------------------------------------------------------

const MEMBERS = {
  human: { key: 'human', name: 'cywang', role: 'human・決策權', kind: 'human' },
  claude: { key: 'claude', name: 'Claude', role: '顧問・可代理主持', kind: 'agent' },
  copilot: { key: 'copilot', name: 'Copilot CLI', role: '工程・改檔/執行', kind: 'agent' },
};
const AGENT_KEYS = ['claude', 'copilot'];

const MODEL_OPTIONS = {
  claude: ['claude-sonnet-5', 'claude-opus-4-8', 'haiku'],
  copilot: ['low', 'medium', 'high'],
};

function freshState() {
  return {
    chair: 'human',
    epoch: 1,
    hopCount: 0,
    paused: false,
    messages: [],
    nextId: 1,
    sessions: { claude: { id: null, lastSeenId: 0 }, copilot: { id: null, lastSeenId: 0 } },
    spentUsd: 0,
    credits: 0,
    turns: 0,
    busy: { claude: false, copilot: false },
    running: new Set(), // 目前活著的 child process，供 /api/stop 使用
  };
}

let state = freshState();

function pushMessage(msg) {
  const m = {
    id: state.nextId++,
    ts: Date.now(),
    kind: 'chat',
    toolCalls: [],
    mentions: [],
    elapsedMs: null,
    costUsd: 0,
    image: null,
    ...msg,
  };
  state.messages.push(m);
  return m;
}

// 把「這位 agent 上次發言後、圓桌上新增的訊息」整理成回顧文字，讓每家 CLI（各自用
// --resume/--session-id 記得自己的歷史）也能跟上其他人說了什麼。
function buildDispatchPrompt(providerKey, extraNote) {
  const sess = state.sessions[providerKey];
  const missed = state.messages
    .filter((m) => m.kind === 'chat' && m.id > sess.lastSeenId)
    .slice(-RECAP_LOOKBACK);
  const last = state.messages[state.messages.length - 1];
  if (last) sess.lastSeenId = last.id;
  const lines = missed.map((m) => `${MEMBERS[m.speaker].name}: ${m.text}`);
  let prompt = lines.join('\n');
  if (extraNote) prompt = prompt ? `${prompt}\n\n${extraNote}` : extraNote;
  return prompt || null;
}

function run(cmd, args, providerKey) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(cmd, args, { env: cleanEnv(), cwd: WORKSPACE });
    state.running.add(child);
    if (providerKey) state.busy[providerKey] = true;
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.stdin.end();
    const finish = (code) => {
      clearTimeout(timer);
      state.running.delete(child);
      if (providerKey) state.busy[providerKey] = false;
      resolve({ code, stdout, stderr, elapsed: Date.now() - started });
    };
    child.on('error', (err) => { stderr += String(err); finish(-1); });
    child.on('close', finish);
  });
}

// ---------------------------------------------------------------------------
// Tool-call 解析：把 CLI 真正執行的檔案編輯/指令轉成畫面上的區塊
// ---------------------------------------------------------------------------

function diffFromStrings(oldStr, newStr) {
  const oldLines = (oldStr ?? '').split('\n').map((l) => '-' + l);
  const newLines = (newStr ?? '').split('\n').map((l) => '+' + l);
  return oldLines.concat(newLines).join('\n');
}

function formatClaudeToolCall(call, result) {
  const { name, input } = call;
  const isError = !!result.is_error;
  const resultText = typeof result.content === 'string' ? result.content : JSON.stringify(result.content ?? '');
  if (name === 'Edit' && typeof input.old_string === 'string') {
    return {
      label: `edit · ${relPath(input.file_path)}`,
      command: null,
      diff: diffFromStrings(input.old_string, input.new_string),
      output: isError ? resultText.slice(0, 2000) : '',
      status: isError ? 'error' : 'ok',
    };
  }
  if (name === 'Write' && typeof input.content === 'string') {
    return {
      label: `write · ${relPath(input.file_path)}`,
      command: null,
      diff: input.content.split('\n').map((l) => '+' + l).join('\n'),
      output: isError ? resultText.slice(0, 2000) : '',
      status: isError ? 'error' : 'ok',
    };
  }
  if (name === 'Bash') {
    return {
      label: `run · ${input.command}`,
      command: input.command,
      diff: '',
      output: resultText.slice(0, 4000),
      status: isError ? 'error' : 'ok',
    };
  }
  return null; // Read/Glob/Grep 等唯讀工具不佔畫面
}

const COPILOT_VISIBLE_TOOLS = new Set(['edit', 'shell', 'bash', 'create']);

// ---------------------------------------------------------------------------
// Provider 呼叫：真的執行 CLI，並把 tool-call 事件轉成畫面用的結構
// ---------------------------------------------------------------------------

const providers = {
  async claude(promptText, img, opts) {
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
    if (opts?.model) args.push('--model', opts.model);
    const sess = state.sessions.claude;
    if (sess.id) args.push('--resume', sess.id);
    args.push(promptWithImage(promptText, img));
    const r = await run('claude', args, 'claude');

    let answer = '', costUsd = 0;
    const toolCalls = [];
    const pendingCalls = new Map();
    for (const line of r.stdout.split('\n')) {
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === 'assistant') {
        for (const c of ev.message?.content || []) {
          if (c.type === 'tool_use') pendingCalls.set(c.id, c);
        }
      } else if (ev.type === 'user') {
        for (const c of ev.message?.content || []) {
          if (c.type === 'tool_result' && pendingCalls.has(c.tool_use_id)) {
            const call = pendingCalls.get(c.tool_use_id);
            pendingCalls.delete(c.tool_use_id);
            const block = formatClaudeToolCall(call, c);
            if (block) toolCalls.push(block);
          }
        }
      } else if (ev.type === 'result') {
        answer = (ev.result || '').trim();
        costUsd = ev.total_cost_usd || 0;
        if (ev.session_id) sess.id = ev.session_id;
      }
    }
    return { answer: answer || r.stderr.trim(), toolCalls, costUsd, elapsed: r.elapsed };
  },

  async copilot(promptText, img, opts) {
    const sess = state.sessions.copilot;
    if (!sess.id) sess.id = crypto.randomUUID();
    const args = ['--allow-all-tools', '--no-color', '--session-id', sess.id, '--output-format', 'json'];
    if (opts?.model) args.push('--reasoning-effort', opts.model);
    if (img) args.push('--attachment', img);
    args.push('-p', promptText);
    const r = await run('copilot', args, 'copilot');

    let answer = '', credits = 0;
    const toolCalls = [];
    const byId = new Map();
    for (const line of r.stdout.split('\n')) {
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === 'assistant.message' && typeof ev.data?.content === 'string') {
        answer = ev.data.content.trim();
      } else if (ev.type === 'tool.execution_start') {
        const toolName = (ev.data.toolName || '').toLowerCase();
        if (!COPILOT_VISIBLE_TOOLS.has(toolName)) continue;
        const argPath = relPath(ev.data.arguments?.path);
        const block = { label: `${toolName} · ${argPath || ''}`.trim(), command: toolName === 'shell' || toolName === 'bash' ? (ev.data.arguments?.command || '') : null, diff: '', output: '', status: 'running' };
        byId.set(ev.data.toolCallId, block);
        toolCalls.push(block);
      } else if (ev.type === 'tool.execution_complete') {
        const block = byId.get(ev.data.toolCallId);
        if (!block) continue;
        block.status = ev.data.success ? 'ok' : 'error';
        const detail = ev.data.result?.detailedContent || '';
        if (detail.includes('diff --git')) block.diff = detail.trim().slice(0, 6000);
        else block.output = (ev.data.result?.content || '').slice(0, 2000);
      } else if (ev.type === 'result') {
        credits = ev.usage?.premiumRequests || 0;
      }
    }
    return { answer: answer || r.stderr.trim(), toolCalls, credits, elapsed: r.elapsed };
  },
};

async function dispatch(providerKey, extraNote, image, opts) {
  const promptText = buildDispatchPrompt(providerKey, extraNote);
  if (promptText === null) return null; // 沒有新東西可以回應，不叫醒這個 agent
  const r = await providers[providerKey](promptText, image, opts);
  state.turns++;
  if (r.costUsd) state.spentUsd += r.costUsd;
  if (r.credits) state.credits += r.credits;
  return pushMessage({
    speaker: providerKey,
    kind: 'chat',
    text: r.answer || '（沒有回覆內容）',
    toolCalls: r.toolCalls || [],
    elapsedMs: r.elapsed,
    costUsd: r.costUsd || 0,
  });
}

// ---------------------------------------------------------------------------
// 主持人交棒／GROUP ROUND
// ---------------------------------------------------------------------------

async function runMentionDispatch(mentionList, image, opts) {
  for (const key of mentionList) {
    if (!AGENT_KEYS.includes(key)) continue;
    try {
      await dispatch(key, null, image, opts?.[key]);
    } catch (err) {
      pushMessage({ kind: 'system', text: `⚠ ${MEMBERS[key].name} 執行失敗：${String(err).slice(0, 300)}` });
    }
  }
}

async function runHandoffChain(epochAtStart, opts) {
  const stillValid = () => state.chair === 'claude' && state.epoch === epochAtStart;
  try {
    if (!stillValid()) return;
    await dispatch('claude', 'cywang 把主持棒交給你了。用一兩句話簡短說明你打算怎麼安排這一輪，然後我會請 Copilot 接著回應，你不用等它回覆。', null, opts?.claude);

    if (!stillValid()) return;
    pushMessage({ kind: 'system', text: '▸ GROUP ROUND · Copilot 獨立回應本輪（不中途互踩）' });

    if (!stillValid()) return;
    await dispatch('copilot', null, null, opts?.copilot);

    if (!stillValid()) return;
    await dispatch('claude', 'Copilot 這輪回覆完了。請簡短彙整重點，並標示任何需要 cywang 回來決定的事項。', null, opts?.claude);
  } catch (err) {
    pushMessage({ kind: 'system', text: `⚠ 代理主持過程發生錯誤：${String(err).slice(0, 300)}` });
  } finally {
    if (state.epoch === epochAtStart) {
      pushMessage({ kind: 'system', text: 'cywang 回場・主持棒歸還' });
      state.chair = 'human';
      state.hopCount = 0;
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); }
    });
  });
}

function publicState(sinceId) {
  return {
    ok: true,
    members: MEMBERS,
    chair: state.chair,
    epoch: state.epoch,
    hopCount: state.hopCount,
    hopLimit: HOP_LIMIT,
    paused: state.paused,
    spentUsd: state.spentUsd,
    credits: state.credits,
    turns: state.turns,
    busy: state.busy,
    messages: state.messages.filter((m) => m.id > sinceId),
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/image/')) {
    const name = url.pathname.slice('/api/image/'.length);
    const p = imagePath(name);
    if (!p) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(p).slice(1).toLowerCase();
    const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'max-age=86400' });
    res.end(fs.readFileSync(p));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/state') {
    const since = Number(url.searchParams.get('since')) || 0;
    return json(res, 200, publicState(since));
  }

  if (req.method === 'POST' && url.pathname === '/api/upload') {
    const ext = IMAGE_TYPES[req.headers['content-type']];
    if (!ext) return json(res, 400, { ok: false, error: '不支援的圖片格式 / unsupported image type' });
    const chunks = [];
    let size = 0;
    req.on('data', (d) => {
      size += d.length;
      if (size > MAX_IMAGE_BYTES) { req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => {
      const name = `img-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.${ext}`;
      fs.writeFileSync(path.join(WORKSPACE, name), Buffer.concat(chunks));
      json(res, 200, { ok: true, file: name });
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/send') {
    const { text, mentions, image, opts } = await readBody(req);
    if (typeof text !== 'string' || !text.trim()) {
      return json(res, 400, { ok: false, error: 'text 不可為空 / text required' });
    }
    if (state.chair !== 'human') {
      return json(res, 409, { ok: false, error: '主持棒目前在 agent 手上，請先「回場」/ chair is held by an agent' });
    }
    if (state.paused) return json(res, 409, { ok: false, error: '已暫停 / paused' });
    const mentionList = Array.isArray(mentions) ? mentions.filter((m) => AGENT_KEYS.includes(m)) : [];
    for (const key of mentionList) {
      if (opts?.[key]?.model && !MODEL_OPTIONS[key].includes(opts[key].model)) {
        return json(res, 400, { ok: false, error: `${key} 的模型不在允許清單 / model not allowed` });
      }
    }
    const img = image ? imagePath(image) : null;
    if (image && !img) return json(res, 400, { ok: false, error: '圖片不存在 / image not found' });

    pushMessage({ speaker: 'human', kind: 'chat', text: text.trim(), mentions: mentionList, image });
    json(res, 200, { ok: true });
    runMentionDispatch(mentionList, img, opts).catch((err) => {
      pushMessage({ kind: 'system', text: `⚠ dispatch 失敗：${String(err).slice(0, 300)}` });
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/handoff') {
    const { to, opts } = await readBody(req);
    if (to !== 'claude') return json(res, 400, { ok: false, error: '目前只有 Claude 能代理主持 / only Claude can chair' });
    if (state.chair !== 'human') return json(res, 409, { ok: false, error: '主持棒已經不在你手上 / chair already handed off' });
    if (state.paused) return json(res, 409, { ok: false, error: '已暫停 / paused' });
    pushMessage({ kind: 'system', text: 'cywang 離場・主持棒 → Claude 代理主持' });
    state.chair = 'claude';
    state.epoch++;
    state.hopCount = 1;
    json(res, 200, { ok: true });
    runHandoffChain(state.epoch, opts).catch((err) => {
      pushMessage({ kind: 'system', text: `⚠ handoff 失敗：${String(err).slice(0, 300)}` });
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/reclaim') {
    if (state.chair === 'human') return json(res, 200, { ok: true });
    pushMessage({ kind: 'system', text: 'cywang 回場・主持棒歸還（提前）' });
    state.chair = 'human';
    state.epoch++; // 讓還在跑的 handoff chain 的 stillValid() 檢查失敗，優雅收尾
    state.hopCount = 0;
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/stop') {
    for (const child of state.running) child.kill('SIGKILL');
    state.epoch++; // 讓還在跑的 handoff chain 停止繼續往下走
    if (state.chair !== 'human') {
      pushMessage({ kind: 'system', text: '⏹ STOP：cywang 強制回場' });
      state.chair = 'human';
      state.hopCount = 0;
    }
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/pause') {
    const { paused } = await readBody(req);
    state.paused = !!paused;
    return json(res, 200, { ok: true, paused: state.paused });
  }

  if (req.method === 'POST' && url.pathname === '/api/reset') {
    for (const child of state.running) child.kill('SIGKILL');
    state = freshState();
    return json(res, 200, { ok: true });
  }

  res.writeHead(404); res.end('Not found');
});

// 只綁定本機：避免區網裡的其他人使用你的訂閱額度或透過 AI 讀取檔案
server.listen(PORT, '127.0.0.1', () => {
  console.log(`圓桌已啟動： http://localhost:${PORT}`);
});
