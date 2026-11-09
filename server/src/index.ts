import express from "express";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { normalizeSlices, type Slice } from "./slices.js";
import {
  browseDir,
  collectOverviewContext,
  listTree,
  readProjectFile,
  resolveInside,
  toLocalPath,
  treeToText,
} from "./workspace.js";
import {
  chatCompletion,
  chatCompletionStream,
  isMock,
  llmConfigError,
  mockStream,
  type ChatMessage,
} from "./llm.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const app = express();
app.use(express.json({ limit: "2mb" }));

const MOCK_ANSWER = `这段代码是一个**示例片段**（MOCK_LLM 模拟回答）。

它主要做了三件事：

1. 准备输入数据；
2. 调用核心逻辑处理；
3. 返回或打印结果。

> 新手常见卡点：注意变量的作用域，以及循环里下标从 0 还是从 1 开始。

\`\`\`python
for i in range(3):
    print(i)  # 输出 0, 1, 2
\`\`\`

如果还有不懂的地方，可以选中具体几行继续问。`;

function codeWithLineNumbers(code: string): string {
  return code
    .split("\n")
    .map((l, i) => `${i + 1}: ${l}`)
    .join("\n");
}

function sliceCode(code: string, s: Slice): string {
  const lines = code.split("\n");
  return lines
    .slice(s.startLine - 1, s.endLine)
    .map((l, i) => `${s.startLine + i}: ${l}`)
    .join("\n");
}

