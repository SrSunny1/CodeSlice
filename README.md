# CodeSlice

把整段代码丢给 AI 追问时，对话越拉越长，后面的问题容易被淹没。CodeSlice 把代码按逻辑切成若干段（slice），**每段一个独立对话**：看不懂就在当前段里追问，读懂一段再进下一段。也可以直接打开整个项目文件夹，先看 AI 生成的项目概览，再逐文件分段阅读。

## 最省事的用法：丢给你的 AI Agent

如果你电脑上装着任何编程 Agent——Codex、Claude Code、OpenCode、WorkBuddy、DeepSeek Harness、Devin……下面的安装步骤都不用看，直接对它说：

> 去 GitHub 搜索 CodeSlice 项目下载下来（<https://github.com/SrSunny1/CodeSlice>），向我说明项目功能和具体使用方法。

它会自己 clone 仓库、装依赖、帮你配 `.env`、启动服务，并把功能用法讲给你。

## 功能

- **文件夹工作区**：图形化选择文件夹 → 文件树 + AI 项目概览（能做什么、技术栈、模块划分、建议阅读顺序，可继续追问）
- **AI 按逻辑切分代码**（import 区、函数、类、主流程等），自动修正为首尾相接、完整覆盖；支持手动合并、拆分、重新切分
- **每段独立对话**：点击「生成该段讲解」出概览，之后随意追问，流式输出可中止；点行号 / Shift+点行号可选中几行单独提问
- **讲解带上项目背景**：工作区里读文件时，AI 会参考项目概览回答
- Codex 风格界面：可收起/拉伸的左侧栏（工作区 + 片段列表）、左右分栏可拖拽、亮/暗双主题、段落列表可折叠
- 全部读懂后一键生成全文总结（含根据你的提问归纳的易错点）
- 所有会话存在浏览器本地，关掉再打开可以继续读

## 运行要求

- Node.js ≥ 20
- 一个 OpenAI 兼容 API 的 Key（DeepSeek、智谱 GLM、OpenAI、Kimi 等均可；没有 Key 也可以用内置模拟模式体验）

## 手动安装与启动

```bash
npm install
cp .env.example .env   # 然后填入你的配置
npm run dev
```

浏览器打开 <http://localhost:5173>。

## 配置（.env）

| 变量 | 说明 | 兼容别名 |
| --- | --- | --- |
| `OPENAI_BASE_URL` | OpenAI 兼容接口地址，默认 `https://api.openai.com/v1` | `BASE_URL` |
| `OPENAI_API_KEY` | API Key；不填则必须开 `MOCK_LLM=1` | `DEEPSEEK_API_KEY` / `LLM_API_KEY` / `API_KEY` |
| `OPENAI_MODEL` | 模型名 | `MODEL` |
| `MOCK_LLM` | 设为 `1` 时不调网络，所有接口返回本地模拟数据 | — |

说明：

- **免费模型推荐**（都是 OpenAI 兼容，改 `.env` 三行即可）：

  | 平台 | BASE_URL | 推荐 MODEL | 说明 |
  | --- | --- | --- | --- |
  | 阿里心流 iFlow | `https://apis.iflow.cn/v1` | `DeepSeek-V3.2` / `Qwen3-Coder` / `KIMI-K2` | 个人用户免费，可选的都是旗舰级模型（模型 ID 到 platform.iflow.cn/models 复制）；并发限 1，对本工具够用 |
  | 智谱 BigModel | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` | 官方长期免费、稳定；另有推理型 `glm-4.7-flash` 也免费，但回答前会先生成一大段思考过程，高峰期易 429 |
  | DeepSeek 官方 | `https://api.deepseek.com/v1` | `deepseek-flash` | 不免费但极便宜，响应快 |
- 后端会自动读取 `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` 环境变量走代理，无需额外配置。
- 遇到上游 503/超时，后端会自动重试最多 3 次。
- 后端只监听 `127.0.0.1`，且读文件有目录边界检查，不会把文件系统暴露到局域网。

## Windows 桌面启动器（可选）

`launcher/` 里有针对 WSL 用户的 `CodeSlice.bat` 和图标：双击即可启动服务并打开浏览器。如果你的 WSL 发行版名或项目路径不同，改一下 `.bat` 里对应的两处，再把 `.lnk` 快捷方式放桌面。

## 开发

```bash
npm run dev          # 前后端一起起（server:3001 / web:5173）
npm test             # server + web 的全部 vitest
npm run build        # web 生产构建
npm run typecheck -w server   # 或 -w web，类型检查
```

更多实现细节见 `AGENTS.md`。

## License

[MIT](LICENSE)
