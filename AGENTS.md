# CodeSlice 开发说明

## 结构

- `server/`：Express + TypeScript（tsx 运行），端口 3001
- `web/`：Vite + React + TypeScript，端口 5273，`/api` 代理到 3001

## 常用命令

```bash
npm install        # 安装全部 workspace 依赖
npm run dev        # 同时起 server 和 web（需先配置 .env）
npm test           # 跑 server + web 的 vitest
npm run build      # web 的 tsc --noEmit + vite build
npm run typecheck -w server   # 后端类型检查
npm run typecheck -w web      # 前端类型检查
```

## .env 配置（复制 .env.example 为 .env）

| 变量 | 说明 | 兼容别名 |
| --- | --- | --- |
| `OPENAI_BASE_URL` | OpenAI 兼容接口地址，默认 `https://api.openai.com/v1` | `BASE_URL` |
| `OPENAI_API_KEY` | API Key；不填则必须开 `MOCK_LLM=1` | `DEEPSEEK_API_KEY` / `LLM_API_KEY` / `API_KEY` |
| `OPENAI_MODEL` | 模型名，如 `gpt-4o-mini` | `MODEL` |
| `MOCK_LLM` | 设为 `1` 时不调网络，所有接口返回本地模拟数据 | — |

注意：`.env` 在 `.gitignore` 中，**不要提交**。后端 `llm.ts` 通过 undici `EnvHttpProxyAgent` 自动读取 `HTTP(S)_PROXY`/`NO_PROXY`，并对 429/502/503/504 与超时自动重试 3 次（单次连接 45s 超时）。

## 约定

- 后端切分结果必须经 `server/src/slices.ts` 的 `normalizeSlices` 修正（纯函数，有单测）。
- 前端合并/拆分纯函数在 `web/src/sliceOps.ts`（有单测）。
- 会话持久化在浏览器 localStorage，键 `codeslice:sessions`；另有 `codeslice:workspaces`、`codeslice:layout`、`codeslice:sidebar`、`codeslice:route`、`codeslice:theme`、`codeslice:detail`、`codeslice:summaryDir`（粘贴代码会话的总结保存目录）。
- 每段总结：`POST /api/slice-qa` 逐段单独生成（入参只含本段带行号代码 `code` + 本段 `qaDigestText` 明细，二者至少一个非空）；`POST /api/summary/export` 把 `{name, content}[]` 写入 `<base>/summary/<sub>/`，`sub` 为会话 `filePath`（如 `code.py` → `summary/code.py/01-段名.md` + `README.md`），无 filePath 用会话标题；sub 每级与文件名都经 `sanitizeFilename` 消毒并剔除 `..`。工作区会话 `summaryBaseDir`=项目根，粘贴代码会话首次用 FolderPicker 选目录。结果缓存在 `SessionSlice.qaSummary`。
- 工作区文件左键点击 = 普通打开（`FileView` 预览，不调 AI）；右击文件弹「切分阅读」→ `Route.fileMode:"slice"` 才走读文件+切分流程（已有会话直接进 Reader）。`fileMode` 缺省的旧路由按有无会话推断。`.md` 文件默认渲染预览（可切源码），相对图片走 `GET /api/workspace/asset?root&path`（resolveInside 限界、≤20MB），相对 md 链接可点击跳转。
- 项目跑在 WSL + Windows 盘（/mnt/e）时，Vite 用 `web/vite.config.ts` 里的 `watch.usePolling`、后端 `tsx watch` 用 `CHOKIDAR_USEPOLLING=1` 才能收到文件变更。
- 后端只监听 `127.0.0.1`；`/api/workspace/file` 读文件必须过 `resolveInside` 做目录边界检查。
- 进入段落不再自动请求讲解，由「✦ 生成该段讲解」按钮触发（`web/src/Reader.tsx`）。
- AI 回答的高亮标注存 `ChatMsg.marks`（`TextMark{start,end,color,note?}`），偏移量基于渲染后 textContent；渲染用 CSS Custom Highlight API，不改 DOM，见 `web/src/MarkableMarkdown.tsx`。带备注的标注走 `cs-mark-{色}n` 高亮名并加下划线；同文件导出的 `MarkRail` 是滚动区右侧的标注导航点。浏览器不支持该 API 时标注功能自动隐藏。
- 嵌入式追问存 `ChatMsg.threads`（`InlineThread`，start/end 与 TextMark 同一 textContent 坐标系，blockEnd 是所在块 hast position.end.offset，-1 插到消息末尾）；定位路径 `MsgPath`/`ThreadPath` 与不可变树操作在 `web/src/threads.ts`（有单测）。`MarkableMarkdown` 计算偏移时一律跳过 `.inline-thread` 内的文字，保证追问 UI 不污染坐标；宿主通过 `ThreadCtx` 注入回调，无 provider 时退化为纯渲染。概览页的追问挂在 `Workspace.overviewThreads`/`overviewMarks` 上。
- 索引条（`ChatIndex`）与右缘导航点（`MarkRail`）支持右键删除标注/追问，宿主通过 `onDeleteMark`/`onDeleteThread` 回调落到 `updateMsg`/`removeThread`。
- 各栏 Ctrl+滚轮独立缩放走 `web/src/paneZoom.ts` 的 `usePaneZoom`：原生非 passive wheel 监听 + 元素 `--z` 变量，相关 `font-size` 用 `calc(Npx * var(--z,1))`，系数存 `codeslice:layout` 的 `zCode/zSlices/zChat/zOverview/zSidebar`（0.7–2）。