/** 总结文件名消毒：去掉路径分隔与非法字符，防目录逃逸。 */
function sanitizeFilename(name: string): string {
  return path
    .basename(name)
    .replace(/[\\\/:*?"<>|\x00-\x1f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

interface ProjectContext {
  name?: string;
  filePath?: string;
  overview?: string;
}

function projectContextText(ctx: ProjectContext | undefined): string {
  if (!ctx || typeof ctx !== "object" || !ctx.name) return "";
  const head = `这个文件属于项目「${ctx.name}」，路径为 ${ctx.filePath ?? "未知"}。`;
  const ov = typeof ctx.overview === "string" ? ctx.overview.slice(0, 4000) : "";
  return ov
    ? `${head}\n项目概览如下（仅作背景，帮助你结合项目整体来讲解）：\n${ov}`
    : head;
}

// ---------- POST /api/slice ----------
app.post("/api/slice", async (req, res) => {
  const { code, language, projectContext } = req.body ?? {};
  if (typeof code !== "string" || !code.trim()) {
    return res.status(400).json({ error: "请提供要切分的代码（code 不能为空）。" });
  }
  const totalLines = code.split("\n").length;

  if (isMock()) {
    // 按空行 / 函数定义做简单切分
    const lines = code.split("\n");
    const raw: { startLine: number; endLine: number; title: string }[] = [];
    let start = 1;
    const push = (end: number) => {
      if (end >= start) {
        const first = lines[start - 1].trim();
        raw.push({
          startLine: start,
          endLine: end,
          title: /^import|^from|^#include|^package|^using/.test(first)
            ? "导入与声明"
            : /^def |^function |^class |^func |^fn |^void |^int |^public/.test(first)
              ? first.slice(0, 24)
              : `第 ${raw.length + 1} 段`,
        });
      }
    };
    const isBoundary = (i: number) =>
      lines[i].trim() === "" ||
      /^(def |function |class |func |fn |public |private |void |int |main\b)/.test(
        lines[i].trim()
      );
    for (let i = 1; i < lines.length; i++) {
      if (isBoundary(i) && i - start + 1 >= 4) {
        push(i);
        start = i + 1;
        while (start <= lines.length && lines[start - 1].trim() === "") start++;
      }
    }
    push(lines.length);
    return res.json({
      purpose: "（模拟）这段代码按逻辑分成若干段，便于逐段阅读。",
      slices: normalizeSlices(JSON.stringify(raw), totalLines),
    });
  }

  const err = llmConfigError();
  if (err) return res.status(500).json({ error: err });

  // 先让模型概括整段代码的用途，供切分标题与后续问答对齐项目语境；
  // 概括失败不阻塞切分。
  let purpose = "";
  try {
    purpose = (
      await chatCompletion([
        {
          role: "system",
          content:
            "用 1–2 句简体中文概括这段代码整体在做什么，面向编程新手，只输出概括文字，不要列表。" +
            (projectContextText(projectContext) ? `\n${projectContextText(projectContext)}` : ""),
        },
        { role: "user", content: `语言：${language || "未知"}\n代码：\n${code.slice(0, 8000)}` },
      ])
    )
      .trim()
      .slice(0, 200);
  } catch {
    // ignore
  }

  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "你是代码分段助手。把用户给出的代码按逻辑块切分（import 区、函数、类、主流程、较大的循环等），" +
        "每段约 5–40 行。只输出 JSON 数组，形如 [{\"startLine\":1,\"endLine\":8,\"title\":\"标题\",\"role\":\"一句话说明这段的职责、输入从哪来、产出交给谁\"}]。" +
        "行号从 1 开始、两端都包含，所有段加起来必须覆盖全部行。" +
        (purpose ? `\n这段代码的整体用途是：${purpose}。` : "") +
        "title 用中文且简短；若该段主体是某个函数、类或变量，标题必须带上具体名字，" +
        "形如「agent_loop 核心循环」「run_bash 工具执行」「TOOL_DEFINITIONS 工具定义」。不要输出任何其他文字。" +
        (projectContextText(projectContext) ? `\n${projectContextText(projectContext)}` : ""),
    },
    {
      role: "user",
      content: `语言：${language || "未知"}\n代码（共 ${totalLines} 行）：\n${codeWithLineNumbers(code)}`,
    },
  ];
  try {
    const out = await chatCompletion(messages);
    res.json({ purpose, slices: normalizeSlices(out, totalLines) });
  } catch (e) {
    res.status(500).json({ error: `切分失败：${(e as Error).message}` });
  }
});

// ---------- POST /api/chat ----------
app.post("/api/chat", async (req, res) => {
  const { code, language, slice, understoodTitles, messages, selection, projectContext, codePurpose, detail, slices } = req.body ?? {};
  if (!code || !slice || !Number.isFinite(slice.startLine)) {
    return res.status(400).json({ error: "缺少 code 或 slice 参数。" });
  }
  const err = llmConfigError();
  if (err) return res.status(500).json({ error: err });

  const s: Slice = { id: slice.id ?? "", startLine: slice.startLine, endLine: slice.endLine, title: slice.title ?? "" };
  const history: { role: "user" | "assistant"; content: string }[] = Array.isArray(messages) ? messages : [];
  const understood: string[] = Array.isArray(understoodTitles) ? understoodTitles : [];

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");

  if (isMock()) {
    await mockStream(MOCK_ANSWER, (t) => res.write(t));
    return res.end();
  }

  const deep = detail !== "brief";
  const BRIEF_RULE =
    "规则：以当前这一段为中心，只回答用户当前这个问题，简洁（一般不超过 6 句）；涉及其他段落时用一句话点明关系并给出行号即可；必要时给一两行小例子。";
  const DEEP_RULE = [
    "规则：",
    "1. 以当前这一段为中心，但问题涉及「谁调用它 / 结果给谁用 / 数据从哪来到哪去 / 为什么这样写」时，必须结合上面的完整代码追踪上下游，并标注具体行号（如「第 9 行」）。",
    "2. 回答结构：先用一句话给出直接结论；再讲调用链或数据流（可用 `A → B → C` 箭头示意）；再讲关键细节；最后点出新手容易误解的地方。",
    "3. 篇幅随问题深浅调整：简单问题简短作答，「为什么 / 怎么配合」类问题要讲透，但不要重复用户已经读懂的内容。",
    "4. 只回答用户当前这个问题，不要把其他段落逐段讲一遍。",
  ].join("\n");

  const roleCards = Array.isArray(slices)
    ? (slices as { startLine?: unknown; endLine?: unknown; title?: unknown; role?: unknown }[])
        .filter((x) => Number.isFinite(x.startLine) && Number.isFinite(x.endLine))
        .slice(0, 50)
        .map(
          (x, i) =>
            `- 第${i + 1}段（${x.startLine}–${x.endLine}行）「${typeof x.title === "string" ? x.title : ""}」：${
              typeof x.role === "string" && x.role.trim() ? x.role.trim().slice(0, 200) : "（无角色描述）"
            }`
        )
    : [];

  const system = [
    "你是耐心的编程老师，面向编程新手，用简体中文回答。",
    projectContextText(projectContext),
    typeof codePurpose === "string" && codePurpose
      ? `完整代码的用途：${codePurpose.slice(0, 300)}。`
      : "",
    `下面是完整的 ${language || ""} 代码（带行号，回答时可引用行号）：`,
    "```",
    codeWithLineNumbers(code),
    "```",
    `用户正在阅读第 ${s.startLine}–${s.endLine} 行，标题「${s.title}」，代码如下：`,
    "```",
    sliceCode(code, s),
    "```",
    understood.length
      ? `用户已经读懂了前面这些段落：${understood.map((t) => `「${t}」`).join("、")}。`
      : "这是用户阅读的第一段。",
    roleCards.length
      ? `全部段落角色卡（帮助理解代码整体结构，回答时可提及）：\n${roleCards.join("\n")}`
      : "",
    deep ? DEEP_RULE : BRIEF_RULE,
  ].join("\n");

  const chatMsgs: ChatMessage[] = [{ role: "system", content: system }];

  if (history.length === 0) {
    chatMsgs.push({
      role: "user",
      content: deep
        ? "请为这段代码生成一段概览：3–6 句话说清这段做了什么、它在整体代码中的位置（被谁使用、产出交给谁，标出行号），并点出 1–2 个新手可能卡住的地方。"
        : "请为这段代码生成一段简短概览：3–6 句话说清这段做了什么，并点出 1–2 个新手可能卡住的地方。",
    });
  } else {
    for (const m of history.slice(0, -1)) {
      chatMsgs.push({ role: m.role, content: m.content });
    }
    const last = history[history.length - 1];
    let content = last.content;
    if (
      last.role === "user" &&
      selection &&
      Number.isFinite(selection.startLine) &&
      Number.isFinite(selection.endLine)
    ) {
      const selCode = code
        .split("\n")
        .slice(selection.startLine - 1, selection.endLine)
        .map((l: string, i: number) => `${selection.startLine + i}: ${l}`)
        .join("\n");
      content = `我选中了第 ${selection.startLine}–${selection.endLine} 行：\n\`\`\`\n${selCode}\n\`\`\`\n${content}`;
    }
    chatMsgs.push({ role: last.role, content });
  }

  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });
  try {
    await chatCompletionStream(chatMsgs, (t) => res.write(t), abort.signal);
    res.end();
  } catch (e) {
    if (!res.headersSent) res.status(500);
    res.write(`\n\n[出错] ${(e as Error).message}`);
    res.end();
  }
});

