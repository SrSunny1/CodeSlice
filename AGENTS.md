# CodeSlice 开发说明

## 结构

- `server/`：Express + TypeScript（tsx 运行），端口 3001
- `web/`：Vite + React + TypeScript，端口 5173，`/api` 代理到 3001

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
- 会话持久化在浏览器 localStorage，键 `codeslice:sessions`；另有 `codeslice:workspaces`、`codeslice:layout`、`codeslice:sidebar`、`codeslice:route`、`codeslice:theme`、`codeslice:detail`。
- 项目跑在 WSL + Windows 盘（/mnt/e）时，Vite 用 `web/vite.config.ts` 里的 `watch.usePolling`、后端 `tsx watch` 用 `CHOKIDAR_USEPOLLING=1` 才能收到文件变更。
- 后端只监听 `127.0.0.1`；`/api/workspace/file` 读文件必须过 `resolveInside` 做目录边界检查。
- 进入段落不再自动请求讲解，由「✦ 生成该段讲解」按钮触发（`web/src/Reader.tsx`）。
