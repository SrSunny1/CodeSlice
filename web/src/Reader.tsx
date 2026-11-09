import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Highlight, themes } from "prism-react-renderer";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import AutoTextarea from "./AutoTextarea";
import MarkableMarkdown, { ChatIndex, MarkRail, ThreadCtx, type ThreadCtxValue } from "./MarkableMarkdown";
import {
  exportSummaryFiles,
  postSlice,
  streamChat,
  streamSliceQA,
  streamSummary,
  type ProjectContext,
} from "./api";
import FolderPicker from "./FolderPicker";
import { mergeSlices, splitSlice } from "./sliceOps";
import { clampPct, loadLayout, saveLayout } from "./layout";
import { usePaneZoom } from "./paneZoom";
import { ThemeButton } from "./Home";
import { IconSparkles, IconSend, IconFolderOpen } from "./icons";
import { loadDetail, saveDetail, type Detail } from "./detail";
import {
  expandPath,
  flattenQA,
  getThread,
  newThreadId,
  pathKey,
  qaDigestText,
  removeThread,
  threadHistory,
  threadRoundMap,
  updateMsg,
  updateThread,
} from "./threads";
import type { Theme } from "./theme";
import type { ChatMsg, InlineThread, MsgPath, Session, SessionSlice, ThreadPath } from "./types";

const SLICE_COLORS = ["#4f8cff", "#9a6bff", "#ff9f43", "#2fbf71", "#ff5c7a", "#17becf", "#e0c341"];
const SUMMARY_DIR_KEY = "codeslice:summaryDir";

function sliceIndexAt(slices: SessionSlice[], line: number): number {
  return slices.findIndex((s) => line >= s.startLine && line <= s.endLine);
}

export interface ReaderHandle {
  reslice: () => void;
}

interface ReaderProps {
  session: Session;
  onChange: (s: Session) => void;
  onBack: () => void;
  theme: Theme;
  onToggleTheme: () => void;
  projectContext?: ProjectContext;
  embedded?: boolean;
  onReslicingChange?: (busy: boolean) => void;
  /** 总结文件写入的基目录（工作区会话=项目根）；缺省时由用户选择一次并记住 */
  summaryBaseDir?: string;
}

