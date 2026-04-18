import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const DATA_ROOT = path.join(os.homedir(), '.cursorloop-mcp');
const LOG_DIR = path.join(DATA_ROOT, 'logs');
const MCP_SERVER_DST = path.join(DATA_ROOT, 'index.mjs');
const MCP_CONFIG_PATH = path.join(os.homedir(), '.cursor', 'mcp.json');
const RULES_DIR = path.join(os.homedir(), '.cursor', 'rules');
const RULE_FILE = path.join(RULES_DIR, 'cursorloop.mdc');

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) { fs.mkdirSync(LOG_DIR, { recursive: true }); }
}

function extLog(level: string, msg: string, extra?: Record<string, unknown>) {
  try {
    ensureLogDir();
    const ts = new Date().toISOString();
    const line = `[${ts}] [EXT:${process.pid}] [${level}] ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}\n`;
    fs.appendFileSync(path.join(LOG_DIR, 'extension.log'), line, 'utf-8');
  } catch { /* ignore */ }
}

function rotateExtLogs() {
  try {
    const logFile = path.join(LOG_DIR, 'extension.log');
    if (!fs.existsSync(logFile)) { return; }
    const stat = fs.statSync(logFile);
    if (stat.size > 5 * 1024 * 1024) {
      const backup = path.join(LOG_DIR, 'extension.log.old');
      try { fs.unlinkSync(backup); } catch { /* ignore */ }
      fs.renameSync(logFile, backup);
    }
  } catch { /* ignore */ }
}

// ─── 类型 ────────────────────────────────────────────────────────────────────

interface AttachedFile {
  kind: 'image' | 'pdf' | 'text' | 'binary';
  name: string;
  content?: string;
  mimeType?: string;
}

interface ChatMessage {
  role: 'user' | 'ai';
  content: string;
  timestamp: number;
}

interface Session {
  sessionId: string;
  title: string;
  status: 'waiting' | 'processing' | 'cancelled';
  history: ChatMessage[];
  draft: string;
  lastAiContent: string;
}

type NewRequestPayload = {
  sessionId: string;
  title: string;
  lastResponse: string;
  status: string;
  history: ChatMessage[];
  forceActive?: boolean;
};

// ─── 工具函数 ────────────────────────────────────────────────────────────────

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'tiff']);
const PDF_EXTS = new Set(['pdf']);
const TEXT_EXTS = new Set(['md', 'txt', 'json', 'yaml', 'yml', 'js', 'ts', 'tsx', 'jsx', 'py', 'java', 'c', 'cpp', 'h', 'cs', 'go', 'rs', 'swift', 'kt', 'rb', 'php', 'html', 'css', 'xml', 'sh', 'bash', 'toml', 'ini', 'env', 'sql', 'vue', 'svelte']);