// ---------- POST /api/summary ----------
app.post("/api/summary", async (req, res) => {
  const { code, language, slices, codePurpose } = req.body ?? {};
  if (!code || !Array.isArray(slices)) {
    return res.status(400).json({ error: "缺少 code 或 slices 参数。" });
  }
  const err = llmConfigError();
  if (err) return res.status(500).json({ error: err });

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");

  if (isMock()) {
    const text = `# 全文总结（MOCK 示例）\n\n这份代码整体上完成了**示例任务**：先准备数据，再逐步处理，最后输出结果。\n\n## 各段如何配合\n\n${(slices as { title?: string }[]).map((s, i) => `${i + 1}. ${s.title ?? `第 ${i + 1} 段`}：承担了流程中的一环。`).join("\n")}\n\n## 易错点\n\n- 注意边界条件和下标范围；\n- 留意变量在循环内外的取值变化。`;
    await mockStream(text, (t) => res.write(t));
    return res.end();
  }

  const qaDigest = (slices as { title?: string; startLine?: number; endLine?: number; qa?: string }[])
    .map(
      (s, i) =>
        `### 第 ${i + 1} 段「${s.title ?? ""}」（第 ${s.startLine}–${s.endLine} 行）\n${(s.qa ?? "").slice(0, 1500) || "（无问答记录）"}`
    )
    .join("\n\n");

  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "你是耐心的编程老师，用简体中文写总结。输出 markdown，包含三部分：" +
        "1）整份代码做了什么；2）各段如何配合；3）根据用户问过的问题总结出的易错点（新手向）。",
    },
    {
      role: "user",
      content:
        `语言：${language || "未知"}\n` +
        (typeof codePurpose === "string" && codePurpose ? `代码整体用途：${codePurpose.slice(0, 300)}\n` : "") +
        `\n完整代码：\n\`\`\`\n${codeWithLineNumbers(code)}\n\`\`\`\n\n用户分 ${(slices as unknown[]).length} 段读完，各段问答摘要：\n${qaDigest}`,
    },
  ];

  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });
  try {
    await chatCompletionStream(messages, (t) => res.write(t), abort.signal);
    res.end();
  } catch (e) {
    res.write(`\n\n[出错] ${(e as Error).message}`);
    res.end();
  }
});

