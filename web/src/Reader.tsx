import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Highlight, Prism, normalizeTokens, themes } from "prism-react-renderer";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import AutoTextarea from "./AutoTextarea";
import MarkableMarkdown, { ChatIndex, MarkRail, ThreadCtx, hlRegistry, makeHighlight, rangeForText, revealRange, type ThreadCtxValue } from "./MarkableMarkdown";
import { collectRevisitReminders, newRevisitId, type RevisitEntry } from "./revisit";
import { classifySpans, findSymbolRefs, identifierAt } from "./symbolRefs";
import {
  exportSummaryFiles,
  postSlice,
  streamChat,
  streamSliceQA,
  streamSummary,
  suggestRevisitTarget,
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
import type { ChatMsg, InlineThread, MsgPath, RevisitReminder, Session, SessionSlice, ThreadPath } from "./types";

const SLICE_COLORS = ["#4f8cff", "#9a6bff", "#ff9f43", "#2fbf71", "#ff5c7a", "#17becf", "#e0c341"];
const SUMMARY_DIR_KEY = "codeslice:summaryDir";

function sliceIndexAt(slices: SessionSlice[], line: number): number {
  return slices.findIndex((s) => line >= s.startLine && line <= s.endLine);
}

/** 鼠标位置落在 root（.line-content）内的文本偏移；无 caret API 或不在 root 内返回 null。 */
function caretTextOffset(root: HTMLElement, x: number, y: number): number | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (
      x: number,
      y: number
    ) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  let node: Node | null = null;
  let offset = 0;
  const pos = doc.caretPositionFromPoint?.(x, y);
  if (pos) {
    node = pos.offsetNode;
    offset = pos.offset;
  } else {
    const r = doc.caretRangeFromPoint?.(x, y);
    if (r) {
      node = r.startContainer;
      offset = r.startOffset;
    }
  }
  if (!node || !root.contains(node)) return null;
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(node, offset);
  return range.toString().length;
}

/** 引用面板里各类型的展示顺序与标题；行内 tag 用短标签。 */
const SYM_KIND_ORDER = [
  { kind: "def", label: "定义" },
  { kind: "assign", label: "赋值" },
  { kind: "call", label: "调用" },
  { kind: "import", label: "导入" },
  { kind: "ref", label: "引用" },
  { kind: "text", label: "注释或字符串" },
] as const;
const SYM_KIND_TAG: Record<string, string> = {
  def: "定义",
  assign: "赋值",
  call: "调用",
  import: "导入",
  ref: "引用",
  text: "文本",
};

export interface ReaderHandle {
  reslice: () => void;
}