function readFileAsAttachment(filePath: string): AttachedFile {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const name = path.basename(filePath);
  try {
    if (IMAGE_EXTS.has(ext)) {
      const data = fs.readFileSync(filePath);
      const mimeMap: Record<string, string> = { svg: 'image/svg+xml', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', tiff: 'image/tiff' };
      return { kind: 'image', name, content: data.toString('base64'), mimeType: mimeMap[ext] || `image/${ext}` };
    }
    if (PDF_EXTS.has(ext)) {
      const data = fs.readFileSync(filePath);
      return { kind: 'pdf', name, content: data.toString('base64'), mimeType: 'application/pdf' };
    }
    // 文本类型和未知类型都尝试作为文本读取
    return { kind: 'text', name, content: fs.readFileSync(filePath, 'utf-8') };
  } catch {
    return { kind: 'binary', name };
  }
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function responseFile(sid: string): string {
  return path.join(DATA_ROOT, `response-${sid}.json`);
}

function heartbeatFile(sid: string): string {
  return path.join(DATA_ROOT, `heartbeat-${sid}.json`);
}

const HEARTBEAT_STALE_MS = 10000;

function writeResponse(sid: string, data: unknown) {
  ensureDir(DATA_ROOT);
  const file = responseFile(sid);
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf-8');
    fs.renameSync(tmp, file);
    extLog('DEBUG', 'writeResponse done', { sid, file: `response-${sid}.json` });
  } catch (e) {
    extLog('ERROR', 'writeResponse failed with rename, falling back', { sid, error: String(e) });
    try { fs.writeFileSync(file, JSON.stringify(data), 'utf-8'); } catch { }
  }
}

// ─── Webview Provider ────────────────────────────────────────────────────────

class CursorLoopProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _pending: NewRequestPayload[] = [];
  private _sessions = new Map<string, Session>();
  private _activeSessionId: string | null = null;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView) {
    this._view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };
    view.webview.html = this._getHtml(view.webview);

    view.webview.onDidReceiveMessage(msg => {
      const { type, sessionId } = msg;
      if (!sessionId && type !== 'readFile' && type !== 'reconnect') return;
      const session = sessionId ? this._sessions.get(sessionId) : undefined;

      if (type === 'send') {
        const content: string = msg.message?.trim();
        if (!content) return;
        extLog('INFO', 'user send message', { sessionId, msg_len: content.length, prev_status: session?.status });
        if (session) {
          session.history.push({ role: 'user', content, timestamp: Date.now() });
          session.status = 'processing';
          extLog('DEBUG', 'session status -> processing', { sessionId });
        }
        writeResponse(sessionId, { message: content });
        this._post({ type: 'sent', sessionId });
        this._scheduleDeliveryCheck(sessionId);

      } else if (type === 'sendWithFiles') {
        const content: string = msg.message?.trim() || '';
        const attachments = (msg.files || []).map((f: { kind: string; name: string; content?: string; mimeType?: string }) => {
          if (f.kind === 'image' && f.content && f.mimeType) {
            return { type: 'image', name: f.name, mimeType: f.mimeType, data: f.content };
          } else if (f.kind === 'pdf' && f.content) {
            return { type: 'pdf', name: f.name, mimeType: 'application/pdf', data: f.content };
          } else if (f.kind === 'text' && f.content) {
            return { type: 'text', name: f.name, data: f.content };
          }
          return { type: 'binary', name: f.name };
        });
        const historyContent = content
          + (attachments.length ? `\n[附件: ${attachments.map((a: { name: string }) => a.name).join(', ')}]` : '');
        if (session) {
          session.history.push({ role: 'user', content: historyContent, timestamp: Date.now() });
          session.status = 'processing';
        }
        writeResponse(sessionId, { message: content, attachments });
        this._post({ type: 'sent', sessionId });
        this._scheduleDeliveryCheck(sessionId);

      } else if (type === 'setActive') {
        this._activeSessionId = sessionId;

      } else if (type === 'readFile') {
        // webview 请求读取本地文件（来自 Ctrl+V 文件路径粘贴）
        const filePath: string = msg.path;
        if (!filePath) return;
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          this._post({ type: 'fileContent', name: path.basename(filePath), content });
        } catch {
          this._post({ type: 'fileContentError', name: path.basename(filePath) });
        }

      } else if (type === 'cancel') {
        extLog('INFO', 'user cancel session', { sessionId, prev_status: session?.status });
        writeResponse(sessionId, { cancelled: true });
        if (session) session.status = 'cancelled';
        this._post({ type: 'cancelled', sessionId });

      } else if (type === 'reconnect') {
        vscode.commands.executeCommand('composer.resumeCurrentChat').then(
          () => {},
          () => vscode.commands.executeCommand('composer.startComposerPrompt')
        );
      }
    });

    if (this._pending.length > 0) {
      setTimeout(() => {
        for (const req of this._pending) this._post({ type: 'newRequest', ...req });
        this._pending = [];
      }, 300);
    }
  }

  newRequest(sessionId: string, title: string, lastResponse: string) {
    const isNew = !this._sessions.has(sessionId);
    extLog('INFO', 'newRequest', { sessionId, isNew, title, lastResponse_len: (lastResponse || '').length });
    let session = this._sessions.get(sessionId);
    if (!session) {
      session = { sessionId, title, status: 'waiting', history: [], draft: '', lastAiContent: '' };
      this._sessions.set(sessionId, session);
    } else {
      session.title = title;
    }

    const prevStatus = session.status;
    if (lastResponse?.trim() && lastResponse !== session.lastAiContent) {
      session.history.push({ role: 'ai', content: lastResponse, timestamp: Date.now() });
      session.lastAiContent = lastResponse;
    }
    session.status = 'waiting';
    if (prevStatus !== 'waiting') {
      extLog('DEBUG', 'session status -> waiting', { sessionId, prevStatus });
    }

    const payload: NewRequestPayload = {
      sessionId,
      title,
      lastResponse,
      status: 'waiting',
      history: [...session.history],
      forceActive: isNew,
    };

    // 只有全新 session 才抢占焦点，续轮不打扰用户
    if (isNew) {
      this._activeSessionId = sessionId;
      vscode.commands.executeCommand('cursorloopPanel.view.focus');
    }
    if (this._view) {
      this._post({ type: 'newRequest', ...payload });
    } else {
      const idx = this._pending.findIndex(r => r.sessionId === sessionId);
      if (idx >= 0) this._pending[idx] = payload;
      else this._pending.push(payload);
    }
  }

  getSessions(): Session[] {
    return [...this._sessions.values()];
  }

  getActiveSessionId(): string | null {
    return this._activeSessionId;
  }

  addFilesToSession(sessionId: string, files: AttachedFile[]) {
    this._post({ type: 'addFilesToSession', sessionId, files });
  }

  // 检查所有 waiting 状态的 session 的心跳是否过期
  checkHeartbeats() {
    for (const [sid, session] of this._sessions) {
      if (session.status === 'cancelled') continue;

      const hbFile = heartbeatFile(sid);
      let hbExists = false;
      let hbAge = Infinity;
      try {
        if (fs.existsSync(hbFile)) {
          hbExists = true;
          const raw = fs.readFileSync(hbFile, 'utf-8').trim();
          const data = JSON.parse(raw);
          hbAge = Date.now() - data.ts;
        }
      } catch { /* ignore */ }

      if (session.status === 'waiting') {
        if (!hbExists || hbAge > HEARTBEAT_STALE_MS) {
          if (!hbExists) { extLog('WARN', 'heartbeat file missing', { sid }); }
          else { extLog('WARN', 'heartbeat stale', { sid, age_ms: hbAge }); }
          this._post({ type: 'disconnected', sessionId: sid });
        } else {
          this._post({ type: 'connected', sessionId: sid });
        }
      } else if (session.status === 'processing') {
        extLog('DEBUG', 'checkHeartbeats: processing session', { sid, hbExists, hbAge_ms: hbAge === Infinity ? 'N/A' : hbAge });
      }
    }
  }

  private _scheduleDeliveryCheck(sessionId: string) {
    const file = responseFile(sessionId);
    setTimeout(() => {
      if (fs.existsSync(file)) {
        extLog('WARN', 'message not delivered (response file still exists after 8s)', { sessionId });
        this._post({ type: 'messageNotDelivered', sessionId });
      }
    }, 8000);
  }

  private _post(msg: unknown) {
    this._view?.webview.postMessage(msg);
  }

  private _getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview.js')
    );
    return `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${webview.cspSource}; style-src 'unsafe-inline';">
</head>
<body style="margin:0;padding:0;height:100vh;overflow:hidden;">
  <div id="root"></div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}

// ─── 自动安装 ────────────────────────────────────────────────────────────────

function setup(context: vscode.ExtensionContext) {
  ensureDir(DATA_ROOT);

  // 1. 把扩展内打包的 MCP server 复制到 ~/.cursorloop-mcp/
  const bundled = path.join(context.extensionPath, 'mcp-server', 'index.mjs');
  if (fs.existsSync(bundled)) {
    fs.copyFileSync(bundled, MCP_SERVER_DST);
  }

  // 2. 写入 ~/.cursor/mcp.json
  let mcpConfig: Record<string, unknown> = {};
  try {
    if (fs.existsSync(MCP_CONFIG_PATH)) {
      mcpConfig = JSON.parse(fs.readFileSync(MCP_CONFIG_PATH, 'utf-8'));
    }
  } catch { }
  if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};
  (mcpConfig.mcpServers as Record<string, unknown>)['CursorLoop'] = {
    command: 'node',
    args: [MCP_SERVER_DST],
    timeoutMs: 1800000,
  };
  ensureDir(path.dirname(MCP_CONFIG_PATH));
  fs.writeFileSync(MCP_CONFIG_PATH, JSON.stringify(mcpConfig, null, 2), 'utf-8');

  // 3. 写入 ~/.cursor/rules/cursorloop.mdc
  ensureDir(RULES_DIR);
  const rule = `---
