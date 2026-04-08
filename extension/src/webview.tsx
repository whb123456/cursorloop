import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createRoot } from 'react-dom/client';

declare const acquireVsCodeApi: () => {
  postMessage: (msg: unknown) => void;
  getState: () => Record<string, unknown> | undefined;
  setState: (state: unknown) => void;
};
const vscode = acquireVsCodeApi();

// ─── 类型 ────────────────────────────────────────────────────────────────────

interface ChatMessage {
  role: 'user' | 'ai';
  content: string;
  timestamp: number;
}

interface AttachedFile {
  kind: 'image' | 'pdf' | 'text' | 'binary';
  name: string;
  content?: string;
  mimeType?: string;
}

interface Session {
  sessionId: string;
  title: string;
  lastResponse: string;
  status: 'waiting' | 'processing' | 'cancelled';
  history: ChatMessage[];
  draft: string;
}

// ─── 样式 ────────────────────────────────────────────────────────────────────

const css = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body, #root {
    height: 100%;
    overflow: hidden;
  }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
  }
  #root {
    display: flex;
    flex-direction: column;
  }
  .chat-body {
    position: relative;
    flex: 1;
    overflow: hidden;
  }
  .tab-bar {
    display: flex;
    align-items: stretch;
    border-bottom: 1px solid var(--vscode-panel-border);
    background: var(--vscode-editorGroupHeader-tabsBackground);
    flex-shrink: 0;
    overflow-x: auto;
    scrollbar-width: none;
    min-height: 32px;
  }
  .tab-bar::-webkit-scrollbar { display: none; }
  .tab {
    display: flex; align-items: center; gap: 5px;
    padding: 0 10px; height: 32px; font-size: 11px;
    cursor: pointer; white-space: nowrap;
    border-right: 1px solid var(--vscode-panel-border);
    color: var(--vscode-tab-inactiveForeground);
    background: var(--vscode-tab-inactiveBackground);
    flex-shrink: 0; max-width: 160px;
  }
  .tab.active {
    color: var(--vscode-tab-activeForeground);
    background: var(--vscode-tab-activeBackground);
    border-bottom: 2px solid var(--vscode-focusBorder);
  }
  .tab-dot {
    width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
    background: #6c7086;
  }
  .tab-dot.waiting  { background: #4caf50; box-shadow: 0 0 4px #4caf50; }
  .tab-dot.processing { background: #89b4fa; box-shadow: 0 0 4px #89b4fa; }
  .tab-title { overflow: hidden; text-overflow: ellipsis; flex: 1; }
  .tab-close {
    width: 14px; height: 14px; border-radius: 3px;
    display: flex; align-items: center; justify-content: center;
    font-size: 11px; opacity: 0; transition: opacity .1s;
    color: var(--vscode-descriptionForeground);
  }
  .tab:hover .tab-close { opacity: 1; }

  .status-bar {
    padding: 6px 12px; display: flex; align-items: center; gap: 8px;
    border-bottom: 1px solid var(--vscode-panel-border);
    flex-shrink: 0; font-size: 12px;
  }
  .status-dot {
    width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
    background: #6c7086;
  }
  .status-dot.waiting  { background: #4caf50; }
  .status-dot.processing { background: #89b4fa; }

  .messages {
    position: absolute;
    top: 0; left: 0; right: 0; bottom: 0;
    overflow-y: scroll;
    padding: 10px 12px 10px;
    display: flex; flex-direction: column; gap: 8px;
  }
  .msg { display: flex; flex-direction: column; gap: 2px; max-width: 90%; }
  .msg.user { align-self: flex-end; align-items: flex-end; }
  .msg.ai   { align-self: flex-start; align-items: flex-start; }
  .msg-bubble {
    padding: 7px 11px; border-radius: 12px;
    font-size: 12px; line-height: 1.5; word-break: break-word;
    white-space: pre-wrap;
  }
  .msg.user .msg-bubble {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-bottom-right-radius: 3px;
  }
  .msg.ai .msg-bubble {
    background: var(--vscode-input-background);
    color: var(--vscode-foreground);
    border-bottom-left-radius: 3px;
  }
  .msg-time { font-size: 10px; color: var(--vscode-descriptionForeground); padding: 0 2px; }

  .empty {
    position: absolute;
    top: 0; left: 0; right: 0; bottom: 0;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    gap: 12px; padding: 24px; text-align: center;
    color: var(--vscode-descriptionForeground);
  }
  .empty-title { font-size: 13px; font-weight: 600; }
  .empty-desc  { font-size: 11px; line-height: 1.6; }
  .reconnect-btn {
    padding: 5px 14px; border-radius: 4px; border: none; cursor: pointer;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    font-size: 12px;
  }

  .input-area {
    padding: 8px 12px; border-top: 1px solid var(--vscode-panel-border);
    display: flex; flex-direction: column; gap: 6px;
    flex-shrink: 0;
    background: var(--vscode-sideBar-background);
  }
  textarea {
    width: 100%; resize: none; min-height: 58px; max-height: 120px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 4px; padding: 6px 8px; font-size: 12px;
    font-family: inherit; outline: none;
  }
  .btn-row { display: flex; justify-content: flex-end; gap: 6px; }
  .btn {
    padding: 4px 14px; border-radius: 4px; border: none;
    cursor: pointer; font-size: 12px;
  }
  .btn-send {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  .btn-send:disabled { opacity: 0.5; cursor: default; }
  .attach-list {
    display: flex; flex-wrap: wrap; gap: 4px; padding: 0 0 4px;
  }
  .attach-tag {
    display: flex; align-items: center; gap: 4px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    border-radius: 4px; padding: 2px 7px; font-size: 11px;
  }
  .attach-tag-remove {
    cursor: pointer; opacity: 0.7; font-size: 12px;
  }
  .attach-tag-remove:hover { opacity: 1; }
  .btn-attach {
    background: var(--vscode-button-secondaryBackground, #444);
    color: var(--vscode-button-secondaryForeground, #ccc);
  }
`;

// ─── 工具 ────────────────────────────────────────────────────────────────────

function fmtTime(ts: number) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ─── App ─────────────────────────────────────────────────────────────────────

function App() {
  const [sessions, setSessions] = useState<Map<string, Session>>(new Map());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const messagesRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const activeSession = activeId ? sessions.get(activeId) : null;

  // 滚动到底部
  const scrollToBottom = useCallback(() => {
    setTimeout(() => {
      if (messagesRef.current) {
        messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
      }
    }, 50);
  }, []);

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const msg = e.data;

      if (msg.type === 'newRequest') {
        const { sessionId, title, lastResponse, status, history } = msg;
        setSessions(prev => {
          const next = new Map(prev);
          const existing = next.get(sessionId);
          next.set(sessionId, {
            sessionId,
            title,
            lastResponse,
            status: status || 'waiting',
            history: history || existing?.history || [],
            draft: existing?.draft || '',
          });
          return next;
        });
        setActiveId(id => id || sessionId);
        scrollToBottom();
        return;
      }

      if (msg.type === 'sent') {
        setSessions(prev => {
          const next = new Map(prev);
          const s = next.get(msg.sessionId);
          if (s) next.set(msg.sessionId, { ...s, status: 'processing' });
          return next;
        });
        return;
      }

      if (msg.type === 'cancelled') {
        setSessions(prev => {
          const next = new Map(prev);
          const s = next.get(msg.sessionId);
          if (s) next.set(msg.sessionId, { ...s, status: 'cancelled' });
          return next;
        });
      }
    };

    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [scrollToBottom]);

  useEffect(scrollToBottom, [activeSession?.history.length, scrollToBottom]);

  const readFileAsAttachment = useCallback((file: File): Promise<AttachedFile> => {
    return new Promise(resolve => {
      const ext = file.name.split('.').pop()?.toLowerCase() || '';
      const isImage = file.type.startsWith('image/');
      const isPdf = file.type === 'application/pdf' || ext === 'pdf';
      const isText = file.type.startsWith('text/') || ['md', 'txt', 'json', 'yaml', 'yml', 'js', 'ts', 'py', 'java', 'c', 'cpp', 'h', 'cs', 'go', 'rs', 'swift', 'kt', 'rb', 'php', 'html', 'css', 'xml', 'sh', 'bash'].includes(ext);

      if (isImage || isPdf) {
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          const base64 = dataUrl.split(',')[1];
          resolve({ kind: isImage ? 'image' : 'pdf', name: file.name, content: base64, mimeType: file.type || 'application/pdf' });
        };
        reader.onerror = () => resolve({ kind: isImage ? 'image' : 'pdf', name: file.name });
        reader.readAsDataURL(file);
      } else if (isText) {
        const reader = new FileReader();
        reader.onload = () => resolve({ kind: 'text', name: file.name, content: reader.result as string });
        reader.onerror = () => resolve({ kind: 'binary', name: file.name });
        reader.readAsText(file);
      } else {
        resolve({ kind: 'binary', name: file.name });
      }
    });
  }, []);

  const onFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    const attachments = await Promise.all(files.map(readFileAsAttachment));
    setAttachedFiles(prev => [...prev, ...attachments]);
    e.target.value = '';
  }, [readFileAsAttachment]);

  const send = useCallback(() => {
    const text = input.trim();
    if ((!text && attachedFiles.length === 0) || !activeId) return;
    const historyContent = text + (attachedFiles.length ? `\n[附件: ${attachedFiles.map(f => f.name).join(', ')}]` : '');
    if (attachedFiles.length > 0) {
      vscode.postMessage({ type: 'sendWithFiles', sessionId: activeId, message: text, files: attachedFiles });
    } else {
      vscode.postMessage({ type: 'send', sessionId: activeId, message: text });
    }
    // 乐观更新
    setSessions(prev => {
      const next = new Map(prev);
      const s = next.get(activeId);
      if (s) {
        next.set(activeId, {
          ...s,
          status: 'processing',
          history: [...s.history, { role: 'user', content: historyContent, timestamp: Date.now() }],
          draft: '',
        });
      }
      return next;
    });
    setInput('');
    setAttachedFiles([]);
    scrollToBottom();
  }, [input, attachedFiles, activeId, scrollToBottom]);

  const cancel = useCallback(() => {
    if (!activeId) return;
    vscode.postMessage({ type: 'cancel', sessionId: activeId });
  }, [activeId]);

  const closeTab = useCallback((sid: string) => {
    setSessions(prev => {
      const next = new Map(prev);
      next.delete(sid);
      // 在同一次渲染批处理中更新 activeId，使用 prev（已删除后的 Map）
      setActiveId(id => {
        if (id !== sid) return id;
        const remaining = [...next.keys()];
        return remaining[remaining.length - 1] ?? null;
      });
      return next;
    });
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      send();
    }
  };

  const sessionList = [...sessions.values()];

  return (
    <>
      <style>{css}</style>

      {/* Tab 栏 */}
      {sessionList.length > 0 && (
        <div className="tab-bar">
          {sessionList.map(s => (
            <div
              key={s.sessionId}
              className={`tab${s.sessionId === activeId ? ' active' : ''}`}
              onClick={() => setActiveId(s.sessionId)}
            >
              <div className={`tab-dot ${s.status}`} />
              <span className="tab-title">{s.title}</span>
              <span
                className="tab-close"
                onClick={e => { e.stopPropagation(); closeTab(s.sessionId); }}
              >×</span>
            </div>
          ))}
        </div>
      )}

      {/* 状态栏 */}
      {activeSession && (
        <div className="status-bar">
          <div className={`status-dot ${activeSession.status}`} />
          <span style={{ fontSize: 11, color: 'var(--vscode-descriptionForeground)' }}>
            {activeSession.status === 'waiting' ? 'AI 等待输入' :
             activeSession.status === 'processing' ? 'AI 处理中...' : '会话已结束'}
          </span>
        </div>
      )}

      {/* 主体 */}
      {sessionList.length === 0 ? (
        <div className="chat-body">
          <div className="empty">
            <div className="empty-title">等待 AI 连接</div>
            <div className="empty-desc">
              在 Cursor Composer（Agent 模式）中<br />
              让 AI 调用 check_messages 即可建立连接
            </div>
            <button className="reconnect-btn" onClick={() => vscode.postMessage({ type: 'reconnect', sessionId: '' })}>
              打开 Composer
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* 消息历史 — 独立滚动区 */}
          <div className="chat-body">
            <div className="messages" ref={messagesRef}>
              {activeSession?.history.length === 0 && (
                <div style={{ textAlign: 'center', fontSize: 11, color: 'var(--vscode-descriptionForeground)', marginTop: 16 }}>
                  会话已连接，发送消息开始对话
                </div>
              )}
              {activeSession?.history.map((m, i) => (
                <div key={i} className={`msg ${m.role}`}>
                  <div className="msg-bubble">{m.content}</div>
                  <div className="msg-time">{fmtTime(m.timestamp)}</div>
                </div>
              ))}
            </div>
          </div>

          {/* 输入区 — 独立固定在底部 */}
          <div className="input-area">
            <input
              type="file"
              ref={fileInputRef}
              style={{ display: 'none' }}
              multiple
              onChange={onFileChange}
            />
            {attachedFiles.length > 0 && (
              <div className="attach-list">
                {attachedFiles.map((f, i) => (
                  <span key={i} className="attach-tag">
                    {f.name}
                    <span className="attach-tag-remove" onClick={() => setAttachedFiles(prev => prev.filter((_, j) => j !== i))}>×</span>
                  </span>
                ))}
              </div>
            )}
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={
                activeSession?.status === 'waiting'
                  ? '输入消息... (Ctrl+Enter 发送)'
                  : activeSession?.status === 'processing'
                  ? 'AI 处理中，请稍候...'
                  : '会话已结束'
              }
              disabled={!activeSession || activeSession.status !== 'waiting'}
            />
            <div className="btn-row">
              <button
                className="btn btn-attach"
                onClick={() => fileInputRef.current?.click()}
                disabled={!activeSession || activeSession.status !== 'waiting'}
                title="附加文件"
              >
                📎
              </button>
              <button className="btn btn-cancel" onClick={cancel} disabled={!activeSession}>
                结束会话
              </button>
              <button
                className="btn btn-send"
                onClick={send}
                disabled={!activeSession || activeSession.status !== 'waiting' || (!input.trim() && attachedFiles.length === 0)}
              >
                发送
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