/** 「以后再看」AI 建议状态机：idle=待发起，loading=请求中，matched/unmatched/error=已出结果。 */
type RevisitSuggestion =
  | { kind: "idle" | "loading" | "unmatched" | "error" }
  | { kind: "matched"; sliceId: string };

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
  // ---------- 「以后再看」待回看 ----------
  // 未保存的草稿：选完文字后在这里挑目标段；导航/取消即丢弃
  const [pendingRevisit, setPendingRevisit] = useState<{
    sliceId: string;
    path: MsgPath;
    anchor: Pick<RevisitReminder, "start" | "end" | "excerpt">;
  } | null>(null);
  // null = 交给 AI 自动建议；"" = 显式选「仅加入待回看」；其它 = 手动选的目标段 id
  const [revisitManualTarget, setRevisitManualTarget] = useState<string | null>(null);
  const [revisitSuggestion, setRevisitSuggestion] = useState<RevisitSuggestion>({ kind: "idle" });
  const [revisitOpen, setRevisitOpen] = useState(false);
  // 显式回看跳转：与 expand/currentSliceId 同批提交后，由 effect 定位选区滚动
  const [revisitJump, setRevisitJump] = useState<{
    path: MsgPath;
    start: number;
    end: number;
  } | null>(null);
  // 置位期间跳过聊天区自动跟底，避免和回看定位抢滚动
  const revisitScrollRef = useRef(false);
  // ---------- 双击标识符查引用（只读代码区，不写会话） ----------
  const [symFocus, setSymFocus] = useState<{
    name: string;
    originLine: number;
    originCol: number;
    active: number;
  } | null>(null);
  // 第一次点击记录：双击第二次 click 时第一次的 caret 信息（首击可能触发滚动）
  const clickSymRef = useRef<{ line: number; col: number | null; t: number } | null>(null);
  const symListRef = useRef<HTMLDivElement>(null);

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
  // Prism token → 行内 inert（注释/字符串）与 skip（关键字/数字等）区间表
  const codeSpans = useMemo(() => {
    const g = Prism.languages[session.language.toLowerCase()];
    return classifySpans(
      normalizeTokens(g ? Prism.tokenize(session.code, g) : [session.code])
    );
  }, [session.code, session.language]);
  const symRefs = useMemo(
    () => (symFocus ? findSymbolRefs(lines, symFocus.name, codeSpans.inert) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [symFocus?.name, lines, codeSpans]
  );

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

  // ---------- 「以后再看」待回看 ----------

  /** 保存待回看提醒：同 start/end 的旧提醒先替换掉，避免重复。 */
  function saveRevisit() {
    const d = pendingRevisit;
    if (!d) return;
    // 目标段必须在当前「来源段之后」的列表里，否则按无目标保存
    const sess = sessionRef.current;
    const srcIdx = sess.slices.findIndex((s) => s.id === d.sliceId);
    const laterIds =
      srcIdx >= 0 ? new Set(sess.slices.slice(srcIdx + 1).map((s) => s.id)) : new Set<string>();
    const target = revisitTargetId && laterIds.has(revisitTargetId) ? revisitTargetId : undefined;
    const reminder: RevisitReminder = {
      id: newRevisitId(),
      start: d.anchor.start,
      end: d.anchor.end,
      excerpt: d.anchor.excerpt.slice(0, 120),
      targetSliceId: target,
    };
    patchSliceMessages(d.sliceId, (ms) =>
      updateMsg(ms, d.path, (m) => ({
        ...m,
        revisitReminders: [
          ...(m.revisitReminders ?? []).filter(
            (r) => !(r.start === reminder.start && r.end === reminder.end)
          ),
          reminder,
        ],
      }))
    );
    setPendingRevisit(null);
  }

  /** 显式标为已回看：只移除提醒本身，不动标注/追问/消息。 */
  function markRevisited(e: RevisitEntry) {
    patchSliceMessages(e.sliceId, (ms) =>
      updateMsg(ms, e.path, (m) => ({
        ...m,
        revisitReminders: (m.revisitReminders ?? []).filter((r) => r.id !== e.reminder.id),
      }))
    );
  }

  /** 跳到提醒来源：展开途经的收起追问，提交后由 revisitJump effect 定位选区。 */
  function jumpToRevisit(e: RevisitEntry) {
    if (streaming) return;
    const sess = sessionRef.current;
    const src = sess.slices.find((s) => s.id === e.sliceId);
    if (!src) return;
    const expanded = expandPath(src.messages, e.path.slice(0, -1) as ThreadPath);
    const slices = sess.slices.map((s) =>
      s.id === src.id
        ? {
            ...s,
            messages: expanded,
            status: s.status === "unread" ? ("reading" as const) : s.status,
          }
        : s
    );
    revisitScrollRef.current = true;
    setRevisitJump({ path: e.path, start: e.reminder.start, end: e.reminder.end });
    commit({ ...sess, slices, currentSliceId: src.id });
  }

  // 全部待回看项（任意段可见，带计数）；到期项=别的段指定了「到本段提醒」
  const revisitEntries = useMemo(
    () => collectRevisitReminders(session.slices),
    [session.slices]
  );
  const dueRevisit = cur
    ? revisitEntries.filter(
        (e) => e.sliceId !== cur.id && e.reminder.targetSliceId === cur.id
      )
    : [];
  // 目标段：手动选择优先；自动模式下取 AI 建议（未出结果/未匹配=无目标）
  const revisitTargetId =
    revisitManualTarget ??
    (revisitSuggestion.kind === "matched" ? revisitSuggestion.sliceId : "");

  // ---------- 双击标识符查引用 ----------

  /** 跳到第 i 处引用：只更新激活项并滚动代码区，不动会话/选区/段落状态。 */
  function jumpToRef(i: number) {
    const ref = symRefs[i];
    if (!ref || !symFocus) return;
    setSymFocus({ ...symFocus, active: i });
    document.getElementById(`cl-${ref.line}`)?.scrollIntoView({
      behavior: "smooth",
      block: "center",
      inline: "nearest",
    });
  }

  /** 双击代码：识别 caret 处的标识符，收集全文引用并打开面板。 */
  function onCodeDoubleClick(e: React.MouseEvent) {
    // 优先用第一次 click 的记录（首击若切了段会触发平滑滚动，第二击坐标已飘）
    const rec = clickSymRef.current;
    let line: number | null = null;
    let col: number | null = null;
    if (rec && performance.now() - rec.t < 700) {
      line = rec.line;
      col = rec.col;
    } else {
      const lineEl = (e.target as HTMLElement).closest(".code-line");
      const content = lineEl?.querySelector(".line-content");
      const m = /^cl-(\d+)$/.exec(lineEl?.id ?? "");
      if (m && content instanceof HTMLElement) {
        line = Number(m[1]);
        col = caretTextOffset(content, e.clientX, e.clientY);
      }
    }
    if (line === null || col === null) return;
    const hit = identifierAt(lines[line - 1] ?? "", col);
    if (!hit) return;
    // 点在关键字/数字/符号 token 上不触发
    const skipped = codeSpans.skip[line - 1] ?? [];
    if (skipped.some(([s, e2]) => hit.start >= s && hit.start < e2)) return;
    const refs = findSymbolRefs(lines, hit.name, codeSpans.inert);
    if (!refs.length) return;
    const idx = refs.findIndex((r) => r.line === line && r.col === hit.start);
    setSymFocus({
      name: hit.name,
      originLine: line,
      originCol: hit.start,
      active: Math.max(0, idx),
    });
    setSplitLine(null);
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
    onRequestRevisit(mp, anchor) {
      const sess = sessionRef.current;
      const idx = sess.slices.findIndex((s) => s.id === sess.currentSliceId);
      if (idx < 0) return;
      setPendingRevisit({ sliceId: sess.slices[idx].id, path: mp, anchor });
      // 新草稿：回到自动模式，由 effect 发 AI 建议请求（不再默认下一段）
      setRevisitManualTarget(null);
      setRevisitSuggestion({ kind: "idle" });
      setRevisitOpen(true);
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
    // 未保存的「以后再看」草稿随导航丢弃
    setPendingRevisit(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.currentSliceId]);

  // 滚动跟随：追问流式跟随该追问卡片（实时看到输出）；主问答流式即时跟底；
  // 追问流刚结束保持原位不回跳底部，让用户停在追问处。
  const prevStreamKeyRef = useRef<string | null>(null);
  useEffect(() => {
    // 回看跳转自带定位滚动，本次跳过跟随/回底（标志在 revisitJump effect 里清除）
    if (revisitScrollRef.current) {
      prevStreamKeyRef.current = streamKey;
      return;
    }
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

  // 「以后再看」跳转落位：提交 expand/currentSliceId 的同一批渲染完成后，
  // 等两帧让展开的消息挂载好，再按 textContent 偏移重建 Range 滚动并选中；
  // Range 不可得时退化为滚到整条消息。
  useEffect(() => {
    if (!revisitJump) return;
    const j = revisitJump;
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        revisitScrollRef.current = false;
        const c = chatScrollRef.current;
        if (c) {
          const root = c.querySelector(`[data-mark-root="${pathKey(j.path)}"]`);
          const r =
            root instanceof HTMLElement ? rangeForText(root, j.start, j.end) : null;
          if (r) {
            revealRange(c, r, { select: true });
          } else {
            c.querySelector(`[data-msg-path="${pathKey(j.path)}"]`)?.scrollIntoView({
              behavior: "smooth",
              block: "center",
            });
          }
        }
        setRevisitJump(null);
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
      revisitScrollRef.current = false;
    };
  }, [revisitJump]);

  // 「以后再看」AI 建议：新草稿出现时，让 AI 在来源段之后的段落里找
  // 最后一处相关段落。快照取自 sessionRef（起草瞬间的会话），切换/取消时
  // abort，过期结果直接丢弃；末段无候选不发请求。
  useEffect(() => {
    const d = pendingRevisit;
    if (!d) return;
    const sess = sessionRef.current;
    const srcIdx = sess.slices.findIndex((s) => s.id === d.sliceId);
    if (srcIdx < 0) return;
    const later = sess.slices.slice(srcIdx + 1);
    if (later.length === 0) return;
    if (later.length > 200) {
      // 候选过多不硬截（会悄悄丢段），交给用户手动选择
      setRevisitSuggestion({ kind: "error" });
      return;
    }
    const src = sess.slices[srcIdx];
    const codeLines = sess.code.split("\n");
    // ~60000 字符预算摊给 source + 全部候选，每段封顶 1400；超长取头尾
    const per = Math.min(1400, Math.floor(60000 / (later.length + 1)));
    const clip = (s: SessionSlice): string => {
      const text = codeLines.slice(s.startLine - 1, s.endLine).join("\n");
      if (text.length <= per) return text;
      const half = Math.floor((per - 3) / 2);
      return `${text.slice(0, half)}\n…\n${text.slice(text.length - half)}`;
    };
    const candidates = later.map((s) => ({ title: s.title, code: clip(s) }));
    setRevisitSuggestion({ kind: "loading" });
    const ac = new AbortController();
    suggestRevisitTarget(
      {
        excerpt: d.anchor.excerpt,
        source: { title: src.title, code: clip(src) },
        candidates,
      },
      ac.signal
    )
      .then(({ targetIndex }) => {
        if (ac.signal.aborted) return;
        const hit = targetIndex !== null ? later[targetIndex] : undefined;
        setRevisitSuggestion(
          hit ? { kind: "matched", sliceId: hit.id } : { kind: "unmatched" }
        );
      })
      .catch(() => {
        if (!ac.signal.aborted) setRevisitSuggestion({ kind: "error" });
      });
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingRevisit]);

  // 双击引用高亮：CSS Custom Highlight API（cs-symref 全部 / cs-symref-cur 激活项），
  // 浏览器不支持时静默无高亮。
  useEffect(() => {
    const reg = hlRegistry();
    if (!reg) return;
    if (!symFocus || !symRefs.length) {
      reg.delete("cs-symref");
      reg.delete("cs-symref-cur");
      return;
    }
    const all: Range[] = [];
    const curRanges: Range[] = [];
    symRefs.forEach((r, i) => {
      const el = document
        .getElementById(`cl-${r.line}`)
        ?.querySelector(".line-content");
      if (!(el instanceof HTMLElement)) return;
      const range = rangeForText(el, r.col, r.col + symFocus.name.length);
      if (!range) return;
      all.push(range);
      if (i === symFocus.active) curRanges.push(range);
    });
    const setHl = (name: string, ranges: Range[]) => {
      const h = ranges.length ? makeHighlight(ranges) : null;
      if (h) reg.set(name, h);
      else reg.delete(name);
    };
    setHl("cs-symref", all);
    setHl("cs-symref-cur", curRanges);
    return () => {
      reg.delete("cs-symref");
      reg.delete("cs-symref-cur");
    };
  }, [symFocus?.name, symFocus?.active, symRefs]);

  // Esc 关闭引用面板（仅打开时挂监听）
  useEffect(() => {
    if (!symFocus) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key === "Escape") setSymFocus(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [symFocus]);

  // 激活行进列表可视区：只调 scrollTop，不用 scrollIntoView（会连带滚动代码区）
  useEffect(() => {
    const list = symListRef.current;
    if (!list) return;
    const el = list.querySelector(".symref-row.active");
    if (!(el instanceof HTMLElement)) return;
    const lRect = list.getBoundingClientRect();
    const eRect = el.getBoundingClientRect();
    if (eRect.top < lRect.top) list.scrollTop += eRect.top - lRect.top;
    else if (eRect.bottom > lRect.bottom) list.scrollTop += eRect.bottom - lRect.bottom;
  }, [symFocus?.active, symRefs]);

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

  // 待回看草稿可选目标：来源段之后的所有段（末段只能「仅加入待回看」）
  const draftSrcIdx = pendingRevisit
    ? session.slices.findIndex((s) => s.id === pendingRevisit.sliceId)
    : -1;
  const draftTargets = draftSrcIdx >= 0 ? session.slices.slice(draftSrcIdx + 1) : [];
  // 仅在自动模式下等待 AI 结果时禁用保存；用户手动选了目标或「仅加入待回看」即可立即保存
  const autoPending =
    revisitManualTarget === null &&
    draftTargets.length > 0 &&
    (revisitSuggestion.kind === "idle" || revisitSuggestion.kind === "loading");
  const revisitAutoLabel =
    revisitSuggestion.kind === "matched"
      ? `AI 建议：${session.slices.find((s) => s.id === revisitSuggestion.sliceId)?.title ?? "目标段"}`
      : revisitSuggestion.kind === "unmatched"
        ? "AI 未找到相关段落"
        : revisitSuggestion.kind === "error"
          ? "AI 判断失败，请手动选择"
          : "AI 正在查找最后一处相关段落…";

  function revisitRow(e: RevisitEntry) {
    const src = session.slices.find((s) => s.id === e.sliceId);
    const tgt = e.reminder.targetSliceId
      ? session.slices.find((s) => s.id === e.reminder.targetSliceId)
      : undefined;
    return (
      <div className="rv-item" key={e.reminder.id}>
        <button
          className="rv-text"
          disabled={streaming}
          onClick={() => jumpToRevisit(e)}
          title="跳转到标记位置"
        >
          「{e.reminder.excerpt || "…"}」
        </button>
        <div className="rv-meta">
          <span className="rv-src" title={src?.title}>
            自 {src?.title ?? "已删除段落"}
          </span>
          {e.reminder.targetSliceId && (
            <span className="rv-tgt" title={tgt?.title}>
              → {tgt?.title ?? "目标段已删"}
            </span>
          )}
        </div>
        <button className="link rv-done" onClick={() => markRevisited(e)}>
          标为已回看
        </button>
      </div>
    );
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
            {splitLine === null && (
              <span className="code-toolbar-hint sym-hint">双击函数/变量名查看调用关系</span>
            )}
          </div>
          <Highlight theme={prismTheme} code={session.code} language={session.language}>
            {({ tokens, getLineProps, getTokenProps }) => (
              <pre className="code-pre" onDoubleClick={onCodeDoubleClick}>
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
                    symFocus && symRefs[symFocus.active]?.line === lineNo ? "ref-active" : "",
                  ].join(" ");
                  return (
                    <div
                      key={i}
                      id={`cl-${lineNo}`}
                      {...getLineProps({ line: lineTokens })}
                      className={cls}
                      style={{ borderLeftColor: SLICE_COLORS[si % SLICE_COLORS.length] }}
                      onClick={(e) => {
                        // 双击的第二击不切段/不设拆分点；首击记录 caret 供双击用
                        if (e.detail > 1) return;
                        const content = e.currentTarget.querySelector(".line-content");
                        clickSymRef.current = {
                          line: lineNo,
                          col:
                            content instanceof HTMLElement &&
                            e.target instanceof Node &&
                            content.contains(e.target)
                              ? caretTextOffset(content, e.clientX, e.clientY)
                              : null,
                          t: performance.now(),
                        };
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
          {symFocus && (
            <div className="symref-panel">
              <div className="symref-head">
                <strong className="symref-name">「{symFocus.name}」</strong>
                <span className="symref-summary">
                  {symRefs.length === 1
                    ? "文件内只出现这一处"
                    : `共 ${symRefs.length} 处` +
                      SYM_KIND_ORDER.map(({ kind, label }) => {
                        const n = symRefs.filter((r) => r.kind === kind).length;
                        return n ? ` · ${label} ${n}` : "";
                      }).join("")}
                </span>
                <span className="symref-nav">
                  <button
                    type="button"
                    title="上一处"
                    disabled={!symRefs.length}
                    onClick={() =>
                      jumpToRef((symFocus.active - 1 + symRefs.length) % symRefs.length)
                    }
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    title="下一处"
                    disabled={!symRefs.length}
                    onClick={() => jumpToRef((symFocus.active + 1) % symRefs.length)}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    title="关闭（Esc）"
                    onClick={() => setSymFocus(null)}
                  >
                    ✕
                  </button>
                </span>
              </div>
              <div className="symref-list" ref={symListRef}>
                {symRefs.slice(0, 300).map((r, i) => {
                  const seg = sliceIndexAt(session.slices, r.line);
                  const isOrigin =
                    r.line === symFocus.originLine && r.col === symFocus.originCol;
                  return (
                    <button
                      type="button"
                      key={`${r.line}:${r.col}`}
                      className={`symref-row${i === symFocus.active ? " active" : ""}`}
                      onClick={() => jumpToRef(i)}
                    >
                      <span className={`symref-kind k-${r.kind}`}>
                        {SYM_KIND_TAG[r.kind] ?? r.kind}
                      </span>
                      <span className="symref-ln">L{r.line}</span>
                      <code className="symref-text">{r.text}</code>
                      <span className="symref-where">
                        {[
                          r.scope ? `在 ${r.scope} 中` : "",
                          seg >= 0 ? `第 ${seg + 1} 段` : "",
                          isOrigin ? "双击处" : "",
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </button>
                  );
                })}
                {symRefs.length > 300 && (
                  <div className="symref-more">仅显示前 300 处</div>
                )}
              </div>
            </div>
          )}
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
                {(revisitEntries.length > 0 || pendingRevisit) && (
                  <button
                    type="button"
                    className="header-action-btn"
                    aria-expanded={revisitOpen}
                    onClick={() => setRevisitOpen((open) => !open)}
                  >
                    以后再看 ({revisitEntries.length}) {revisitOpen ? "▾" : "▸"}
                  </button>
                )}
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
            {(pendingRevisit || (revisitOpen && revisitEntries.length > 0)) && (
              <div className="revisit-panel">
                {pendingRevisit && (
                  <div className="rv-draft">
                    <div className="rv-draft-excerpt">
                      ⏳「{pendingRevisit.anchor.excerpt || "…"}」
                    </div>
                    <select
                      className="rv-select"
                      value={revisitManualTarget ?? "__auto__"}
                      onChange={(e) =>
                        setRevisitManualTarget(
                          e.target.value === "__auto__" ? null : e.target.value
                        )
                      }
                    >
                      <option value="__auto__">{revisitAutoLabel}</option>
                      {draftTargets.map((s) => (
                        <option key={s.id} value={s.id}>
                          到「{s.title}」时提醒
                        </option>
                      ))}
                      <option value="">仅加入待回看</option>
                    </select>
                    <div className="rv-draft-ops">
                      <button
                        className="primary"
                        disabled={autoPending}
                        title={autoPending ? "AI 正在查找相关段落…" : undefined}
                        onClick={saveRevisit}
                      >
                        保存
                      </button>
                      <button
                        className="link"
                        onClick={() => setPendingRevisit(null)}
                      >
                        取消
                      </button>
                    </div>
                  </div>
                )}
                {revisitOpen && (
                  <div className="rv-list">
                    {revisitEntries.map((e) => revisitRow(e))}
                  </div>
                )}
              </div>
            )}
            {dueRevisit.length > 0 && (
              <div className="revisit-due">
                <div className="revisit-due-head">
                  ⏰ 到这一段了，有 {dueRevisit.length} 处待回看
                </div>
                <div className="rv-due-items">
                  {dueRevisit.map((e) => revisitRow(e))}
                </div>
              </div>
            )}
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