description: CursorLoop 持续对话循环规则
globs:
alwaysApply: true
---

你有一个叫 check_messages 的 MCP 工具。

规则：
1. 每轮对话回复**完整输出后**，最后一步必须调用 check_messages，适用于 Agent/Plan/Debug/Ask 所有模式，无一例外。严禁在回合开始时或回复未完成时调用。
2. check_messages 会持续等待直到用户发来新消息；收到后处理并回复，然后再次调用 check_messages，形成永续循环：回复 → check_messages → 收到消息 → 回复 → check_messages。
3. 根据工具返回的内容处理：
   - status 为 "message"：根据 message 字段内容回复用户，然后再次调用 check_messages
   - status 为 "still_waiting"：不要输出任何文字，直接再次调用 check_messages(session_id=上次的id)
   - status 为 "cancelled"：停止调用
4. 调用 check_messages 时传以下参数：
   - session_id：第一次调用时不传，之后每次传上次返回的 session_id。后续所有调用都必须带上此 session_id，这是会话隔离的必要条件。
   - last_response：你刚才回复内容的简短摘要（用于面板展示）。
5. 不允许用文字告诉用户"我要调用工具了"，直接调用。
6. 除非用户明确说结束对话，否则永远不要停止循环。
7. 如果 check_messages 因客户端取消、连接抖动或内部异常而意外返回或报错，且用户未明确要求结束对话，严禁把这类内部提示直接输出给用户，必须立刻再次调用 check_messages(session_id=上次的id) 继续等待。
8. 如果收到 status 为 "superseded"，说明有更新的调用已取代此次调用，不需要任何操作，忽略即可。
9. 严禁并发调用 check_messages：在上一次 check_messages 返回之前，绝对不允许发起新的 check_messages 调用。每次只能有一个 check_messages 在等待。
10. Plan 模式写完方案后、Debug 模式分析完问题后、Ask 模式回答完问题后，均不得直接结束对话，必须调用 check_messages 等待用户反馈。
11. 可以使用 subagent（Task 工具）执行搜索、分析等独立任务，但 check_messages 必须由主 Agent 调用，subagent 不得调用。
`;
  fs.writeFileSync(RULE_FILE, rule, 'utf-8');
}

// ─── 激活入口 ────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  ensureDir(DATA_ROOT);
  rotateExtLogs();
  setup(context);

  const MY_EXT_PID = process.pid;
  extLog('INFO', 'Extension activating', { pid: MY_EXT_PID, ppid: process.ppid, data_root: DATA_ROOT });

  // 启动时只清理超过 2 小时的残留文件，避免误删其他窗口正在使用的文件
  try {
    const TWO_HOURS = 2 * 60 * 60 * 1000;
    const now = Date.now();
    for (const f of fs.readdirSync(DATA_ROOT)) {
      if ((f.startsWith('request-') && f.endsWith('.json')) || f.endsWith('.claimed')) {
        const filePath = path.join(DATA_ROOT, f);
        try {
          const stat = fs.statSync(filePath);
          if (now - stat.mtimeMs > TWO_HOURS) fs.unlinkSync(filePath);
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }

  const provider = new CursorLoopProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('cursorloopPanel.view', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  const handleRequestFile = (file: string) => {
    if (!file.startsWith('request-') || !file.endsWith('.json')) return;
    const src = path.join(DATA_ROOT, file);

    let raw: string;
    try {
      raw = fs.readFileSync(src, 'utf-8').trim();
      if (!raw) return;
    } catch { return; }

    let data: { session_id?: string; title?: string; last_response?: string; ext_pid?: number };
    try {
      data = JSON.parse(raw);
    } catch { return; }

    if (data.ext_pid && data.ext_pid !== MY_EXT_PID) {
      extLog('DEBUG', 'handleRequestFile: skip (ext_pid mismatch)', { file, ext_pid: data.ext_pid, my_pid: MY_EXT_PID });
      return;
    }

    extLog('INFO', 'handleRequestFile: claiming', { file, sid: data.session_id, ext_pid: data.ext_pid, my_pid: MY_EXT_PID });

    const claimed = src + '.claimed';
    try { fs.renameSync(src, claimed); } catch { return; }
    try {
      fs.unlinkSync(claimed);
      provider.newRequest(
        data.session_id || file.replace('request-', '').replace('.json', ''),
        data.title || '新会话',
        data.last_response || '',
      );
    } catch (e) {
      extLog('ERROR', 'handleRequestFile: process error', { file, error: String(e) });
      try { fs.unlinkSync(claimed); } catch { /* ignore */ }
    }
  };

  // fs.watch 监听文件变化（主触发方式）
  ensureDir(DATA_ROOT);
  const watcher = fs.watch(DATA_ROOT, (_event, filename) => {
    if (filename) handleRequestFile(filename);
  });
  context.subscriptions.push({ dispose: () => watcher.close() });

  // 低频 fallback 轮询：macOS kqueue 可能丢事件，5 秒扫一次兜底
  const fallbackTimer = setInterval(() => {
    try {
      const files = fs.readdirSync(DATA_ROOT);
      for (const f of files) handleRequestFile(f);
    } catch { /* ignore */ }
    provider.checkHeartbeats();
  }, 5000);
  context.subscriptions.push({ dispose: () => clearInterval(fallbackTimer) });

  // 命令
  context.subscriptions.push(
    vscode.commands.registerCommand('cursorloopPanel.focus', () => {
      vscode.commands.executeCommand('cursorloopPanel.view.focus');
    }),
    vscode.commands.registerCommand('cursorLoop.setup', () => {
      setup(context);
      vscode.window.showInformationMessage(
        'CursorLoop 配置已更新，请重启 Cursor 生效',
        '立即重启'
      ).then(c => { if (c) vscode.commands.executeCommand('workbench.action.reloadWindow'); });
    }),
    vscode.commands.registerCommand('cursorLoop.addFileToInput', async (uri: vscode.Uri, allUris?: vscode.Uri[]) => {
      const uris = (allUris && allUris.length > 0) ? allUris : (uri ? [uri] : []);
      if (uris.length === 0) return;

      const sessions = provider.getSessions();
      if (sessions.length === 0) {
        vscode.window.showInformationMessage('CursorLoop 还没有活跃的会话，请先让 AI 调用 check_messages 建立连接。');
        return;
      }

      // 确定目标 session
      let targetSessionId: string | null = null;
      if (sessions.length === 1) {
        targetSessionId = sessions[0].sessionId;
      } else {
        // 多 tab：弹出选择器，默认高亮当前活跃的 tab
        const activeId = provider.getActiveSessionId();
        const items = sessions.map(s => ({
          label: s.title,
          description: s.status === 'waiting' ? '等待输入' : s.status === 'processing' ? 'AI 处理中' : '已结束',
          sessionId: s.sessionId,
          picked: s.sessionId === activeId,
        }));
        const picked = await vscode.window.showQuickPick(items, {
          title: '选择要添加文件的会话',
          placeHolder: '选择目标 CursorLoop 会话',
        });
        if (!picked) return;
        targetSessionId = picked.sessionId;
      }

      // 读取文件内容
      const files: AttachedFile[] = [];
      for (const u of uris) {
        files.push(readFileAsAttachment(u.fsPath));
      }

      // 确保面板可见并发送文件
      await vscode.commands.executeCommand('cursorloopPanel.view.focus');
      provider.addFilesToSession(targetSessionId, files);
    })
  );

  // 仅首次安装后自动 focus，后续 activate 不打断用户
  const hasShownKey = 'cursorloop.hasShownPanel';
  if (!context.globalState.get<boolean>(hasShownKey)) {
    context.globalState.update(hasShownKey, true);
    setTimeout(() => vscode.commands.executeCommand('cursorloopPanel.view.focus'), 1500);
  }
}

export function deactivate() {}
