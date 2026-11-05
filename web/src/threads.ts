import type { ChatMsg, InlineThread, MsgPath, TextMark, ThreadPath } from "./types";

export function pathKey(p: (number | string)[]): string {
  return p.join("/");
}

export function newThreadId(): string {
  return `t-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 按 MsgPath 取出消息；路径无效返回 undefined。 */
export function getMsg(msgs: ChatMsg[], mp: MsgPath): ChatMsg | undefined {
  let list = msgs;
  let msg: ChatMsg | undefined;
  for (let i = 0; i < mp.length; i += 2) {
    const idx = mp[i];
    if (typeof idx !== "number") return undefined;
    msg = list[idx];
    if (!msg) return undefined;
    if (i + 1 < mp.length) {
      const t = msg.threads?.find((x) => x.id === mp[i + 1]);
      if (!t) return undefined;
      list = t.messages;
    }
  }
  return msg;
}

/** 按 ThreadPath 取出线程；路径无效返回 undefined。 */
export function getThread(msgs: ChatMsg[], tp: ThreadPath): InlineThread | undefined {
  if (tp.length < 2) return undefined;
  const parent = getMsg(msgs, tp.slice(0, -1) as MsgPath);
  return parent?.threads?.find((x) => x.id === tp[tp.length - 1]);
}

/** 不可变更新：对 mp 处的消息应用 fn；路径无效返回原数组。 */
export function updateMsg(
  msgs: ChatMsg[],
  mp: MsgPath,
  fn: (m: ChatMsg) => ChatMsg
): ChatMsg[] {
  const idx = mp[0];
  if (typeof idx !== "number") return msgs;
  const m = msgs[idx];
  if (!m) return msgs;
  if (mp.length === 1) {
    return msgs.map((x, i) => (i === idx ? fn(x) : x));
  }
  const tid = mp[1];
  const t = m.threads?.find((x) => x.id === tid);
  if (!t || !m.threads) return msgs;
  const sub = updateMsg(t.messages, mp.slice(2), fn);
  if (sub === t.messages) return msgs;
  const nt: InlineThread = { ...t, messages: sub };
  const nm: ChatMsg = {
    ...m,
    threads: m.threads.map((x) => (x.id === tid ? nt : x)),
  };
  return msgs.map((x, i) => (i === idx ? nm : x));
}

/** 不可变更新：对 tp 处的线程应用 fn；路径无效返回原数组。 */
export function updateThread(
  msgs: ChatMsg[],
  tp: ThreadPath,
  fn: (t: InlineThread) => InlineThread
): ChatMsg[] {
  if (tp.length < 2 || !getThread(msgs, tp)) return msgs;
  const tid = tp[tp.length - 1];
  return updateMsg(msgs, tp.slice(0, -1) as MsgPath, (m) => ({
    ...m,
    threads: (m.threads ?? []).map((x) => (x.id === tid ? fn(x) : x)),
  }));
}

export function removeThread(msgs: ChatMsg[], tp: ThreadPath): ChatMsg[] {
  if (tp.length < 2 || !getThread(msgs, tp)) return msgs;
  const tid = tp[tp.length - 1];
  return updateMsg(msgs, tp.slice(0, -1) as MsgPath, (m) => ({
    ...m,
    threads: (m.threads ?? []).filter((x) => x.id !== tid),
  }));
}

/** 展开 tp 指向的线程及路径上所有祖先线程（collapsed=false）。 */
export function expandPath(msgs: ChatMsg[], tp: ThreadPath): ChatMsg[] {
  let out = msgs;
  for (let i = 2; i <= tp.length; i += 2) {
    const sub = tp.slice(0, i) as ThreadPath;
    out = updateThread(out, sub, (t) => (t.collapsed ? { ...t, collapsed: false } : t));
  }
  return out;
}

interface HistMsg {
  role: "user" | "assistant";
  content: string;
}

/** mp 处消息（含）为止的扁平历史。 */
function msgHist(msgs: ChatMsg[], mp: MsgPath): HistMsg[] {
  const idx = mp[mp.length - 1];
  if (typeof idx !== "number") return [];
  if (mp.length === 1) {
    return msgs.slice(0, idx + 1).map(({ role, content }) => ({ role, content }));
  }
  return threadHist(msgs, mp.slice(0, -1) as ThreadPath, idx);
}

function threadHist(msgs: ChatMsg[], tp: ThreadPath, lastIdx: number): HistMsg[] {
  const t = getThread(msgs, tp);
  if (!t) return [];
  const base = msgHist(msgs, tp.slice(0, -1) as MsgPath);
  let prefixed = false;
  const rest = t.messages.slice(0, lastIdx + 1).map((m) => {
    if (!prefixed && m.role === "user") {
      prefixed = true;
      return {
        role: "user" as const,
        content: `针对你上面回答中的这段内容：\n> ${t.quote}\n\n我的问题：${m.content}`,
      };
    }
    return { role: m.role, content: m.content };
  });
  return [...base, ...rest];
}

/**
 * 发给 /api/chat 的扁平历史：锚定消息（含）之前的主对话 + 线程内消息。
 * 每层线程的第一条用户消息会被改写为带引用的提问（存储内容不变）。
 */
export function threadHistory(msgs: ChatMsg[], tp: ThreadPath): HistMsg[] {
  return threadHist(msgs, tp, Infinity);
}

/** 全树统计：所有层级的用户提问数与标注数。 */
export function countTree(msgs: ChatMsg[]): { questions: number; marks: number } {
  let questions = 0;
  let marks = 0;
  const walk = (list: ChatMsg[]) => {
    for (const m of list) {
      if (m.role === "user") questions++;
      marks += m.marks?.length ?? 0;
      for (const t of m.threads ?? []) walk(t.messages);
    }
  };
  walk(msgs);
  return { questions, marks };
}

function trunc(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

/** 生成全文总结用的问答文本：追问线程缩进附在所属回答之后。 */
export function flattenQA(msgs: ChatMsg[]): string {
  const lines: string[] = [];
  const walk = (list: ChatMsg[], depth: number, quote?: string) => {
    const ind = "  ".repeat(depth);
    list.forEach((m, i) => {
      const tag = m.role === "user" ? "问" : "答";
      const head = i === 0 && quote ? `[追问「${trunc(quote, 30)}」] ` : "";
      lines.push(`${ind}${head}${tag}：${m.content}`);
      for (const t of m.threads ?? []) walk(t.messages, depth + 1, t.quote);
    });
  };
  walk(msgs, 0);
  return lines.join("\n");
}

export type IndexNode =
  | { kind: "q"; path: MsgPath; text: string }
  | { kind: "mark"; path: MsgPath; markIdx: number; mark: TextMark }
  | {
      kind: "thread";
      path: ThreadPath;
      quote: string;
      collapsed: boolean;
      turns: number;
      children: IndexNode[];
    };

/** 索引树：按文档顺序；回答内标注与追问按 start 交错（同偏移标注在前）。 */
export function indexTree(msgs: ChatMsg[], base: MsgPath = []): IndexNode[] {
  const out: IndexNode[] = [];
  msgs.forEach((m, i) => {
    const mp: MsgPath = [...base, i];
    if (m.role === "user") {
      out.push({ kind: "q", path: mp, text: m.content.replace(/\s+/g, " ").trim() });
      return;
    }
    const tagged: { s: number; isMark: boolean; node: IndexNode }[] = [];
    (m.marks ?? []).forEach((mark, markIdx) =>
      tagged.push({ s: mark.start, isMark: true, node: { kind: "mark", path: mp, markIdx, mark } })
    );
    (m.threads ?? []).forEach((t) => {
      const tp: ThreadPath = [...mp, t.id];
      tagged.push({
        s: t.start,
        isMark: false,
        node: {
          kind: "thread",
          path: tp,
          quote: t.quote,
          collapsed: !!t.collapsed,
          turns: t.messages.filter((x) => x.role === "user").length,
          children: indexTree(t.messages, tp),
        },
      });
    });
    tagged.sort((a, b) => a.s - b.s || (a.isMark === b.isMark ? 0 : a.isMark ? -1 : 1));
    for (const x of tagged) out.push(x.node);
  });
  return out;
}