const MOCK_QA_SUMMARY = `# 本段问答总结（MOCK 示例）

**这段代码**：示例片段，负责准备输入、处理并输出结果。

## 主要问答要点

1. **核心流程**：先初始化数据，再逐步处理，最后返回结果；新手常见卡点是下标从 0 开始。
2. **边界情况**：注意空输入与越界访问，循环条件要留余量。
3. **追问沉淀**：对「为什么这样写」的追问确认了该写法是为复用与可读性服务。

## 标注提醒

- 黄色标注处是关键变量，改动前先确认作用域。

## 待解决

- 暂无遗留疑问（MOCK 模式不产生真实问答）。`;

// ---------- POST /api/slice-qa ----------
app.post("/api/slice-qa", async (req, res) => {
  const { language, slice, codePurpose, digest, code } = req.body ?? {};
  const sl = slice && typeof slice === "object" ? slice : {};
  const segCode = typeof code === "string" ? code.slice(0, 12000) : "";
  const qa = typeof digest === "string" ? digest.trim().slice(0, 8000) : "";
  if (!segCode.trim() && !qa) {
    return res.status(400).json({ error: "缺少 code 或 digest 参数。" });
  }
  const err = llmConfigError();
  if (err) return res.status(500).json({ error: err });

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");

  if (isMock()) {
    await mockStream(MOCK_QA_SUMMARY, (t) => res.write(t));
    return res.end();
  }

  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "你是耐心的编程老师，用简体中文为「一段代码」写复习总结。只总结给出的这一段代码，不要展开讲其它段落。" +
        "输出 markdown，包含：①这段代码在做什么（一句话）；②关键逻辑要点（按执行顺序 3–6 条，引用行号）；" +
        "③问答要点：用户问了什么、AI 的关键结论（若无问答明细，写「本段暂无问答」）；" +
        "④追问与标注里沉淀的易错点或重点提醒（没有就省略）；⑤仍未解决的疑问（没有就写「暂无」）。" +
        "问答相关内容只根据给出的明细，不要编造；语言简洁，面向编程新手。",
    },
    {
      role: "user",
      content:
        `语言：${typeof language === "string" ? language : "未知"}\n` +
        (typeof codePurpose === "string" && codePurpose
          ? `代码整体用途：${codePurpose.slice(0, 200)}\n`
          : "") +
        `段落：第 ${sl.startLine ?? "?"}–${sl.endLine ?? "?"} 行「${typeof sl.title === "string" ? sl.title : ""}」` +
        `${typeof sl.role === "string" && sl.role.trim() ? `（${sl.role.trim().slice(0, 120)}）` : ""}\n\n` +
        (segCode.trim() ? `本段代码：\n\`\`\`\n${segCode}\n\`\`\`\n\n` : "") +
        `问答明细：\n${qa || "（无）"}`,
    },
  ];

  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });
  try {
    await chatCompletionStream(messages, (t) => res.write(t), abort.signal);
    res.end();
  } catch (e) {
    res.write(`\n\n[出错] ${(e as Error).message}`);
    res.end();
  }
});

