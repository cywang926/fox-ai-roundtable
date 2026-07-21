# 圓桌・roundtable

A local, dark-themed group chat where **you (cywang)**, **Claude Code CLI** and
**Copilot CLI** share one conversation — not four independent Q&A columns, but an
actual roundtable: you can `@mention` an agent to wake it up, or hand the chair to
Claude so it runs one bounded round with Copilot and reports back. Real tool-calls
(file edits, shell commands) render inline as diff blocks. Everything runs through
your own locally-logged-in CLIs — **no API key needed**, uses your existing
subscriptions.

## 需求

兩個 CLI 都要先安裝並登入：

| AI | CLI | 安裝 |
|---|---|---|
| Claude | [Claude Code](https://claude.com/claude-code) | `brew install claude` 或官網安裝，執行 `claude` 登入 |
| Copilot | [GitHub Copilot CLI](https://github.com/github/copilot-cli) | 安裝 Copilot CLI（`copilot` 指令），第一次執行 `copilot` 依畫面完成登入初始化 |

另外需要 Node.js（任何近期版本皆可，零相依套件）。

## 使用

```bash
node server.js
```

打開 http://localhost:3457 。

- **@mention 才會叫醒 agent**：平常打字只有你（主持人）發言，只有訊息裡 `@claude`、
  `@copilot` 或 `@all` 提到的人才會真的被 dispatch（省 token）。點輸入框上方的
  `@claude` / `@copilot` / `@all` 按鈕可以直接插入
- **交棒給 Claude**：按右上角「交棒給 Claude」，Claude 會代理主持跑一輪
  ——先簡短說明安排，接著 Copilot 獨立回應，最後 Claude 彙整重點——結束後主持棒自動歸還給你。
  過程中隨時可以按主持人狀態列「回場」提前拿回主持棒
- **STOP**：立刻砍掉所有還在執行中的 CLI 行程，主持棒強制歸還
- **⏸ 暫停**：暫停期間不能送出新訊息（已在跑的不受影響）
- 側欄「成員」列出每個人的狀態（閒置／執行中）、角色，以及 Claude 的模型選單；
  Copilot 的 reasoning effort 在輸入框右下角選
- **真的會執行工具**：Claude 用 `--dangerously-skip-permissions`、Copilot 用
  `--allow-all-tools`，兩者都在下方「運作方式」提到的專用資料夾內執行，檔案編輯／
  指令執行的結果會轉成畫面上的 diff 區塊（唯讀操作如 Read/Glob 不佔畫面）
- 支援**接續對話**：Claude 用 `--resume`、Copilot 用 `--session-id`
  記住各自的歷史；每次 dispatch 前，伺服器會把該 agent 尚未看過的圓桌訊息整理成
  回顧文字一起送出，所以即使兩邊是分開的 CLI session，也能跟上彼此說了什麼
- 支援**附加圖片**（📎 按鈕或直接貼上）
- 回答以 Markdown 渲染，支援深色模式（畫面本身就是深色 roundtable 主題，跟隨系統
  淺色模式時會自動切換）
- 介面中英雙語：系統語言是中文時顯示中文，否則顯示英文，側欄右上角可手動切換

## 運作方式

伺服器（[server.js](server.js)，零相依的 Node HTTP server）維護一份共用的對話紀錄
（`state.messages`）與「主持棒」狀態（`state.chair`），而不是各自獨立的 Q&A：

- `claude -p --output-format stream-json --verbose --dangerously-skip-permissions`，
  之後用 `--resume <session_id>` 接續對話。從串流事件裡解析 `tool_use`／
  `tool_result`，把 Edit/Write 轉成 diff 區塊、Bash 轉成指令＋輸出，並讀
  `total_cost_usd` 累計花費
- `copilot --allow-all-tools --output-format json --session-id <id>`，解析
  `tool.execution_start`／`tool.execution_complete` 事件；Copilot 對 `edit` 類工具
  會直接給一段 unified diff（`detailedContent`），拿來當畫面上的區塊內容
- 交棒給 Claude 後，伺服器背景跑一個有界的流程：Claude 簡短說明安排 →
  （系統標記一則 GROUP ROUND）→ Copilot 獨立回應 → Claude 彙整 → 自動把主持棒還給你。
  任何一步失敗、或你提前按「回場」/「STOP」，流程都會安全收尾，不會卡住
- 前端用 `GET /api/state?since=<id>` 輪詢（約每 800ms）取得新訊息與目前主持棒/花費/
  hop 狀態，讓畫面感覺像即時聊天，而不需要 WebSocket

附加圖片時：Copilot 走原生的 `--attachment` 參數；Claude 沒有圖片參數，但是能讀檔的
agent，把圖片路徑寫進 prompt 即可。圖片存在工作資料夾內，重啟伺服器時自動清除。

## 安全性

- 伺服器只綁定 `127.0.0.1`，區網內的其他裝置連不進來
- 兩個 CLI 都在專用的空資料夾 `~/.fox-ai-roundtable` 中執行，限縮 AI agent 能讀取/
  編輯的檔案範圍（不是你的家目錄或這個 repo）
- Claude 用 `--dangerously-skip-permissions`、Copilot 用 `--allow-all-tools`
  跳過互動式的權限確認，讓「交棒代理主持」流程可以無人值守地跑完一輪——這正是
  上面工作資料夾隔離存在的原因，不要把 `WORKSPACE` 改成你不希望 AI 任意編輯的目錄
- 交棒給 Claude 後只會跑「一輪」就自動歸還主持棒，`hopCount`／`HOP_LIMIT` 是避免
  agent 之間無限接力的保險機制
- STOP 按鈕會 `SIGKILL` 所有還在跑的 CLI 行程
- Prompt 以參數陣列傳給 `spawn`、不經過 shell，沒有指令注入風險
- AI 回答經 DOMPurify 消毒後才渲染

## License

MIT
