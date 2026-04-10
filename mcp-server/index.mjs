import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const DATA_ROOT = path.join(os.homedir(), '.cursorloop-mcp');
const POLL_INTERVAL_MS = 500;
const HEARTBEAT_INTERVAL_MS = 20000;
const EXT_PID = process.ppid;
const MAX_WAIT_MS = 4 * 60 * 60 * 1000;

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
}

function tryReadResponse(sid) {
  const file = responseFile(sid);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = fs.readFileSync(file, 'utf-8').trim();
    fs.unlinkSync(file);
    return JSON.parse(raw);
  } catch {
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

  let sid = args?.session_id || newSessionId();
  const progressToken = request.params._meta?.progressToken;

  // 通知扩展展示输入 UI
  writeRequest(sid, args?.last_response || '');

  const startTime = Date.now();
  let nextHeartbeat = Date.now() + HEARTBEAT_INTERVAL_MS;

  while (true) {
    // 超过 MAX_WAIT_MS（10 分钟）还没消息，返回 still_waiting 让 AI 继续调
    if (Date.now() - startTime > MAX_WAIT_MS) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ session_id: sid, status: 'still_waiting', message: '暂无新消息，继续等待中。请立刻再次调用 check_messages(session_id="' + sid + '") 保持连接。' }) }],
      };
    }

    const resp = tryReadResponse(sid);
    if (resp !== null) {
      if (resp.cancelled) {
        return { content: [{ type: 'text', text: JSON.stringify({ session_id: sid, status: 'cancelled' }) }] };
      }
      const msg = resp.message || '';
      const meta = {
        session_id: sid,
        status: 'message',
        message: msg,
        next_action: `回复用户后，立刻调用 check_messages(session_id="${sid}", last_response="<你的回复摘要>")`,
      };
      const content = [{ type: 'text', text: JSON.stringify(meta) }];

      // 把附件作为多模态 content blocks 追加，让 AI 能真正读取内容
      for (const att of (resp.attachments || [])) {
        if (att.type === 'image' && att.data && att.mimeType) {
          content.push({ type: 'image', data: att.data, mimeType: att.mimeType });
        } else if (att.type === 'pdf' && att.data) {
          // PDF 以 resource blob 形式传递，支持 Claude 原生 PDF 解析
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

      return { content };
    }

    // 心跳
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
const transport = new StdioServerTransport();
await server.connect(transport);