// ---------- POST /api/summary/export ----------
// 把若干 md 文件写入 <base>/summary/<sub>/ 目录（base 为项目根或用户选择的目录，
// sub 为代码文件相对路径如 code.py、src/a.py，每段消毒后逐级拼接，杜绝 .. 逃逸）。
app.post("/api/summary/export", async (req, res) => {
  const { base, sub, files } = req.body ?? {};
  if (typeof base !== "string" || !base.trim() || !Array.isArray(files)) {
    return res.status(400).json({ error: "缺少 base 或 files 参数。" });
  }
  const subParts = (typeof sub === "string" ? sub : "")
    .split(/[\\/]+/)
    .map(sanitizeFilename)
    .filter((p) => p && p !== "." && p !== "..")
    .slice(0, 12);
  const dir = path.join(toLocalPath(base), "summary", ...subParts);
  try {
    await fsp.mkdir(dir, { recursive: true });
    const written: string[] = [];
    for (const f of files.slice(0, 200)) {
      const raw = typeof f?.name === "string" ? f.name : "";
      const content = typeof f?.content === "string" ? f.content : "";
      const name = sanitizeFilename(raw);
      if (!name || !content.trim()) continue;
      const fname = name.endsWith(".md") ? name : `${name}.md`;
      await fsp.writeFile(path.join(dir, fname), content, "utf8");
      written.push(fname);
    }
    res.json({ dir, written });
  } catch (e) {
    res.status(400).json({ error: `写入总结文件失败：${(e as Error).message}` });
  }
});

// ---------- 工作区接口 ----------
const MOCK_OVERVIEW = `# 项目概览（MOCK 示例）

## 这个项目是做什么的

一个示例项目（MOCK_LLM 模拟生成）。

## 技术栈

TypeScript + Node.js。

## 目录/模块划分

- \`src/\`：源代码目录。
- \`test/\`：测试目录。

## 核心流程

入口文件初始化配置，然后调用各模块完成主要功能。

## 建议的阅读顺序

1. \`package.json\` —— 先看依赖和脚本
2. \`src/index.ts\` —— 主入口
3. \`README.md\` —— 项目说明`;

