# CursorLoop

Cursor AI 默认每次对话结束后就停了，你必须手动再发一条消息才能继续。CursorLoop 解决这个问题——**让 AI 持续保持等待状态，你随时发消息它随时响应**，不用反复打断工作流去切换输入框。

## 功能

- 侧边栏面板直接发消息，无需切换到 Composer 输入框
- AI 回复后自动进入等待，对话持续不中断
- 面板保留完整聊天历史
- 支持多会话 Tab

## 安装

1. 在 [Releases](https://github.com/your-username/cursorloop/releases) 下载最新 `cursorloop-x.x.x.vsix`
2. Cursor 中按 `Ctrl+Shift+P` → `Install from VSIX` → 选择文件
3. 重启 Cursor

安装后自动完成所有配置，无需手动操作。

## 使用

1. 在 Cursor Composer（**Agent 模式**）发一条消息启动循环，例如：
   > 进入持续对话模式，调用 check_messages 开始
2. 左侧活动栏出现 CursorLoop 图标，点击打开面板
3. 在面板输入框发消息，AI 自动接收并回复

> **推荐使用 Claude 系列模型**（sonnet/opus），循环稳定性明显优于 GPT 系列。

## 开发

```bash
git clone https://github.com/your-username/cursorloop.git
cd cursorloop/extension
npm install
npm run build     # 构建
npm run package   # 打包成 .vsix
```

## License

MIT
