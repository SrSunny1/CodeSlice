import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ComponentProps,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import AutoTextarea from "./AutoTextarea";
import { loadLayout, saveLayout } from "./layout";
import { countTree, indexTree, pathKey, type IndexNode } from "./threads";
import type {
  ChatMsg,
  InlineThread,
  MarkColor,
  MsgPath,
  TextMark,
  ThreadPath,
} from "./types";

type MdComponents = ComponentProps<typeof Markdown>["components"];

const MARK_COLORS: MarkColor[] = ["y", "g", "b", "p"];
const COLOR_LABEL: Record<MarkColor, string> = { y: "黄", g: "绿", b: "蓝", p: "粉" };

function trunc(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

// ---- CSS Custom Highlight API 的兼容包装（低版本浏览器自动降级为不可标注） ----
interface HighlightRegistryLike {
  set(name: string, h: object): void;
  delete(name: string): void;
}
function hlRegistry(): HighlightRegistryLike | undefined {
  return (globalThis as { CSS?: { highlights?: HighlightRegistryLike } }).CSS?.highlights;
}
function makeHighlight(ranges: Range[]): object | null {
  const H = (globalThis as { Highlight?: new (...r: Range[]) => object }).Highlight;
  return H ? new H(...ranges) : null;
}
function marksSupported(): boolean {
  return !!hlRegistry() && !!(globalThis as { Highlight?: unknown }).Highlight;
}

// ---- 宿主通过 ThreadCtx 提供追问/标注回调；无 provider 时退化为纯渲染 ----
export interface ThreadCtxValue {
  /** 当前消息列表（嵌套实例各自对应自己的列表） */
  messages: ChatMsg[];
  /** 追问轮次表：pathKey(threadPath) -> 该回答内的轮次（1 起） */
  rounds: ReadonlyMap<string, number>;
  /** 有任何流式请求在跑（禁用各发送按钮） */
  busy: boolean;
  /** 正在流式输出的线程 pathKey，主对话为 null */
  streamingKey: string | null;
  streamText: string;
  /** 追问里是否显示 简洁/详细 切换（Reader 开，概览页关） */
  showDetail: boolean;
  /** 宿主追加的 react-markdown components（如文件链接），必须 useMemo 保持稳定 */
  components?: MdComponents;
  onMarks(mp: MsgPath, marks: TextMark[] | undefined): void;
  onAsk(
    mp: MsgPath,
    anchor: { start: number; end: number; blockEnd: number; quote: string },
    question: string
  ): void;
  onReply(tp: ThreadPath, question: string): void;
  onPatchThread(
    tp: ThreadPath,
    patch: Partial<Pick<InlineThread, "collapsed" | "detail">>
  ): void;
  onDeleteThread(tp: ThreadPath): void;
  onAbort(): void;
}
export const ThreadCtx = createContext<ThreadCtxValue | null>(null);

// ---- 全局标注注册表：每个实例的 Range 按颜色（有无备注）汇总注册；
//      追问锚点统一注册进 cs-thread；MarkRail 也从这里取点位信息 ----
interface MarkEntry {
  range: Range;
  ranges: Range[];
  mark: TextMark;
  msgPath: MsgPath;
  markIdx: number;
}
interface InstMarks {
  root: HTMLElement;
  entries: MarkEntry[];
  threadRanges: Range[];
}
const rangeStore = new Map<string, InstMarks>();
const markListeners = new Set<() => void>();
let notifyQueued = false;
function notifyMarks() {
  if (notifyQueued) return;
  notifyQueued = true;
  queueMicrotask(() => {
    notifyQueued = false;
    markListeners.forEach((f) => f());
  });
}
export function subscribeMarks(fn: () => void): () => void {
  markListeners.add(fn);
  return () => {
    markListeners.delete(fn);
  };
}

function setReg(reg: HighlightRegistryLike, name: string, ranges: Range[]) {
  const h = ranges.length ? makeHighlight(ranges) : null;
  if (h) reg.set(name, h);
  else reg.delete(name);
}
function rebuildHighlights() {
  const reg = hlRegistry();
  if (!reg) return;
  const buckets = new Map<MarkColor, { plain: Range[]; noted: Range[] }>();
  const threadAll: Range[] = [];
  for (const inst of rangeStore.values()) {
    for (const e of inst.entries) {
      const b = buckets.get(e.mark.color) ?? { plain: [], noted: [] };
      (e.mark.note ? b.noted : b.plain).push(...e.ranges);
      buckets.set(e.mark.color, b);
    }
    threadAll.push(...inst.threadRanges);
  }
  for (const c of MARK_COLORS) {
    const b = buckets.get(c) ?? { plain: [], noted: [] };
    setReg(reg, `cs-mark-${c}`, b.plain);
    setReg(reg, `cs-mark-${c}n`, b.noted);
  }
  setReg(reg, "cs-thread", threadAll);
  notifyMarks();
}

// ---- 渲染后文本偏移量 <-> DOM Range；一律跳过 .inline-thread 内的文字，
//      保证偏移量与「不含追问 UI 的正文 textContent」对齐 ----
function textNodes(root: Node): Text[] {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (n instanceof Element)
        return n.classList.contains("inline-thread")
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_SKIP;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const out: Text[] = [];
  let n;
  while ((n = w.nextNode())) out.push(n as Text);
  return out;
}

/** DOM 点（node+offset）对应 root.textContent 里的字符偏移（不含追问 UI）。 */
function pointOffset(root: HTMLElement, node: Node, offset: number): number {
  const nodes = textNodes(root);
  let acc = 0;
  const test = document.createRange();
  for (const t of nodes) {
    if (t === node) return acc + Math.min(offset, t.data.length);
    test.selectNodeContents(t);
    let c: number;
    try {
      c = test.comparePoint(node, offset);
    } catch {
      return acc;
    }
    if (c < 0) return acc;
    if (c === 0) {
      // node 不是文本节点时只能落在 t 的边界上：区分起点/终点边界
      test.collapse(false);
      try {
        if (test.comparePoint(node, offset) < 0) return acc;
      } catch {
        return acc;
      }
    }
    acc += t.data.length;
  }
  return acc;
}

function setPointAt(nodes: Text[], off: number): { node: Text; offset: number } {
  let acc = 0;
  for (const t of nodes) {
    if (off <= acc + t.data.length) return { node: t, offset: off - acc };
    acc += t.data.length;
  }
  const last = nodes[nodes.length - 1];
  return { node: last, offset: last.data.length };
}

/** textContent 偏移区间 -> Range，越界自动收敛到 root 内。 */
export function rangeForText(root: HTMLElement, start: number, end: number): Range | null {
  const nodes = textNodes(root);
  if (!nodes.length || end <= start) return null;
  const total = nodes.reduce((a, t) => a + t.data.length, 0);
  const s = Math.max(0, Math.min(start, total));
  const e = Math.max(0, Math.min(end, total));
  if (e <= s) return null;
  const r = document.createRange();
  const ps = setPointAt(nodes, s);
  const pe = setPointAt(nodes, e);
  r.setStart(ps.node, ps.offset);
  r.setEnd(pe.node, pe.offset);
  return r;
}

/** 同 rangeForText，但按文本节点拆成多段：跨过追问时不会把追问 UI 涂进高亮。 */
export function rangesForText(root: HTMLElement, start: number, end: number): Range[] {
  const nodes = textNodes(root);
  const out: Range[] = [];
  let acc = 0;
  for (const t of nodes) {
    const tEnd = acc + t.data.length;
    const s = Math.max(start, acc);
    const e = Math.min(end, tEnd);
    if (e > s) {
      const r = document.createRange();
      r.setStart(t, s - acc);
      r.setEnd(t, e - acc);
      out.push(r);
    }
    acc = tEnd;
    if (acc >= end) break;
  }
  return out;
}

/** 选区终点向上找最近的 data-src-end 块（限定在 root 内）；找不到返回 -1。 */
function findBlockEnd(root: HTMLElement, node: Node): number {
  let el: Node | null = node;
  while (el && el !== root) {
    if (el instanceof Element) {
      const v = el.getAttribute("data-src-end");
      if (v != null) return Number(v);
    }
    el = el.parentNode;
  }
  return -1;
}

function overlaps(m: TextMark, start: number, end: number): boolean {
  return m.start < end && m.end > start;
}

// ---------------- 块级锚定：p/li/pre/blockquote/h1-h6/table 后挂追问 ----------------
interface BlockCtxValue {
  byBlock: Map<number, InlineThread[]>;
  path: MsgPath;
}
const BlockCtx = createContext<BlockCtxValue | null>(null);

interface BlockProps {
  node?: { position?: { end?: { offset?: number } } };
  children?: React.ReactNode;
  [key: string]: unknown;
}

/** 生成模块级稳定的块组件：带 data-src-end，并把 blockEnd 匹配的追问挂到块后。
 *  必须是模块级组件——渲染期新建组件会让子树 remount、文字节点重建、Range 全塌。 */
function makeBlockComp(tag: string, inside: boolean) {
  return function AnchoredBlock({ node, children, ...rest }: BlockProps) {
    const bc = useContext(BlockCtx);
    const off = node?.position?.end?.offset;
    const list = off != null ? bc?.byBlock.get(off) : undefined;
    const kids =
      bc && list?.length
        ? list.map((t) => <InlineThreadBlock key={t.id} t={t} tp={[...bc.path, t.id]} />)
        : null;
    if (inside) {
      return createElement(tag, { ...rest, "data-src-end": off }, children, kids);
    }
    return (
      <>
        {createElement(tag, { ...rest, "data-src-end": off }, children)}
        {kids}
      </>
    );
  };
}

const BLOCK_COMPONENTS: Record<string, (p: BlockProps) => React.ReactNode> = {
  p: makeBlockComp("p", false),
  li: makeBlockComp("li", true),
  pre: makeBlockComp("pre", false),
  blockquote: makeBlockComp("blockquote", false),
  table: makeBlockComp("table", false),
  h1: makeBlockComp("h1", false),
  h2: makeBlockComp("h2", false),
  h3: makeBlockComp("h3", false),
  h4: makeBlockComp("h4", false),
  h5: makeBlockComp("h5", false),
  h6: makeBlockComp("h6", false),
};

// ---------------- 内嵌追问线程块 ----------------
function InlineThreadBlock({ t, tp }: { t: InlineThread; tp: ThreadPath }) {
  const ctx = useContext(ThreadCtx);
  const selfRef = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState("");
  const depth = tp.length / 2;
  const collapsed = !!t.collapsed;
  const turns = t.messages.filter((m) => m.role === "user").length;
  const key = pathKey(tp);
  const streaming = ctx?.streamingKey === key;
  // 轮次（每条回答内按文档序编号）：决定底色色相和块头「第 N 轮」
  const round = ctx?.rounds.get(key) ?? 0;
  const colorIdx = round > 0 ? (round - 1) % 5 : 0;

  function sendReply() {
    const text = q.trim();
    if (!text || !ctx || ctx.busy) return;
    ctx.onReply(tp, text);
    setQ("");
  }

  function collapseAndRead() {
    ctx?.onPatchThread(tp, { collapsed: true });
    requestAnimationFrame(() => {
      const scroller = selfRef.current?.closest(".chat-messages, .overview-body");
      if (!(scroller instanceof HTMLElement)) return;
      const parentKey = pathKey(tp.slice(0, -1));
      const root = scroller.querySelector(`[data-mark-root="${parentKey}"]`);
      if (!(root instanceof HTMLElement)) return;
      const r = rangeForText(root, t.start, t.end);
      if (r) revealRange(scroller, r, { select: false, ratio: 1 / 3 });
    });
  }

  return (
    <div
      ref={selfRef}
      className={`inline-thread it-depth-${Math.min(depth, 4)} it-c${colorIdx}`}
      data-thread-host={t.id}
      data-thread-path={key}
    >
      <button
        className="it-head"
        onClick={() => ctx?.onPatchThread(tp, { collapsed: !collapsed })}
      >
        <span className="it-caret">{collapsed ? "▸" : "▾"}</span>
        {round > 0 && <span className="it-round">第{round}轮</span>}
        <span className="it-title">
          追问「{trunc(t.quote, 30)}」 · {turns} 问
        </span>
        <span className="it-badge">追问</span>
        {depth >= 4 && <span className="it-depth-tag">第 {depth} 层</span>}
      </button>
      {!collapsed && (
        <div className="it-body">
          {t.messages.map((m, j) => {
            const mp: MsgPath = [...tp, j];
            return (
              <div key={j} className={`msg ${m.role}`} data-msg-path={pathKey(mp)}>
                {m.role === "assistant" ? (
                  <MarkableMarkdown msg={m} path={mp} />
                ) : (
                  <div className="user-text">{m.content}</div>
                )}
              </div>
            );
          })}
          {streaming && (
            <div className="msg assistant">
              <Markdown remarkPlugins={[remarkGfm]}>{ctx?.streamText || "…"}</Markdown>
              <span className="cursor">▍</span>
            </div>
          )}
          <div className="it-input input-row">
            <AutoTextarea
              placeholder={streaming ? "正在回答…" : "继续追问…"}
              value={q}
              disabled={!!ctx?.busy}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendReply();
                }
              }}
            />
            {streaming ? (
              <button onClick={() => ctx?.onAbort()}>中止</button>
            ) : (
              <button
                className="primary"
                disabled={!!ctx?.busy || !q.trim()}
                onClick={sendReply}
              >
                发送
              </button>
            )}
          </div>
          <div className="it-ops">
            {ctx?.showDetail && (
              <div className="detail-toggle">
                <button
                  className={(t.detail ?? "brief") === "brief" ? "active" : ""}
                  title="简短回答"
                  onClick={() => ctx.onPatchThread(tp, { detail: "brief" })}
                >
                  简洁
                </button>
                <button
                  className={(t.detail ?? "brief") === "deep" ? "active" : ""}
                  title="更详细的回答"
                  onClick={() => ctx.onPatchThread(tp, { detail: "deep" })}
                >
                  详细
                </button>
              </div>
            )}
            <button
              className="link"
              onClick={() => ctx?.onPatchThread(tp, { collapsed: true })}
            >
              收起
            </button>
            <button className="link" onClick={collapseAndRead}>
              收起并继续阅读
            </button>
            <button
              className="link danger"
              onClick={() => {
                if (window.confirm("删除这个追问及其中所有回答？")) ctx?.onDeleteThread(tp);
              }}
            >
              删除
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------- 调色板浮板 ----------------
interface PalState {
  x: number;
  y: number;
  below: boolean;
  /** 有选区：对 [start,end) 新增/擦除/发起追问 */
  range?: { start: number; end: number; blockEnd: number; quote: string };
  /** 点中已有标注：改色/删除/备注 */
  markIdx?: number;
  editingNote: boolean;
  noteDraft: string;
  /** 追问输入模式 */
  ask: boolean;
  askDraft: string;
}

/**
 * 可标注、可追问的 Markdown：选中文字弹出调色板，可填色、写备注或就地发起追问；
 * 标注/追问锚点以 textContent 偏移量持久化，用 CSS Custom Highlight API 渲染。
 */
export default function MarkableMarkdown({ msg, path }: { msg: ChatMsg; path: MsgPath }) {
  const ctx = useContext(ThreadCtx);
  const boxRef = useRef<HTMLDivElement>(null);
  const palRef = useRef<HTMLDivElement>(null);
  const instId = useId();
  const markable = !!ctx && marksSupported();
  const [pal, setPal] = useState<PalState | null>(null);
  const marksRef = useRef(msg.marks);
  marksRef.current = msg.marks;
  const threads = useMemo(() => msg.threads ?? [], [msg.threads]);

  const byBlock = useMemo(() => {
    const m = new Map<number, InlineThread[]>();
    for (const t of threads) {
      if (t.blockEnd < 0) continue;
      const l = m.get(t.blockEnd) ?? [];
      l.push(t);
      m.set(t.blockEnd, l);
    }
    return m;
  }, [threads]);
  const blockCtx = useMemo<BlockCtxValue>(() => ({ byBlock, path }), [byBlock, path]);

  const components = useMemo(
    () => ({ ...BLOCK_COMPONENTS, ...ctx?.components }) as MdComponents,
    [ctx?.components]
  );

  // blockEnd >=0 但锚块没渲染出来的线程，补到消息末尾（.md-tail）
  const [orphans, setOrphans] = useState<ReadonlySet<string>>(new Set());
  useLayoutEffect(() => {
    const root = boxRef.current;
    if (!root) return;
    const missing = new Set<string>();
    for (const t of threads) {
      if (t.blockEnd < 0) continue;
      const anchored = [...root.querySelectorAll(`[data-thread-host="${t.id}"]`)].some(
        (h) => !h.closest(".md-tail")
      );
      if (!anchored) missing.add(t.id);
    }
    setOrphans((prev) =>
      prev.size === missing.size && [...prev].every((x) => missing.has(x)) ? prev : missing
    );
  });
  const tail = threads.filter((t) => t.blockEnd < 0 || orphans.has(t.id));

  // 把持久化的偏移量还原成 Range 并注册到全局 highlight
  useLayoutEffect(() => {
    const root = boxRef.current;
    if (!root || !markable) return;
    const entries: MarkEntry[] = [];
    (msg.marks ?? []).forEach((m, markIdx) => {
      const r = rangeForText(root, m.start, m.end);
      const rs = rangesForText(root, m.start, m.end);
      if (r && rs.length)
        entries.push({ range: r, ranges: rs, mark: m, msgPath: path, markIdx });
    });
    const threadRanges = threads.flatMap((t) => rangesForText(root, t.start, t.end));
    rangeStore.set(instId, { root, entries, threadRanges });
    rebuildHighlights();
    return () => {
      rangeStore.delete(instId);
      rebuildHighlights();
    };
  }, [msg.content, msg.marks, threads, markable, instId]);

  // 消息内容变化（如换 slice）时关掉浮板
  useEffect(() => setPal(null), [msg.content]);

  // 点外部 / 滚动 / Esc 关闭浮板
  useEffect(() => {
    if (!pal) return;
    const close = () => setPal(null);
    const onDown = (e: MouseEvent) => {
      if (palRef.current && !palRef.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("scroll", close, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("scroll", close, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [pal]);

  function onMouseUp(e: ReactMouseEvent<HTMLDivElement>) {
    if (!markable || !ctx || e.button !== 0) return;
    const root = boxRef.current;
    const sel = window.getSelection();
    if (!root || !sel || sel.rangeCount === 0) return;
    if (!root.contains(sel.anchorNode) || !root.contains(sel.focusNode)) return;
    // 选区落在内嵌追问里时交给那个实例自己处理（事件会冒泡到父实例）
    const inThread = (n: Node | null) => {
      const el = n instanceof Element ? n : n?.parentElement;
      const it = el?.closest(".inline-thread");
      return !!it && root.contains(it);
    };
    if (inThread(sel.anchorNode) || inThread(sel.focusNode)) return;

    const posFor = (r: Range | null): Pick<PalState, "x" | "y" | "below"> | null => {
      const rc = r?.getBoundingClientRect();
      if (!rc || (rc.width === 0 && rc.height === 0)) return null;
      return {
        x: Math.min(Math.max(rc.left + rc.width / 2, 80), window.innerWidth - 80),
        y: rc.top < 56 ? rc.bottom + 8 : rc.top - 8,
        below: rc.top < 56,
      };
    };

    if (sel.isCollapsed) {
      // 单击落在已有标注内 -> 打开该标注的编辑浮板（右缘归前一段）
      const off = pointOffset(root, sel.anchorNode!, sel.anchorOffset);
      const idx = (marksRef.current ?? []).findIndex((m) => off > m.start && off <= m.end);
      if (idx < 0) return;
      const m = marksRef.current![idx];
      const pos = posFor(rangeForText(root, m.start, m.end));
      if (pos)
        setPal({
          ...pos,
          markIdx: idx,
          editingNote: !!m.note,
          noteDraft: m.note ?? "",
          ask: false,
          askDraft: "",
        });
      return;
    }
    const a = pointOffset(root, sel.anchorNode!, sel.anchorOffset);
    const b = pointOffset(root, sel.focusNode!, sel.focusOffset);
    const start = Math.min(a, b);
    const end = Math.max(a, b);
    if (end - start < 1) return;
    const rng = sel.getRangeAt(0);
    const pos = posFor(rng);
    if (pos)
      setPal({
        ...pos,
        range: {
          start,
          end,
          blockEnd: findBlockEnd(root, rng.endContainer),
          quote: sel.toString().replace(/\s+/g, " ").trim().slice(0, 500),
        },
        editingNote: false,
        noteDraft: "",
        ask: false,
        askDraft: "",
      });
  }

  function emit(next: TextMark[]) {
    ctx?.onMarks(path, next.length ? next : undefined);
    setPal(null);
    window.getSelection()?.removeAllRanges();
  }

  function applyColor(color: MarkColor) {
    const cur = marksRef.current ?? [];
    if (pal?.markIdx != null) {
      const next = cur.map((m, i) => (i === pal.markIdx ? { ...m, color } : m));
      if (pal.editingNote) {
        // 编辑备注时保持浮板不关
        ctx?.onMarks(path, next.length ? next : undefined);
        setPal({ ...pal });
      } else {
        emit(next);
      }
    } else if (pal?.range) {
      const { start, end } = pal.range;
      const next = cur.filter((m) => !overlaps(m, start, end));
      next.push({ start, end, color });
      next.sort((a, b) => a.start - b.start);
      emit(next);
    }
  }

  function erase() {
    const cur = marksRef.current ?? [];
    if (pal?.markIdx != null) {
      emit(cur.filter((_, i) => i !== pal.markIdx));
    } else if (pal?.range) {
      const { start, end } = pal.range;
      emit(cur.filter((m) => !overlaps(m, start, end)));
    }
  }

  function startNote() {
    const cur = marksRef.current ?? [];
    if (pal?.markIdx != null) {
      const m = cur[pal.markIdx];
      setPal({ ...pal, editingNote: true, noteDraft: m?.note ?? "" });
      return;
    }
    if (!pal?.range) return;
    // 选区写备注：先落成黄色底标（备注颜色可再改），再就地编辑
    const { start, end } = pal.range;
    const next = cur.filter((m) => !overlaps(m, start, end));
    next.push({ start, end, color: "y" });
    next.sort((a, b) => a.start - b.start);
    const idx = next.findIndex((m) => m.start === start && m.end === end);
    ctx?.onMarks(path, next);
    setPal({ ...pal, markIdx: idx, range: undefined, editingNote: true, noteDraft: "" });
  }

  function saveNote() {
    const cur = marksRef.current ?? [];
    if (pal?.markIdx == null) return;
    const note = pal.noteDraft.trim();
    emit(
      cur.map((m, i) => (i === pal.markIdx ? { ...m, note: note || undefined } : m))
    );
  }

  function sendAsk() {
    if (!pal?.range || !ctx) return;
    const text = pal.askDraft.trim();
    if (!text || ctx.busy) return;
    ctx.onAsk(path, pal.range, text);
    setPal(null);
    window.getSelection()?.removeAllRanges();
  }

  return (
    <div
      className="md-mark"
      ref={boxRef}
      onMouseUp={onMouseUp}
      data-mark-root={pathKey(path)}
    >
      <BlockCtx.Provider value={blockCtx}>
        <Markdown remarkPlugins={[remarkGfm]} components={components}>
          {msg.content}
        </Markdown>
      </BlockCtx.Provider>
      {tail.length > 0 && (
        <div className="md-tail">
          {tail.map((t) => (
            <InlineThreadBlock key={t.id} t={t} tp={[...path, t.id]} />
          ))}
        </div>
      )}
      {pal &&
        createPortal(
          <div
            ref={palRef}
            className={`mark-pal${pal.below ? " below" : ""}${
              pal.editingNote || pal.ask ? " editing" : ""
            }`}
            style={{ left: pal.x, top: pal.y }}
            onMouseDown={(e) => {
              // 输入框要能聚焦，其余区域阻止默认行为以保留文字选区
              if ((e.target as HTMLElement).tagName !== "TEXTAREA") e.preventDefault();
            }}
            onMouseUp={(e) => e.stopPropagation()}
          >
            {pal.ask ? (
              <div className="mark-note-editor">
                <textarea
                  autoFocus
                  rows={3}
                  placeholder="就这处提问…（Enter 发送，Shift+Enter 换行）"
                  value={pal.askDraft}
                  onChange={(e) => setPal({ ...pal, askDraft: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      sendAsk();
                    }
                  }}
                />
                <button
                  className="link"
                  disabled={!pal.askDraft.trim() || ctx?.busy}
                  onClick={sendAsk}
                >
                  发送
                </button>
              </div>
            ) : (
              <>
                <div className="mark-pal-row">
                  {MARK_COLORS.map((c) => (
                    <button
                      key={c}
                      className={`mark-dot ${c}`}
                      title={`${COLOR_LABEL[c]}色标注`}
                      onClick={() => applyColor(c)}
                    />
                  ))}
                  <button className="mark-note" title="写文字标注" onClick={startNote}>
                    ✎
                  </button>
                  {pal.range && (
                    <button
                      className="mark-ask"
                      title="就这处发起追问"
                      onClick={() => setPal({ ...pal, ask: true, askDraft: "" })}
                    >
                      💬 追问
                    </button>
                  )}
                  <button className="mark-erase" title="清除标注" onClick={erase}>
                    清除
                  </button>
                </div>
                {pal.editingNote && (
                  <div className="mark-note-editor">
                    <textarea
                      autoFocus
                      rows={3}
                      placeholder="写点标注…（Ctrl+Enter 保存）"
                      value={pal.noteDraft}
                      onChange={(e) => setPal({ ...pal, noteDraft: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) saveNote();
                      }}
                    />
                    <button className="link" onClick={saveNote}>
                      保存
                    </button>
                  </div>
                )}
              </>
            )}
          </div>,
          document.body
        )}
    </div>
  );
}

/** 把 Range 滚到滚动容器内指定比例位置；select=false 时不再临时选中。 */
export function revealRange(
  scroller: HTMLElement,
  range: Range,
  opts?: { select?: boolean; ratio?: number }
) {
  const rc = range.getClientRects()[0];
  if (!rc) return;
  const ratio = opts?.ratio ?? 0.5;
  const cRect = scroller.getBoundingClientRect();
  const top = rc.top - cRect.top + scroller.scrollTop;
  scroller.scrollTo({
    top: top + rc.height / 2 - scroller.clientHeight * ratio,
    behavior: "smooth",
  });
  if (opts?.select === false) return;
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range.cloneRange());
}

// ---------------- 标注导航栏（显示点） ----------------
interface RailDot {
  top: number;
  color: MarkColor;
  hasNote: boolean;
  excerpt: string;
  note?: string;
  range: Range;
  msgPath: MsgPath;
  markIdx: number;
  dotKey: string;
}

function sameDots(a: RailDot[], b: RailDot[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (x, i) =>
        x.top === b[i].top &&
        x.color === b[i].color &&
        x.hasNote === b[i].hasNote &&
        x.excerpt === b[i].excerpt &&
        x.note === b[i].note &&
        x.dotKey === b[i].dotKey
    )
  );
}

/** 放进滚动容器内部：每个标注一个点，点击跳转并高亮选中，右键删除。 */
export function MarkRail({
  containerRef,
  onDeleteMark,
}: {
  containerRef: RefObject<HTMLElement | null>;
  onDeleteMark?: (mp: MsgPath, markIdx: number) => void;
}) {
  const [dots, setDots] = useState<RailDot[]>([]);
  const [, bump] = useReducer((x: number) => x + 1, 0);

  useEffect(() => subscribeMarks(bump), []);

  // 每次渲染后重算点位（父组件更新/标注变化/自身 bump 都会走到这里）
  useLayoutEffect(() => {
    const c = containerRef.current;
    if (!c) return;
    const cRect = c.getBoundingClientRect();
    const found: RailDot[] = [];
    for (const inst of rangeStore.values()) {
      if (!c.contains(inst.root)) continue;
      for (const e of inst.entries) {
        const rc = e.range.getClientRects()[0];
        if (!rc) continue;
        found.push({
          top: rc.top - cRect.top + c.scrollTop,
          color: e.mark.color,
          hasNote: !!e.mark.note,
          excerpt: e.range.toString().replace(/\s+/g, " ").trim().slice(0, 50),
          note: e.mark.note,
          range: e.range,
          msgPath: e.msgPath,
          markIdx: e.markIdx,
          dotKey: `${pathKey(e.msgPath)}:${e.markIdx}`,
        });
      }
    }
    found.sort((a, b) => a.top - b.top);
    setDots((prev) => (sameDots(prev, found) ? prev : found));
  });

  // 容器尺寸变化（拖分栏/窗口缩放）时重算
  useEffect(() => {
    const c = containerRef.current;
    if (!c) return;
    const ro = new ResizeObserver(bump);
    ro.observe(c);
    return () => ro.disconnect();
  }, [containerRef]);

  function jump(d: RailDot) {
    const c = containerRef.current;
    if (c) revealRange(c, d.range);
  }

  return (
    <>
      {dots.map((d, i) => (
        <button
          key={i}
          className={`mark-rail-dot m-${d.color}${d.hasNote ? " note" : ""}`}
          style={{ top: d.top }}
          title={`${d.hasNote ? "📝 " + (d.note ?? "") : ""}${d.excerpt}`}
          onClick={() => jump(d)}
          onContextMenu={(e) => {
            if (!onDeleteMark) return;
            e.preventDefault();
            if (window.confirm("删除这条标注？")) onDeleteMark(d.msgPath, d.markIdx);
          }}
        />
      ))}
    </>
  );
}

// ---------------- 问答 + 标注 + 追问索引（聊天区左缘，可展开成树面板） ----------------

function scrollElCenter(scroller: HTMLElement, el: Element) {
  const rc = el.getBoundingClientRect();
  const cRect = scroller.getBoundingClientRect();
  scroller.scrollTo({
    top: rc.top - cRect.top + scroller.scrollTop + rc.height / 2 - scroller.clientHeight / 2,
    behavior: "smooth",
  });
}

interface IndexRowsProps {
  nodes: IndexNode[];
  closed: ReadonlySet<string>;
  excerpts: Record<string, string>;
  onToggle: (key: string) => void;
  onJump: (n: IndexNode) => void;
  onCtx: (e: React.MouseEvent, n: IndexNode) => void;
}

function IndexRows({ nodes, closed, excerpts, onToggle, onJump, onCtx }: IndexRowsProps) {
  return (
    <>
      {nodes.map((n) => {
        if (n.kind === "thread") {
          const k = pathKey(n.path);
          const cl = closed.has(k);
          return (
            <div key={`t-${k}`}>
              <div
                className="ci-trow-wrap"
                onContextMenu={(e) => onCtx(e, n)}
              >
                <button className="ci-caret" onClick={() => onToggle(k)}>
                  {cl ? "▸" : "▾"}
                </button>
                <button
                  className="ci-trow"
                  title={`追问：${n.quote}`}
                  onClick={() => onJump(n)}
                >
                  <span className="ci-th">💬</span>
                  <span className="ci-txt">追问：{n.quote}</span>
                </button>
              </div>
              {!cl && (
                <div className="ci-children">
                  <IndexRows
                    nodes={n.children}
                    closed={closed}
                    excerpts={excerpts}
                    onToggle={onToggle}
                    onJump={onJump}
                    onCtx={onCtx}
                  />
                </div>
              )}
            </div>
          );
        }
        const key =
          n.kind === "q" ? `q-${pathKey(n.path)}` : `m-${pathKey(n.path)}-${n.markIdx}`;
        const label =
          n.kind === "q"
            ? n.text
            : n.mark.note || excerpts[`${pathKey(n.path)}:${n.markIdx}`] || "标注";
        return (
          <button
            key={key}
            className="ci-trow"
            title={
              n.kind === "q"
                ? n.text
                : n.mark.note
                  ? `📝 ${n.mark.note}`
                  : excerpts[`${pathKey(n.path)}:${n.markIdx}`] ?? ""
            }
            onClick={() => onJump(n)}
            onContextMenu={(e) => onCtx(e, n)}
          >
            {n.kind === "q" ? (
              <span className="ci-q">问</span>
            ) : (
              <span className={`ci-m m-${n.mark.color}${n.mark.note ? " note" : ""}`} />
            )}
            <span className="ci-txt">{label}</span>
          </button>
        );
      })}
    </>
  );
}

/**
 * 放在聊天滚动容器左侧的索引条：收起时是 34px 图标条（顶层问/注/💬），
 * 展开成 ~220px 树面板（含追问子树）。点击跳转会先展开途经的收起线程。
 */
export function ChatIndex({
  containerRef,
  messages,
  onExpand,
  onDeleteMark,
  onDeleteThread,
}: {
  containerRef: RefObject<HTMLElement | null>;
  messages: ChatMsg[];
  onExpand: (tp: ThreadPath) => void;
  onDeleteMark: (mp: MsgPath, markIdx: number) => void;
  onDeleteThread: (tp: ThreadPath) => void;
}) {
  const [open, setOpen] = useState(() => loadLayout().indexOpen);
  const [treeClosed, setTreeClosed] = useState<ReadonlySet<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; node: IndexNode } | null>(
    null
  );
  const tree = useMemo(() => indexTree(messages), [messages]);
  const counts = useMemo(() => countTree(messages), [messages]);
  const [excerpts, setExcerpts] = useState<Record<string, string>>({});

  // 标注点的文字摘要（tooltip / 树行文字用），每次渲染后重建
  useLayoutEffect(() => {
    const c = containerRef.current;
    if (!c) return;
    const next: Record<string, string> = {};
    const walk = (nodes: IndexNode[]) => {
      for (const n of nodes) {
        if (n.kind === "mark") {
          const root = c.querySelector(`[data-mark-root="${pathKey(n.path)}"]`);
          if (root instanceof HTMLElement) {
            const r = rangeForText(root, n.mark.start, n.mark.end);
            if (r)
              next[`${pathKey(n.path)}:${n.markIdx}`] = r
                .toString()
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 50);
          }
        } else if (n.kind === "thread") walk(n.children);
      }
    };
    walk(tree);
    setExcerpts((prev) => {
      const keys = Object.keys(next);
      const same =
        keys.length === Object.keys(prev).length && keys.every((k) => prev[k] === next[k]);
      return same ? prev : next;
    });
  });

  // 右键菜单：标注/追问节点可删除，问题节点不响应（走浏览器默认菜单）
  function onCtx(e: React.MouseEvent, n: IndexNode) {
    if (n.kind === "q") return;
    e.preventDefault();
    setMenu({
      x: Math.min(e.clientX, window.innerWidth - 200),
      y: Math.min(e.clientY, window.innerHeight - 70),
      node: n,
    });
  }

  // 点外部 / Esc / 滚动时关闭右键菜单
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".ctx-menu")) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    document.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", close, true);
    };
  }, [menu]);

  function toggleTree(key: string) {
    setTreeClosed((prev) => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  }

  function jump(n: IndexNode) {
    const c = containerRef.current;
    if (!c) return;
    // 目标在收起的线程里（或目标本身是线程）→ 先让宿主展开，再滚动
    const need: ThreadPath | null =
      n.kind === "thread"
        ? n.path
        : n.path.length > 1
          ? (n.path.slice(0, -1) as ThreadPath)
          : null;
    const go = () => {
      const c2 = containerRef.current;
      if (!c2) return;
      if (n.kind === "mark") {
        const root = c2.querySelector(`[data-mark-root="${pathKey(n.path)}"]`);
        const r =
          root instanceof HTMLElement ? rangeForText(root, n.mark.start, n.mark.end) : null;
        if (r) revealRange(c2, r);
        return;
      }
      const sel =
        n.kind === "q"
          ? `[data-msg-path="${pathKey(n.path)}"]`
          : `[data-thread-path="${pathKey(n.path)}"]`;
      const el = c2.querySelector(sel);
      if (el) scrollElCenter(c2, el);
    };
    if (need) {
      onExpand(need);
      requestAnimationFrame(() => requestAnimationFrame(go));
    } else {
      go();
    }
  }

  function stripTip(n: IndexNode): string {
    if (n.kind === "q") return n.text;
    if (n.kind === "thread") return `追问：${n.quote}`;
    return n.mark.note
      ? `📝 ${n.mark.note}`
      : excerpts[`${pathKey(n.path)}:${n.markIdx}`] ?? "";
  }

  if (!tree.length) return null;

  return (
    <div className={`chat-index${open ? " open" : ""}`}>
      <button
        className="ci-toggle"
        title={open ? "收起索引" : "展开索引"}
        onClick={() => {
          const n = !open;
          setOpen(n);
          saveLayout({ indexOpen: n });
        }}
      >
        {open ? "⇤" : "⇥"}
      </button>
      <div className="ci-counts">
        <div>问 {counts.questions}</div>
        <div>注 {counts.marks}</div>
      </div>
      {open ? (
        <div className="ci-list tree">
          <IndexRows
            nodes={tree}
            closed={treeClosed}
            excerpts={excerpts}
            onToggle={toggleTree}
            onJump={jump}
            onCtx={onCtx}
          />
        </div>
      ) : (
        <div className="ci-list">
          {tree.map((n, i) => (
            <button
              key={i}
              className="ci-row"
              title={stripTip(n)}
              onClick={() => jump(n)}
              onContextMenu={(e) => onCtx(e, n)}
            >
              {n.kind === "q" ? (
                <span className="ci-q">问</span>
              ) : n.kind === "mark" ? (
                <span className={`ci-m m-${n.mark.color}${n.mark.note ? " note" : ""}`} />
              ) : (
                <span className="ci-th">💬</span>
              )}
            </button>
          ))}
        </div>
      )}
      {menu &&
        createPortal(
          <div className="ctx-menu" style={{ left: menu.x, top: menu.y }}>
            {menu.node.kind === "mark" && (
              <button
                className="ctx-item"
                onClick={() => {
                  const n = menu.node;
                  setMenu(null);
                  if (n.kind === "mark" && window.confirm("删除这条标注？"))
                    onDeleteMark(n.path, n.markIdx);
                }}
              >
                🗑 删除标注
                {menu.node.kind === "mark" && menu.node.mark.note
                  ? `「${trunc(menu.node.mark.note, 16)}」`
                  : ""}
              </button>
            )}
            {menu.node.kind === "thread" && (
              <button
                className="ctx-item"
                onClick={() => {
                  const n = menu.node;
                  setMenu(null);
                  if (
                    n.kind === "thread" &&
                    window.confirm(`删除这个追问及其中 ${n.turns} 轮回答？`)
                  )
                    onDeleteThread(n.path);
                }}
              >
                🗑 删除追问及回答
              </button>
            )}
          </div>,
          document.body
        )}
    </div>
  );
}