app.post("/api/workspace/browse", async (req, res) => {
  try {
    const out = await browseDir(req.body?.path);
    res.json(out);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.post("/api/workspace/open", async (req, res) => {
  const input = req.body?.path;
  if (typeof input !== "string" || !input.trim()) {
    return res.status(400).json({ error: "请提供文件夹路径。" });
  }
  const root = toLocalPath(input);
  let st;
  try {
    st = await fsp.stat(root);
  } catch {
    return res.status(400).json({ error: `路径不存在：${root}` });
  }
  if (!st.isDirectory()) {
    return res.status(400).json({ error: `这不是一个文件夹：${root}` });
  }
  const { tree, truncated, fileCount } = listTree(root);
  res.json({ root, name: path.basename(root) || root, tree, truncated, fileCount });
});

app.post("/api/workspace/file", async (req, res) => {
  const { root, path: rel } = req.body ?? {};
  if (typeof root !== "string" || typeof rel !== "string") {
    return res.status(400).json({ error: "缺少 root 或 path 参数。" });
  }
  try {
    const out = await readProjectFile(root, rel);
    res.json(out);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// markdown 预览等场景引用的二进制资源（图片/音视频/pdf），限 root 内、≤20MB
const ASSET_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml", ico: "image/x-icon", bmp: "image/bmp",
  avif: "image/avif", mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg",
  wav: "audio/wav", ogg: "audio/ogg", pdf: "application/pdf",
};
app.get("/api/workspace/asset", async (req, res) => {
  const root = req.query.root;
  const rel = req.query.path;
  if (typeof root !== "string" || !root.trim() || typeof rel !== "string" || !rel.trim()) {
    return res.status(400).json({ error: "缺少 root 或 path 参数。" });
  }
  try {
    const abs = await resolveInside(root, rel);
    const st = await fsp.stat(abs);
    if (!st.isFile() || st.size > 20 * 1024 * 1024) {
      return res.status(404).json({ error: "资源不存在或过大。" });
    }
    const ext = path.extname(abs).slice(1).toLowerCase();
    res.setHeader("Content-Type", ASSET_MIME[ext] ?? "application/octet-stream");
    res.setHeader("Cache-Control", "private, max-age=60");
    res.send(await fsp.readFile(abs));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.post("/api/workspace/overview", async (req, res) => {
  const { root } = req.body ?? {};
  if (typeof root !== "string" || !root.trim()) {
    return res.status(400).json({ error: "缺少 root 参数。" });
  }
  const err = llmConfigError();
  if (err) return res.status(500).json({ error: err });

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");

  if (isMock()) {
    await mockStream(MOCK_OVERVIEW, (t) => res.write(t));
    return res.end();
  }

  let context: string;
  try {
    const { tree } = listTree(root);
    context = await collectOverviewContext(root, tree);
  } catch (e) {
    return res.status(400).json({ error: `读取项目失败：${(e as Error).message}` });
  }

  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "你是耐心的编程老师，面向编程新手，用简体中文输出 markdown。依次包含五个部分：" +
        "①这个项目是做什么的 ②技术栈 ③目录/模块划分（每个重要目录或文件一句话）" +
        "④核心流程是怎么串起来的 ⑤建议的阅读顺序（列出 3–8 个文件，路径用反引号包住，每个附一句理由）。",
    },
    { role: "user", content: `以下是这个项目的结构信息：\n${context}` },
  ];

  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });
  try {
    await chatCompletionStream(messages, (t) => res.write(t), abort.signal);
    res.end();
  } catch (e) {
    res.write(`\n\n[出错] ${(e as Error).message}`);
    res.end();
  }
});

app.post("/api/workspace/chat", async (req, res) => {
  const { root, overview, messages, doc } = req.body ?? {};
  if (typeof root !== "string" || !Array.isArray(messages)) {
    return res.status(400).json({ error: "缺少 root 或 messages 参数。" });
  }
  const err = llmConfigError();
  if (err) return res.status(500).json({ error: err });

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");

  if (isMock()) {
    await mockStream(MOCK_ANSWER, (t) => res.write(t));
    return res.end();
  }

  // doc={title,content}：围绕单篇文档（如 summary/*.md）的问答，不带项目树
  const docObj = doc && typeof doc === "object" ? doc : null;
  let system: string;
  if (docObj) {
    const dt = typeof docObj.title === "string" ? docObj.title.slice(0, 120) : "文档";
    const dc = typeof docObj.content === "string" ? docObj.content.slice(0, 12000) : "";
    system =
      "你是耐心的编程老师，面向编程新手，用简体中文回答关于以下文档的问题。" +
      "每次只回答用户当前这个问题，简洁，只依据文档内容与问答上下文。\n\n" +
      `文档「${dt}」内容：\n${dc}`;
  } else {
    let treeText = "";
    try {
      treeText = "文件树：\n" + treeToText(listTree(root).tree).slice(0, 400).join("\n");
    } catch {
      treeText = "（文件树不可用）";
    }
    system =
      "你是耐心的编程老师，面向编程新手，用简体中文回答关于这个项目的整体问题。" +
      "每次只回答用户当前这个问题，简洁。\n\n" +
      treeText +
      (typeof overview === "string" && overview ? `\n\n项目概览：\n${overview.slice(0, 8000)}` : "");
  }

  const history = messages as { role: string; content: string }[];
  const chatMsgs: ChatMessage[] = [
    {
      role: "system",
      content: system,
    },
    ...history
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
  ];

  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });
  try {
    await chatCompletionStream(chatMsgs, (t) => res.write(t), abort.signal);
    res.end();
  } catch (e) {
    res.write(`\n\n[出错] ${(e as Error).message}`);
    res.end();
  }
});

const port = Number(process.env.PORT || 3001);
app.listen(port, "127.0.0.1", () => {
  console.log(`codeslice server listening on http://localhost:${port}${isMock() ? " (MOCK_LLM)" : ""}`);
});