const Reader = forwardRef<ReaderHandle, ReaderProps>(function Reader(
  { session, onChange, onBack, theme, onToggleTheme, projectContext, embedded, onReslicingChange, summaryBaseDir },
  ref
) {
  const [input, setInput] = useState("");
  // 流式请求的归属："main" 主对话 / "summary" 全文总结 / 线程 pathKey；null 表示空闲
  const [streamKey, setStreamKey] = useState<string | null>(null);
  const streaming = streamKey !== null;
  const [streamText, setStreamText] = useState("");
  const [error, setError] = useState("");
  const [selAnchor, setSelAnchor] = useState<number | null>(null);
  const [selection, setSelection] = useState<{ startLine: number; endLine: number } | null>(null);
  const [splitLine, setSplitLine] = useState<number | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [reslicing, setReslicing] = useState(false);
  // ---------- 每段问答总结 → summary/ 文件夹 ----------
  const [pickedDir, setPickedDir] = useState<string>(() => {
    try {
      return localStorage.getItem(SUMMARY_DIR_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [pickerOpen, setPickerOpen] = useState(false);
  // "all" 或 sliceId；null 表示空闲
  const [qaBusy, setQaBusy] = useState<string | null>(null);
  const [qaProg, setQaProg] = useState({ done: 0, total: 0 });
  const [toast, setToast] = useState("");
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirPickRef = useRef<((dir: string | null) => void) | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const sessionRef = useRef<Session>(session);
  sessionRef.current = session;

  const bodyRef = useRef<HTMLDivElement>(null);
  const sideRef = useRef<HTMLDivElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const codePaneRef = useRef<HTMLDivElement>(null);
  const sliceListRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<"v" | "h" | null>(null);
  const [codePct, setCodePct] = useState(() => loadLayout().codePct);
  const [listPct, setListPct] = useState(() => loadLayout().listPct);
  const [listCollapsed, setListCollapsed] = useState(() => loadLayout().listCollapsed);
  const [detail, setDetail] = useState<Detail>(loadDetail);
  const detailRef = useRef(detail);
  detailRef.current = detail;
  const pctRef = useRef({ codePct, listPct });
  pctRef.current = { codePct, listPct };
  // 各栏 Ctrl+滚轮独立缩放
  usePaneZoom(codePaneRef, "zCode");
  usePaneZoom(sliceListRef, "zSlices");
  usePaneZoom(chatScrollRef, "zChat");

  const prismTheme = theme === "dark" ? themes.oneDark : themes.oneLight;

  function onSplitterDown(kind: "v" | "h") {
    return (e: React.PointerEvent<HTMLElement>) => {
      dragRef.current = kind;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      document.body.classList.add("dragging", kind === "v" ? "drag-v" : "drag-h");
    };
  }

  function onSplitterMove(e: React.PointerEvent<HTMLElement>) {
    const kind = dragRef.current;
    if (!kind) return;
    if (kind === "v" && bodyRef.current) {
      const r = bodyRef.current.getBoundingClientRect();
      setCodePct(clampPct(e.clientX, r.left, r.width, 25, 75));
    } else if (kind === "h" && sideRef.current) {
      const r = sideRef.current.getBoundingClientRect();
      setListPct(clampPct(e.clientY, r.top, r.height, 12, 60));
    }
  }

  function onSplitterUp() {
    if (!dragRef.current) return;
    dragRef.current = null;
    document.body.classList.remove("dragging", "drag-v", "drag-h");
    saveLayout({ codePct: pctRef.current.codePct, listPct: pctRef.current.listPct });
  }

  const curIdx = Math.max(0, session.slices.findIndex((s) => s.id === session.currentSliceId));
  const cur = session.slices[curIdx];
  const allDone = session.slices.every((s) => s.status === "done");
  const doneCount = session.slices.filter((s) => s.status === "done").length;
  const lines = useMemo(() => session.code.split("\n"), [session.code]);

  function commit(next: Session) {
    sessionRef.current = next;
    onChange(next);
  }

  function updateSlice(idx: number, patch: Partial<SessionSlice>) {
    const sess = sessionRef.current;
    const slices = sess.slices.map((s, i) => (i === idx ? { ...s, ...patch } : s));
    commit({ ...sess, slices });
  }

  /** 按 slice id 定位并整体替换 messages（提交时按当前 session 状态计算）。 */
  function patchSliceMessages(sliceId: string, fn: (ms: ChatMsg[]) => ChatMsg[]) {
    const sess = sessionRef.current;
    const slices = sess.slices.map((s) =>
      s.id === sliceId ? { ...s, messages: fn(s.messages) } : s
    );
    commit({ ...sess, slices });
  }

  function curSliceId(): string {
    return sessionRef.current.currentSliceId;
  }

  function understoodTitles() {
    return sessionRef.current.slices.filter((s) => s.status === "done").map((s) => s.title);
  }

  /**
   * 统一的流式问答：主对话与追问线程共用。
   * history 是发给 /api/chat 的扁平消息；onDone 负责把回答落到正确的位置。
   */
  async function runStream(
    sliceId: string,
    history: { role: "user" | "assistant"; content: string }[],
    selectionArg: { startLine: number; endLine: number } | undefined,
    detailArg: Detail,
    key: string,
    onDone: (text: string) => void
  ) {
    const s = sessionRef.current.slices.find((x) => x.id === sliceId);
    if (!s) return;
    setStreamKey(key);
    setStreamText("");
    setError("");
    const ac = new AbortController();
    abortRef.current = ac;
    let acc = "";
    try {
      const full = await streamChat(
        {
          code: sessionRef.current.code,
          language: sessionRef.current.language,
          slice: s,
          slices: sessionRef.current.slices,
          understoodTitles: understoodTitles(),
          messages: history,
          selection: selectionArg,
          projectContext,
          codePurpose: sessionRef.current.codePurpose,
          detail: detailArg,
        },
        (t) => {
          acc += t;
          setStreamText(acc);
        },
        ac.signal
      );
      onDone(full);
    } catch (e) {
      if (acc) onDone(acc);
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      if (abortRef.current === ac) {
        setStreamKey(null);
        setStreamText("");
        abortRef.current = null;
      }
    }
  }

  /** 主对话发送（含「生成该段讲解」的空历史流式）。 */
  function streamMain(sliceId: string, msgs: ChatMsg[], selection?: { startLine: number; endLine: number }) {
    const history = msgs.map(({ role, content }) => ({ role, content }));
    runStream(sliceId, history, selection, detailRef.current, "main", (text) =>
      patchSliceMessages(sliceId, (ms) => [...ms, { role: "assistant", content: text }])
    );
  }

  /** 把线程 tp 的回答追加到该线程 messages 末尾（提交时按当前状态重查）。 */
  function appendThreadMsg(tp: ThreadPath, m: ChatMsg, sliceId = curSliceId()) {
    patchSliceMessages(sliceId, (ms) =>
      updateThread(ms, tp, (t) => ({ ...t, messages: [...t.messages, m] }))
    );
  }

  /** 索引条/导航点右键删除：按 MsgPath 定位标注，按 ThreadPath 定位追问。 */
  function deleteMarkAt(mp: MsgPath, markIdx: number) {
    patchSliceMessages(curSliceId(), (ms) =>
      updateMsg(ms, mp, (m) => {
        const marks = m.marks?.filter((_, i) => i !== markIdx);
        return { ...m, marks: marks?.length ? marks : undefined };
      })
    );
  }
  function deleteThreadAt(tp: ThreadPath) {
    patchSliceMessages(curSliceId(), (ms) => removeThread(ms, tp));
  }

  const threadRounds = useMemo(
    () => threadRoundMap(cur?.messages ?? []),
    [cur?.messages]
  );

  // 已生成问答总结的段落数（按钮徽标用）
  const qaDoneCount = session.slices.filter((s) => s.qaSummary).length;
  // 总结文件基目录：工作区会话用项目根；否则用用户选过并记住的目录
  const summaryBase = summaryBaseDir || pickedDir || "";

  const threadCtx: ThreadCtxValue = {
    messages: cur?.messages ?? [],
    rounds: threadRounds,
    busy: streaming,
    streamingKey:
      streamKey === "main" || streamKey === "summary" || streamKey === "sliceqa"
        ? null
        : streamKey,
    streamText,
    showDetail: true,
    onMarks(mp, marks) {
      patchSliceMessages(curSliceId(), (ms) => updateMsg(ms, mp, (m) => ({ ...m, marks })));
    },
    onAsk(mp: MsgPath, anchor, question) {
      const sliceId = curSliceId();
      const s = sessionRef.current.slices.find((x) => x.id === sliceId);
      if (!s) return;
      const t: InlineThread = {
        id: newThreadId(),
        start: anchor.start,
        end: anchor.end,
        blockEnd: anchor.blockEnd,
        quote: anchor.quote,
        messages: [{ role: "user", content: question }],
        detail: "brief",
      };
      const next = updateMsg(s.messages, mp, (m) => ({
        ...m,
        threads: [...(m.threads ?? []), t],
      }));
      patchSliceMessages(sliceId, () => next);
      const tp: ThreadPath = [...mp, t.id];
      runStream(sliceId, threadHistory(next, tp), undefined, "brief", pathKey(tp), (text) =>
        appendThreadMsg(tp, { role: "assistant", content: text }, sliceId)
      );
    },
    onReply(tp, question) {
      const sliceId = curSliceId();
      const s = sessionRef.current.slices.find((x) => x.id === sliceId);
      if (!s) return;
      const next = expandPath(
        updateThread(s.messages, tp, (t) => ({
          ...t,
          messages: [...t.messages, { role: "user", content: question }],
        })),
        tp
      );
      patchSliceMessages(sliceId, () => next);
      runStream(
        sliceId,
        threadHistory(next, tp),
        undefined,
        getThread(next, tp)?.detail ?? "brief",
        pathKey(tp),
        (text) => appendThreadMsg(tp, { role: "assistant", content: text }, sliceId)
      );
    },
    onPatchThread(tp, patch) {
      patchSliceMessages(curSliceId(), (ms) =>
        updateThread(ms, tp, (t) => ({ ...t, ...patch }))
      );
    },
    onDeleteThread(tp) {
      deleteThreadAt(tp);
    },
    onAbort() {
      abortRef.current?.abort();
    },
  };

  // 卸载时中止进行中的流式请求（已收到的部分会由 AbortError 分支保存）。
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 切换 slice 时清空选择状态（不再自动生成讲解，避免误触消耗请求）
  useEffect(() => {
    setSelection(null);
    setSelAnchor(null);
    setSplitLine(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.currentSliceId]);

  // 滚动跟随：追问流式跟随该追问卡片（实时看到输出）；主问答流式即时跟底；
  // 追问流刚结束保持原位不回跳底部，让用户停在追问处。
  const prevStreamKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const threadKey =
      streamKey && streamKey !== "main" && streamKey !== "summary" && streamKey !== "sliceqa"
        ? streamKey
        : null;
    if (threadKey) {
      chatScrollRef.current
        ?.querySelector(`[data-thread-path="${threadKey}"]`)
        ?.scrollIntoView({ block: "nearest" });
    } else if (
      streamKey === "main" ||
      (!streamKey &&
        (prevStreamKeyRef.current === null || prevStreamKeyRef.current === "main"))
    ) {
      chatEndRef.current?.scrollIntoView({ behavior: streamKey ? "auto" : "smooth" });
    }
    prevStreamKeyRef.current = streamKey;
  }, [cur?.messages.length, streamText, streamKey]);

  function gotoSlice(s: SessionSlice) {
    if (streaming) return;
    const slices = session.slices.map((x) =>
      x.id === s.id && x.status === "unread" ? { ...x, status: "reading" as const } : x
    );
    commit({ ...session, slices, currentSliceId: s.id });
    requestAnimationFrame(() => {
      document
        .getElementById(`cl-${s.startLine}`)
        ?.scrollIntoView({ behavior: "smooth", block: "start", inline: "nearest" });
    });
  }

  function send() {
    const text = input.trim();
    if (!text || streaming || !cur) return;
    const msgs = [...cur.messages, { role: "user" as const, content: text, selection: selection ?? undefined }];
    updateSlice(curIdx, { messages: msgs });
    setInput("");
    setSelection(null);
    setSelAnchor(null);
    streamMain(cur.id, msgs, selection ?? undefined);
  }

  function retrySend() {
    if (streaming || !cur) return;
    setError("");
    // 上次提问已 push 进 cur.messages；重发以当前消息列表为准，从最后一条 user 消息取回行号选区
    const last = cur.messages[cur.messages.length - 1];
    if (!last || last.role !== "user") return;
    streamMain(cur.id, cur.messages, last.selection ?? undefined);
  }

  /** 空状态快捷提问：直接带文字发起一轮问答。 */
  function quickAsk(question: string) {
    if (streaming || !cur) return;
    const msgs = [...cur.messages, { role: "user" as const, content: question }];
    updateSlice(curIdx, { messages: msgs });
    streamMain(cur.id, msgs, selection ?? undefined);
  }

  function markUnderstood() {
    if (!cur) return;
    const slices = session.slices.map((s, i) =>
      i === curIdx ? { ...s, status: "done" as const } : s
    );
    const nextUnread = slices.findIndex((s) => s.status !== "done");
    const next: Session = { ...session, slices };
    if (nextUnread >= 0) {
      next.currentSliceId = slices[nextUnread].id;
      next.slices = slices.map((s, i) =>
        i === nextUnread && s.status === "unread" ? { ...s, status: "reading" as const } : s
      );
    }
    commit(next);
  }

  function onLineNumberClick(line: number, e: React.MouseEvent) {
    if (!cur || line < cur.startLine || line > cur.endLine) return;
    if (e.shiftKey && selAnchor !== null) {
      const a = Math.max(selAnchor, cur.startLine);
      setSelection({ startLine: Math.min(a, line), endLine: Math.max(a, line) });
    } else {
      setSelAnchor(line);
      setSelection({ startLine: line, endLine: line });
    }
  }

  function onCodeLineClick(line: number) {
    // 代码区点击：作为拆分候选行
    if (cur && line > cur.startLine && line <= cur.endLine) {
      setSplitLine(line);
    } else {
      setSplitLine(null);
    }
  }

  function doMerge(i: number) {
    if (streaming) return;
    const slices = mergeSlices(session.slices, i);
    commit({ ...session, slices, currentSliceId: slices[Math.min(i, slices.length - 1)].id });
  }

  function doSplit(i: number) {
    if (splitLine === null || streaming) return;
    const slices = splitSlice(session.slices, i, splitLine);
    if (slices === session.slices) return;
    setSplitLine(null);
    commit({ ...session, slices });
  }

  async function reslice() {
    if (streaming || reslicing || !window.confirm("重新切分会清空所有对话记录，确定吗？")) return;
    setError("");
    setReslicing(true);
    onReslicingChange?.(true);
    try {
      const { purpose, slices: fresh } = await postSlice(session.code, session.language, projectContext);
      const slices: SessionSlice[] = fresh.map((s, i) => ({
        ...s,
        status: i === 0 ? "reading" : "unread",
        messages: [],
      }));
      commit({ ...session, codePurpose: purpose, slices, currentSliceId: slices[0]?.id ?? "", summary: undefined });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setReslicing(false);
      onReslicingChange?.(false);
    }
  }

  useImperativeHandle(ref, () => ({ reslice }));

  async function genSummary() {
    setSummaryOpen(true);
    setError("");
    const ac = new AbortController();
    abortRef.current = ac;
    setStreamKey("summary");
    let acc = "";
    const qa = sessionRef.current.slices.map((s) => ({
      title: s.title,
      startLine: s.startLine,
      endLine: s.endLine,
      qa: flattenQA(s.messages).slice(0, 1500),
    }));
    try {
      const full = await streamSummary(
        {
          code: sessionRef.current.code,
          language: sessionRef.current.language,
          codePurpose: sessionRef.current.codePurpose,
          slices: qa,
        },
        (t) => {
          acc += t;
          commit({ ...sessionRef.current, summary: acc });
        },
        ac.signal
      );
      commit({ ...sessionRef.current, summary: full });
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      if (abortRef.current === ac) {
        setStreamKey(null);
        abortRef.current = null;
      }
    }
  }

  // ---------- 每段问答总结 → summary/ 文件夹 ----------

  function showToast(msg: string) {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 4500);
  }

  /** 没有可用基目录时弹出文件夹选择器；选中后由调用方写入 localStorage。 */
  function pickSummaryDir(): Promise<string | null> {
    return new Promise((resolve) => {
      dirPickRef.current = resolve;
      setPickerOpen(true);
    });
  }

  async function ensureSummaryDir(): Promise<string | null> {
    if (summaryBase) return summaryBase;
    const dir = await pickSummaryDir();
    if (dir) {
      setPickedDir(dir);
      try {
        localStorage.setItem(SUMMARY_DIR_KEY, dir);
      } catch {
        /* ignore */
      }
    }
    return dir;
  }

  function patchSliceById(sliceId: string, patch: Partial<SessionSlice>) {
    const sess = sessionRef.current;
    commit({
      ...sess,
      slices: sess.slices.map((s) => (s.id === sliceId ? { ...s, ...patch } : s)),
    });
  }

  /** 段落 md 文件名主体：NN-标题（去掉文件名非法字符）。 */
  function sliceBaseName(idx: number, title: string): string {
    const safe =
      title
        .replace(/[\\/:*?"<>|]/g, "-")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 60) || `slice-${idx + 1}`;
    return `${String(idx + 1).padStart(2, "0")}-${safe}`;
  }

  function buildSliceMd(s: SessionSlice, idx: number, summary: string): string {
    const sess = sessionRef.current;
    const src = sess.code.split("\n").slice(s.startLine - 1, s.endLine).join("\n");
    const fence = src.includes("```") ? "~~~~" : "```";
    return (
      `# ${s.title}\n\n` +
      `> ${sess.filePath || sess.title} · 第 ${idx + 1} 段 · 第 ${s.startLine}–${s.endLine} 行` +
      `${s.role ? ` · ${s.role}` : ""}\n\n` +
      `${summary.trim()}\n\n` +
      `## 本段代码\n\n${fence}${sess.language}\n${src}\n${fence}\n`
    );
  }

  /** README.md 索引：列出全部段落，已生成总结的带链接。 */
  function buildIndexMd(): string {
    const sess = sessionRef.current;
    const rows = sess.slices.map((s, i) => {
      const base = sliceBaseName(i, s.title);
      const st = s.status === "done" ? "已懂" : s.status === "reading" ? "阅读中" : "未读";
      const label = s.qaSummary ? `[${base}](${base}.md)` : `${base}（未生成）`;
      return `- ${label} — 第 ${s.startLine}–${s.endLine} 行 · ${st}`;
    });
    return (
      `# 问答总结 · ${sess.title}\n\n` +
      `> 生成时间：${new Date().toLocaleString("zh-CN")}\n\n` +
      `${rows.join("\n")}\n`
    );
  }

  /** 总结子文件夹：工作区文件用相对路径（summary/code.py/），粘贴代码用会话标题。 */
  function summarySub(): string {
    const sess = sessionRef.current;
    return sess.filePath || sess.title || "snippet";
  }

  /** 调 /api/slice-qa 生成一段的总结文本（不写文件）：只带本段代码与本段问答。 */
  async function genSliceSummaryText(s: SessionSlice, signal: AbortSignal): Promise<string> {
    const digest = qaDigestText(s.messages);
    const code = sessionRef.current.code
      .split("\n")
      .slice(s.startLine - 1, s.endLine)
      .map((l, i) => `${s.startLine + i}: ${l}`)
      .join("\n");
    return streamSliceQA(
      {
        language: sessionRef.current.language,
        slice: {
          title: s.title,
          startLine: s.startLine,
          endLine: s.endLine,
          role: s.role,
        },
        codePurpose: sessionRef.current.codePurpose,
        code: code.slice(0, 12000),
        digest: digest.slice(0, 8000),
      },
      () => {},
      signal
    );
  }

  /** 单段导出：生成总结 → 写 NN-标题.md + README.md 索引。 */
  async function exportSliceQA(idx: number) {
    if (qaBusy || streaming) return;
    const s = sessionRef.current.slices[idx];
    if (!s) return;
    setQaBusy(s.id);
    setStreamKey("sliceqa");
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const dir = await ensureSummaryDir();
      if (!dir) return;
      const summary = await genSliceSummaryText(s, ac.signal);
      patchSliceById(s.id, { qaSummary: summary });
      const r = await exportSummaryFiles(dir, summarySub(), [
        { name: `${sliceBaseName(idx, s.title)}.md`, content: buildSliceMd(s, idx, summary) },
        { name: "README.md", content: buildIndexMd() },
      ]);
      showToast(`已导出「${s.title}」的总结到 ${r.dir}`);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      if (abortRef.current === ac) {
        setStreamKey(null);
        abortRef.current = null;
      }
      setQaBusy(null);
    }
  }

  /** 全部导出：逐段生成总结 → 写全部 md + README.md；中止时保留已完成的部分。 */
  async function exportAllQA() {
    if (qaBusy || streaming) return;
    const sess = sessionRef.current;
    const targets = sess.slices.map((s, i) => ({ s, i }));
    if (!targets.length) return;
    setQaBusy("all");
    setQaProg({ done: 0, total: targets.length });
    setStreamKey("sliceqa");
    const ac = new AbortController();
    abortRef.current = ac;
    const files: { name: string; content: string }[] = [];
    let ok = 0;
    let fail = 0;
    try {
      const dir = await ensureSummaryDir();
      if (!dir) return;
      for (const { s, i } of targets) {
        if (ac.signal.aborted) break;
        try {
          const summary = await genSliceSummaryText(s, ac.signal);
          patchSliceById(s.id, { qaSummary: summary });
          files.push({
            name: `${sliceBaseName(i, s.title)}.md`,
            content: buildSliceMd(s, i, summary),
          });
          ok++;
        } catch (e) {
          if ((e as Error).name === "AbortError") break;
          fail++;
          setError(`「${s.title}」总结失败：${(e as Error).message}`);
        }
        setQaProg({ done: ok + fail, total: targets.length });
      }
      if (files.length) {
        files.push({ name: "README.md", content: buildIndexMd() });
        const r = await exportSummaryFiles(dir, summarySub(), files);
        showToast(
          `已导出 ${files.length - 1} 份段落总结到 ${r.dir}${fail ? `（${fail} 份失败）` : ""}`
        );
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      if (abortRef.current === ac) {
        setStreamKey(null);
        abortRef.current = null;
      }
      setQaBusy(null);
    }
  }

  return (
    <div className="reader">
      {!embedded && (
        <header className="reader-header">
          <button className="link" onClick={onBack} title="返回首页">
            ← 返回
          </button>
          <div className="reader-title-wrap">
            <span className="reader-title">{session.title}</span>
            <div className="reader-meta">
              <span className="reader-chip">{session.language}</span>
              <span className="reader-progress">
                {curIdx + 1} / {session.slices.length} 段
              </span>
            </div>
          </div>
          <button
            className="link"
            onClick={reslice}
            disabled={reslicing}
            title="重新让 AI 切分（会清空对话记录）"
          >
            {reslicing ? "正在切分…" : "重新切分"}
          </button>
          <ThemeButton theme={theme} onToggle={onToggleTheme} />
        </header>
      )}
      {reslicing && (
        <div className="reslicing-mask">
          <span className="reslicing-pill">⏳ 正在让 AI 重新切分，请稍候…</span>
        </div>
      )}
      <div className="reader-body" ref={bodyRef}>
        <div className="code-pane" ref={codePaneRef} style={{ width: `${codePct}%` }}>
          <div className="code-toolbar">
            <span className="code-toolbar-purpose" title={session.codePurpose || ""}>
              {session.codePurpose || `共 ${lines.length} 行`}
            </span>
            <span className="code-toolbar-meta">{lines.length} 行 · {session.language}</span>
            {splitLine !== null && (
              <span className="code-toolbar-hint">点击行号选区提问 · 点击代码行可作拆分点</span>
            )}
          </div>
          <Highlight theme={prismTheme} code={session.code} language={session.language}>
            {({ tokens, getLineProps, getTokenProps }) => (
              <pre className="code-pre">
                {tokens.map((lineTokens, i) => {
                  const lineNo = i + 1;
                  const si = sliceIndexAt(session.slices, lineNo);
                  const sl = session.slices[si];
                  const isCur = si === curIdx;
                  const inSel = selection && lineNo >= selection.startLine && lineNo <= selection.endLine;
                  const cls = [
                    "code-line",
                    isCur ? "cur" : "dim",
                    sl?.status === "done" ? "done" : "",
                    inSel ? "selected" : "",
                    splitLine === lineNo ? "split-target" : "",
                  ].join(" ");
                  return (
                    <div
                      key={i}
                      id={`cl-${lineNo}`}
                      {...getLineProps({ line: lineTokens })}
                      className={cls}
                      style={{ borderLeftColor: SLICE_COLORS[si % SLICE_COLORS.length] }}
                      onClick={() => {
                        if (!isCur && sl) gotoSlice(sl);
                        else onCodeLineClick(lineNo);
                      }}
                    >
                      <span
                        className="lineno"
                        onClick={(e) => {
                          e.stopPropagation();
                          onLineNumberClick(lineNo, e);
                        }}
                      >
                        {lineNo}
                      </span>
                      <span className="line-content">
                        {lineTokens.map((t, k) => {
                          const props = getTokenProps({ token: t });
                          if (!props.style?.color) {
                            props.style = {
                              ...(props.style ?? {}),
                              color: prismTheme.plain.color as string,
                            };
                          }
                          return <span key={k} {...props} />;
                        })}
                      </span>
                    </div>
                  );
                })}
              </pre>
            )}
          </Highlight>
        </div>

        <div
          className="splitter-v"
          onPointerDown={onSplitterDown("v")}
          onPointerMove={onSplitterMove}
          onPointerUp={onSplitterUp}
        />
        <div className="side-pane" ref={sideRef}>
          <div className="slice-bar">
            <button
              className="slice-bar-title"
              onClick={() => {
                const next = !listCollapsed;
                setListCollapsed(next);
                saveLayout({ listCollapsed: next });
              }}
              title={listCollapsed ? "展开段落列表" : "收起段落列表"}
            >
              {listCollapsed ? "▸" : "▾"} 段落 · {doneCount}/{session.slices.length} 已懂 · 当前：{cur?.title ?? "—"}
            </button>
            <span className="slice-bar-nav">
              <button
                className="link"
                disabled={streaming || curIdx <= 0}
                onClick={() => gotoSlice(session.slices[curIdx - 1])}
                title="上一段"
              >
                ‹ 上一段
              </button>
              <button
                className="link"
                disabled={streaming || curIdx >= session.slices.length - 1}
                onClick={() => gotoSlice(session.slices[curIdx + 1])}
                title="下一段"
              >
                下一段 ›
              </button>
            </span>
            {/* 底部全宽 2px 进度轨道 */}
            <div className="slice-bar-progress">
              <div
                className="slice-bar-progress-fill"
                style={{ width: `${session.slices.length ? (doneCount / session.slices.length) * 100 : 0}%` }}
              />
            </div>
          </div>
          {!listCollapsed && (
            <div className="slice-list" ref={sliceListRef} style={{ height: `${listPct}%` }}>
            {session.slices.map((s, i) => (
              <div
                key={s.id}
                className={`slice-item ${s.id === cur?.id ? "active" : ""} ${s.status}`}
                style={{ borderLeftColor: SLICE_COLORS[i % SLICE_COLORS.length] }}
              >
                <button className="slice-main" onClick={() => gotoSlice(s)}>
                  <span className="slice-title-row">
                    <span className="slice-title">
                      {s.status === "done" ? "✓ " : ""}
                      {s.title}
                    </span>
                    {s.messages.length > 0 && (
                      <span className="slice-qa-badge" title="问答记录数">
                        {s.messages.filter((m) => m.role === "user").length} 问
                      </span>
                    )}
                  </span>
                  <span className="slice-meta">
                    第 {s.startLine}–{s.endLine} 行 · {s.messages.length} 条 ·{" "}
                    {s.status === "done" ? "已懂" : s.id === cur?.id ? "阅读中" : s.status === "reading" ? "阅读中" : "未读"}
                  </span>
                  {s.role && (
                    <span className="slice-role" title={s.role}>{s.role}</span>
                  )}
                </button>
                <div className="slice-ops">
                  <button
                    className="link"
                    disabled={qaBusy !== null || streaming}
                    onClick={() => exportSliceQA(i)}
                    title={
                      s.qaSummary
                        ? "重新生成并导出该段总结"
                        : "只针对本段代码（含问题/追问/标注）生成总结，写入 summary/<文件名>/"
                    }
                  >
                    {qaBusy === s.id ? "生成中…" : s.qaSummary ? "重新总结" : "总结"}
                  </button>
                  <button className="link" disabled={i >= session.slices.length - 1} onClick={() => doMerge(i)}>
                    合并
                  </button>
                  <button
                    className="link"
                    disabled={splitLine === null || splitLine <= s.startLine || splitLine > s.endLine}
                    onClick={() => doSplit(i)}
                    title="先在代码区点选当前段内某一行（非首行）"
                  >
                    在此拆分{splitLine && splitLine > s.startLine && splitLine <= s.endLine ? `（第 ${splitLine} 行）` : ""}
                  </button>
                </div>
              </div>
            ))}
            </div>
          )}
          {!listCollapsed && (
            <div
              className="splitter-h"
              onPointerDown={onSplitterDown("h")}
              onPointerMove={onSplitterMove}
              onPointerUp={onSplitterUp}
            />
          )}
          <div className="chat-pane">
            <div className="chat-header">
              <div className="chat-header-main">
                <strong>{cur?.title}</strong>
                <span className="slice-meta">
                  第 {cur?.startLine}–{cur?.endLine} 行
                </span>
              </div>
              <div className="chat-header-actions">
                <button
                  className="header-action-btn"
                  onClick={() => exportSliceQA(curIdx)}
                  disabled={qaBusy !== null || streaming || !cur}
                  title={
                    cur?.qaSummary
                      ? "重新生成并导出当前这段的总结"
                      : "只针对当前这段代码（含问题/追问/标注）生成总结，写入 summary/<文件名>/"
                  }
                >
                  <span>
                    {qaBusy === cur?.id ? "生成中…" : "总结本段"}
                  </span>
                </button>
                <button
                  className="header-action-btn"
                  onClick={exportAllQA}
                  disabled={qaBusy !== null || streaming}
                  title="逐段单独生成总结，每段一个 md，写入 summary/<文件名>/ 文件夹"
                >
                  <IconFolderOpen size={13} />
                  <span>
                    {qaBusy === "all"
                      ? `总结中 ${qaProg.done}/${qaProg.total}`
                      : `各段总结${qaDoneCount ? ` ${qaDoneCount}/${session.slices.length}` : ""}`}
                  </span>
                </button>
              </div>
            </div>
            <div className="chat-body">
              <ChatIndex
                containerRef={chatScrollRef}
                messages={cur?.messages ?? []}
                onExpand={(tp) =>
                  patchSliceMessages(curSliceId(), (ms) => expandPath(ms, tp))
                }
                onDeleteMark={deleteMarkAt}
                onDeleteThread={deleteThreadAt}
              />
              <div className="chat-messages" ref={chatScrollRef}>
              <ThreadCtx.Provider value={threadCtx}>
              {cur && cur.messages.length === 0 && !streaming && (
                <div className="chat-empty-card">
                  <div className="chat-empty-icon"><IconSparkles size={22} /></div>
                  <h3>这一段还没有讲解</h3>
                  <p>可以让 AI 先讲一段概览，或直接从下面挑一个常见问题开始。</p>
                  <button className="primary" onClick={() => streamMain(cur.id, [])}>
                    ✦ 生成该段讲解
                  </button>
                  <div className="chat-empty-chips">
                    {["这段的核心输入和输出是什么？", "有哪些边界情况或易错点？", "帮我逐行拆解关键语法"].map((q) => (
                      <button
                        key={q}
                        className="chat-chip"
                        onClick={() => quickAsk(q)}
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {cur?.messages.map((m, i) => (
                <div key={i} className={`msg ${m.role}`} data-msg-path={i}>
                  {m.selection && (
                    <span className="sel-tag">
                      针对第 {m.selection.startLine}–{m.selection.endLine} 行
                    </span>
                  )}
                  {m.role === "assistant" ? (
                    <MarkableMarkdown msg={m} path={[i]} />
                  ) : (
                    <div className="user-text">{m.content}</div>
                  )}
                </div>
              ))}
              {streamKey === "main" && (
                <div className="msg assistant">
                  <Markdown remarkPlugins={[remarkGfm]}>{streamText || "…"}</Markdown>
                  <span className="cursor">▍</span>
                </div>
              )}
              <MarkRail containerRef={chatScrollRef} onDeleteMark={deleteMarkAt} />
              <div ref={chatEndRef} />
              </ThreadCtx.Provider>
              </div>
            </div>
            {error && (
              <div className="error-box">
                {error}
                <button className="link" onClick={retrySend}>重试</button>
              </div>
            )}
            <div className="chat-input">
              <div className="composer-box">
                {selection && (
                  <div className="composer-top">
                    <span className="sel-tag">
                      针对第 {selection.startLine}–{selection.endLine} 行提问
                      <button
                        className="sel-tag-x"
                        onClick={() => {
                          setSelection(null);
                          setSelAnchor(null);
                        }}
                        title="清除选区"
                      >
                        ×
                      </button>
                    </span>
                  </div>
                )}
                <AutoTextarea
                  className="composer-input"
                  placeholder={streaming ? "正在回答…" : "就这一段提问（点击行号可选中范围）"}
                  value={input}
                  disabled={streaming}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      send();
                    }
                  }}
                />
                <div className="composer-bottom">
                  <div className="composer-left">
                    <div className="detail-toggle">
                      <button
                        className={detail === "brief" ? "active" : ""}
                        title="简短回答，聚焦当前段"
                        onClick={() => {
                          setDetail("brief");
                          saveDetail("brief");
                        }}
                      >
                        简洁
                      </button>
                      <button
                        className={detail === "deep" ? "active" : ""}
                        title="追踪上下游、标注行号、讲透原理"
                        onClick={() => {
                          setDetail("deep");
                          saveDetail("deep");
                        }}
                      >
                        详细
                      </button>
                    </div>
                    <span className="composer-hint">Enter 发送 · Shift+Enter 换行</span>
                  </div>
                  <div className="composer-actions">
                    <button
                      className="primary composer-understood"
                      disabled={streaming || cur?.status === "done"}
                      onClick={markUnderstood}
                      title="标记当前段已懂，进入下一段"
                    >
                      我懂了 →
                    </button>
                    {streaming ? (
                      <button className="composer-stop" onClick={() => abortRef.current?.abort()}>
                        中止
                      </button>
                    ) : (
                      <button
                        className="primary composer-send"
                        disabled={!input.trim()}
                        onClick={send}
                        title="发送（Enter）"
                      >
                        <IconSend size={14} />
                        <span>发送</span>
                      </button>
                    )}
                    {allDone && (
                      <button className="composer-summary" disabled={streaming} onClick={genSummary}>
                        生成全文总结
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {pickerOpen && (
        <FolderPicker
          title="选择总结保存位置"
          actionLabel="选择此文件夹"
          onSelect={(dir) => {
            setPickerOpen(false);
            setPickedDir(dir);
            try {
              localStorage.setItem(SUMMARY_DIR_KEY, dir);
            } catch {
              /* ignore */
            }
            dirPickRef.current?.(dir);
            dirPickRef.current = null;
          }}
          onClose={() => {
            setPickerOpen(false);
            dirPickRef.current?.(null);
            dirPickRef.current = null;
          }}
        />
      )}
      {toast && <div className="app-toast">{toast}</div>}

      {summaryOpen && (
        <div className="summary-overlay" onClick={() => setSummaryOpen(false)}>
          <div className="summary-panel" onClick={(e) => e.stopPropagation()}>
            <div className="summary-head">
              <strong>全文总结</strong>
              <button className="link" onClick={() => setSummaryOpen(false)}>
                关闭
              </button>
            </div>
            <div className="summary-body">
              <Markdown remarkPlugins={[remarkGfm]}>{session.summary || "生成中…"}</Markdown>
            </div>
          </div>
        </div>
      )}
      {!summaryOpen && session.summary && allDone && (
        <button className="summary-fab" onClick={() => setSummaryOpen(true)}>
          查看总结
        </button>
      )}
    </div>
  );
});

export default Reader;
