import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const DATA_ROOT = path.join(os.homedir(), '.cursorloop-mcp');
const LOG_DIR = path.join(DATA_ROOT, 'logs');
const POLL_INTERVAL_MS = 500;
const HEARTBEAT_INTERVAL_MS = 20000;
const HEARTBEAT_FILE_INTERVAL_MS = 3000;
const EXT_PID = process.ppid;
const MAX_WAIT_MS = 25 * 60 * 1000; // 25 分钟，需小于 mcp.json 中 timeoutMs(30min)

// 每个 sid 当前活跃的 check_messages 调用 epoch（用于取消旧调用）
const activeCallEpoch = new Map();

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function mcpLog(level, msg, extra) {
  try {
    ensureLogDir();
    const ts = new Date().toISOString();
    const line = `[${ts}] [MCP:${process.pid}] [${level}] ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}\n`;
    fs.appendFileSync(path.join(LOG_DIR, 'mcp.log'), line, 'utf-8');
  } catch {}
}

function rotateLogs() {
  try {
    const logFile = path.join(LOG_DIR, 'mcp.log');
    if (!fs.existsSync(logFile)) return;
    const stat = fs.statSync(logFile);
    if (stat.size > 5 * 1024 * 1024) {
      const backup = path.join(LOG_DIR, 'mcp.log.old');
      try { fs.unlinkSync(backup); } catch {}
      fs.renameSync(logFile, backup);
    }
  } catch {}
}

function heartbeatFile(sid) {
  return path.join(DATA_ROOT, `heartbeat-${sid}.json`);
}

function writeHeartbeat(sid) {
  try {
    fs.writeFileSync(heartbeatFile(sid), JSON.stringify({ ts: Date.now(), pid: process.pid }), 'utf-8');
  } catch {}
}

function removeHeartbeat(sid) {
  try { fs.unlinkSync(heartbeatFile(sid)); } catch {}
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function requestFile(sid) {
  return path.join(DATA_ROOT, `request-${sid}.json`);
}

function responseFile(sid) {
  return path.join(DATA_ROOT, `response-${sid}.json`);
}

function newSessionId() {
  return `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sessionTitle() {
  const cwd = process.cwd();
  const base = path.basename(cwd);
  // cwd 可能是 home 或 MCP 数据目录，这种情况用通用标题
  const ws = (cwd === os.homedir() || base === '.cursorloop-mcp') ? 'CursorLoop' : base;
  const now = new Date();
  const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  return `${ws} ${hm}`;
}

function writeRequest(sid, lastResponse) {
  const data = JSON.stringify({ session_id: sid, title: sessionTitle(), last_response: lastResponse || '', ext_pid: EXT_PID });
  const tmp = requestFile(sid) + '.tmp';
  fs.writeFileSync(tmp, data, 'utf-8');
  fs.renameSync(tmp, requestFile(sid));
  mcpLog('DEBUG', 'writeRequest done', { sid, ext_pid: EXT_PID });
}

function tryReadResponse(sid) {
  const file = responseFile(sid);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = fs.readFileSync(file, 'utf-8').trim();
    fs.unlinkSync(file);
    const parsed = JSON.parse(raw);
    mcpLog('DEBUG', 'tryReadResponse: got response file', { sid, cancelled: !!parsed.cancelled, msg_len: (parsed.message || '').length });
    return parsed;
  } catch (e) {
    mcpLog('WARN', 'tryReadResponse: failed to read/parse', { sid, error: String(e) });
    try { fs.unlinkSync(file); } catch { }
    return null;
  }
}

const server = new Server(
  { name: 'cursorloop', version: '2.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'check_messages',
    description: `从 CursorLoop 面板接收用户发送的消息，实现持续对话循环。

工作流程（每轮必须执行）：
1. 调用 check_messages 等待用户输入（首次不传参数）
2. 收到消息后，正常在 Cursor 聊天窗口回复用户
3. 回复完成后，立刻再次调用 check_messages(session_id=<上次的id>)，等待下一条消息
4. 无限重复，直到用户主动结束

注意：check_messages 只是消息传递通道，对话内容照常在 Cursor 聊天窗口展示，不要改变正常的回复行为。`,
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: '会话ID，首次不传，之后每次传入' },
        last_response: { type: 'string', description: '你刚才对用户的回复内容' },
      },
      required: [],
    },
  }],
}));

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: args } = request.params;

  if (name !== 'check_messages') {
    return { content: [{ type: 'text', text: 'unknown tool' }] };
  }

  rotateLogs();
  const isNew = !args?.session_id;
  let sid = args?.session_id || newSessionId();
  const progressToken = request.params._meta?.progressToken;

  // 取消同 sid 的旧调用
  const callEpoch = Date.now();
  const prevEpoch = activeCallEpoch.get(sid);
  activeCallEpoch.set(sid, callEpoch);
  if (prevEpoch) {
    mcpLog('INFO', `cancelling previous call for same sid`, { sid, prev_epoch: prevEpoch, new_epoch: callEpoch });
  }

  mcpLog('INFO', `check_messages called`, { sid, isNew, ext_pid: EXT_PID, ppid: process.ppid, last_response_len: (args?.last_response || '').length, epoch: callEpoch, hasProgressToken: progressToken !== undefined, progressToken: progressToken });

  writeRequest(sid, args?.last_response || '');
  writeHeartbeat(sid);

  const startTime = Date.now();
  let nextHeartbeat = Date.now() + HEARTBEAT_INTERVAL_MS;
  let nextHbFile = Date.now() + HEARTBEAT_FILE_INTERVAL_MS;

  while (true) {
    // 检查是否被同 sid 的新调用取代
    if (activeCallEpoch.get(sid) !== callEpoch) {
      mcpLog('INFO', `call superseded by newer call, exiting loop`, { sid, my_epoch: callEpoch, current_epoch: activeCallEpoch.get(sid) });
      return {
        content: [{ type: 'text', text: JSON.stringify({ session_id: sid, status: 'superseded' }) }],
      };
    }

    if (Date.now() - startTime > MAX_WAIT_MS) {
      mcpLog('WARN', `MAX_WAIT_MS reached (25min), returning still_waiting`, { sid, waited_ms: Date.now() - startTime });
      activeCallEpoch.delete(sid);
      removeHeartbeat(sid);
      return {
        content: [{ type: 'text', text: JSON.stringify({ session_id: sid, status: 'still_waiting' }) }],
      };
    }

    if (Date.now() >= nextHbFile) {
      writeHeartbeat(sid);
      nextHbFile = Date.now() + HEARTBEAT_FILE_INTERVAL_MS;
    }

    const resp = tryReadResponse(sid);
    if (resp !== null) {
      activeCallEpoch.delete(sid);
      removeHeartbeat(sid);
      if (resp.cancelled) {
        mcpLog('INFO', `session cancelled by user`, { sid });
        return { content: [{ type: 'text', text: JSON.stringify({ session_id: sid, status: 'cancelled' }) }] };
      }
      const msg = resp.message || '';
      mcpLog('INFO', `received user message`, { sid, msg_len: msg.length, attachments: (resp.attachments || []).length, waited_ms: Date.now() - startTime });
      const meta = {
        session_id: sid,
        status: 'message',
        message: msg,
        next_action: `回复用户后，立刻调用 check_messages(session_id="${sid}", last_response="<你的回复摘要>")`,
      };
      const content = [{ type: 'text', text: JSON.stringify(meta) }];

      for (const att of (resp.attachments || [])) {
        if (att.type === 'image' && att.data && att.mimeType) {
          content.push({ type: 'image', data: att.data, mimeType: att.mimeType });
        } else if (att.type === 'pdf' && att.data) {
          content.push({
            type: 'resource',
            resource: {
              uri: `file://${att.name}`,
              mimeType: 'application/pdf',
              blob: att.data,
            },
          });
        } else if (att.type === 'text' && att.data) {
          content.push({ type: 'text', text: `\n--- 附件: ${att.name} ---\n${att.data}\n--- 附件结束 ---` });
        }
      }

      mcpLog('INFO', 'returning user message to AI', { sid, content_items: content.length, epoch: callEpoch });
      return { content };
    }

    if (Date.now() >= nextHeartbeat) {
      if (progressToken !== undefined) {
        try {
          await extra.sendNotification({
            method: 'notifications/progress',
            params: { progressToken, progress: 1, total: 100 },
          });
        } catch { }
      }
      nextHeartbeat = Date.now() + HEARTBEAT_INTERVAL_MS;
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
});

ensureDir(DATA_ROOT);
mcpLog('INFO', 'MCP server starting', { pid: process.pid, ppid: process.ppid, ext_pid: EXT_PID, data_root: DATA_ROOT });
const transport = new StdioServerTransport();
await server.connect(transport);
mcpLog('INFO', 'MCP server connected via stdio');
