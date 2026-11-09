import { useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { readWorkspaceFile, streamWorkspaceChat, workspaceAssetUrl } from "./api";
import { IconFileCode, IconSend } from "./icons";
import { usePaneZoom } from "./paneZoom";
import AutoTextarea from "./AutoTextarea";
import MarkableMarkdown, {
  ChatIndex,
  MarkRail,
  ThreadCtx,
  type ThreadCtxValue,
} from "./MarkableMarkdown";
import {
  expandPath,
  newThreadId,
  pathKey,
  removeThread,
  threadHistory,
  threadRoundMap,
  updateMsg,
  updateThread,
} from "./threads";
import type {
  ChatMsg,
  FileViewState,
  InlineThread,
  MsgPath,
  ThreadPath,
} from "./types";

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(0, i) : "";
}

/** 把相对路径按 posix 规则归一化（a/b/../c → a/c），用于解析 md 里的相对链接与图片。 */
function resolveRel(base: string, rel: string): string {
  const out: string[] = [];
  for (const p of (base ? base.split("/") : []).concat(rel.split("/"))) {
    if (!p || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.join("/");
}

export default function FileView({
  root,
  filePath,
  view,
  onViewChange,
  onSlice,
  onOpenFile,
}: {
  root: string;
  filePath: string;
  /** 该文件的标注/追问/问答状态（workspace.fileViews[filePath]） */
  view?: FileViewState;
  onViewChange: (patch: Partial<FileViewState>) => void;
  /** 点击「切分阅读」：切回切分模式（有会话直接进 Reader，没有则读文件并切分） */
  onSlice: () => void;
  /** md 预览里相对链接的跳转（普通打开） */
  onOpenFile: (path: string) => void;
}) {
  const [data, setData] = useState<{ content: string; language: string } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState(true);
  const [chatInput, setChatInput] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);
  usePaneZoom(bodyRef, "zOverview");
  const docScrollRef = useRef<HTMLDivElement>(null);

  // 流式状态："main" 文档问答 / 线程 pathKey；null 空闲
  const [fvStreamKey, setFvStreamKey] = useState<string | null>(null);
  const fvStreaming = fvStreamKey !== null;
  const [fvStreamText, setFvStreamText] = useState("");
  const fvAbortRef = useRef<AbortController | null>(null);

  const isMd = /\.(md|markdown|mdx)$/i.test(filePath);
  const dir = dirOf(filePath);
  const annotatable = !!data && isMd && preview;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setData(null);
    setPreview(true);
    fvAbortRef.current?.abort();
    setFvStreamKey(null);
    setFvStreamText("");
    readWorkspaceFile(root, filePath)
      .then((f) => {
        if (!cancelled) setData(f);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [root, filePath]);

  // 文档正文当作第 0 条 assistant 消息，与问答消息合成列表统一渲染/索引；
  // 提交时再拆回 view.marks/view.threads/view.messages（同概览页模式）
  const fvList = useMemo<ChatMsg[]>(() => {
    const head: ChatMsg[] = data
      ? [
          {
            role: "assistant",
            content: data.content,
            marks: view?.marks,
            threads: view?.threads,
          },
        ]
      : [];
    return [...head, ...(view?.messages ?? [])];
  }, [data, view]);
  const fvListRef = useRef(fvList);
  fvListRef.current = fvList;

  function commitFvList(list: ChatMsg[]) {
    if (!data) return;
    onViewChange({
      marks: list[0]?.marks,
      threads: list[0]?.threads,
      messages: list.slice(1),
    });
  }

  /** threadHistory 结果含 index0 文档本体（已由 doc 参数单独携带），发送前去掉防重复。 */
  function histForApi(hist: { role: "user" | "assistant"; content: string }[]) {
    return hist.slice(1);
  }

  /** 统一的流式问答：主对话与追问线程共用（doc 模式，围绕本文件内容回答）。 */
  async function runFvStream(
    history: { role: "user" | "assistant"; content: string }[],
    key: string,
    onDone: (text: string) => void
  ) {
    setFvStreamKey(key);
    setFvStreamText("");
    setError("");
    const ac = new AbortController();
    fvAbortRef.current = ac;
    let acc = "";
    try {
      const full = await streamWorkspaceChat(
        {
          root,
          doc: { title: filePath, content: data?.content ?? "" },
          messages: history,
        },
        (t) => {
          acc += t;
          setFvStreamText(acc);
        },
        ac.signal
      );
      onDone(full);
    } catch (e) {
      if (acc) onDone(acc);
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      if (fvAbortRef.current === ac) {
        setFvStreamKey(null);
        setFvStreamText("");
        fvAbortRef.current = null;
      }
    }
  }

  function sendFvChat() {
    const text = chatInput.trim();
    if (!text || fvStreaming || !data) return;
    const msgs: ChatMsg[] = [...(view?.messages ?? []), { role: "user", content: text }];
    onViewChange({ messages: msgs });
    setChatInput("");
    runFvStream(
      msgs.map(({ role, content }) => ({ role, content })),
      "main",
      (t) => onViewChange({ messages: [...msgs, { role: "assistant", content: t }] })
    );
  }

  function appendFvThreadMsg(tp: ThreadPath, m: ChatMsg) {
    commitFvList(
      updateThread(fvListRef.current, tp, (t) => ({ ...t, messages: [...t.messages, m] }))
    );
  }

  function deleteFvMark(mp: MsgPath, markIdx: number) {
    commitFvList(
      updateMsg(fvListRef.current, mp, (m) => {
        const marks = m.marks?.filter((_, i) => i !== markIdx);
        return { ...m, marks: marks?.length ? marks : undefined };
      })
    );
  }
  function deleteFvThread(tp: ThreadPath) {
    commitFvList(removeThread(fvListRef.current, tp));
  }

  const fvRounds = useMemo(() => threadRoundMap(fvList), [fvList]);

  // 滚动跟随：追问流式跟随卡片；主问答流式跟底；结束保持原位
  const prevFvKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const sc = docScrollRef.current;
    const k = fvStreamKey;
    if (!sc) return;
    const threadKey = k && k !== "main" ? k : null;
    if (threadKey) {
      sc.querySelector(`[data-thread-path="${threadKey}"]`)?.scrollIntoView({
        block: "nearest",
      });
    } else if (k === "main" || (!k && prevFvKeyRef.current === "main")) {
      sc.scrollTop = sc.scrollHeight;
    }
    prevFvKeyRef.current = k;
  }, [fvList.length, fvStreamText, fvStreamKey]);

  // md 预览：相对链接跳转到对应文件的预览，相对图片走 /api/workspace/asset
  const mdComponents = useMemo(
    () => ({
      a({ href, children }: { href?: string; children?: React.ReactNode }) {
        if (!href) return <a>{children}</a>;
        if (/^(https?:|mailto:)/i.test(href)) {
          return (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          );
        }
        if (href.startsWith("#")) return <a href={href}>{children}</a>;
        let rel = href.split("#")[0];
        try {
          rel = decodeURIComponent(rel);
        } catch {
          /* 保留原样 */
        }
        const resolved = resolveRel(dir, rel);
        return (
          <a
            href={href}
            title={resolved}
            onClick={(e) => {
              e.preventDefault();
              onOpenFile(resolved);
            }}
          >
            {children}
          </a>
        );
      },
      img({ src, alt }: { src?: string; alt?: string }) {
        if (!src) return <>{alt}</>;
        if (/^(https?:|data:|blob:)/i.test(src)) {
          return <img src={src} alt={alt ?? ""} loading="lazy" />;
        }
        const resolved = resolveRel(dir, src.split("#")[0]);
        return <img src={workspaceAssetUrl(root, resolved)} alt={alt ?? ""} loading="lazy" />;
      },
    }),
    [dir, root, onOpenFile]
  );

  const fvThreadCtx: ThreadCtxValue = {
    messages: fvList,
    rounds: fvRounds,
    busy: fvStreaming,
    streamingKey: fvStreamKey === "main" ? null : fvStreamKey,
    streamText: fvStreamText,
    showDetail: false,
    components: mdComponents,
    onMarks(mp, marks) {
      commitFvList(updateMsg(fvListRef.current, mp, (m) => ({ ...m, marks })));
    },
    onAsk(mp: MsgPath, anchor, question) {
      const t: InlineThread = {
        id: newThreadId(),
        start: anchor.start,
        end: anchor.end,
        blockEnd: anchor.blockEnd,
        quote: anchor.quote,
        messages: [{ role: "user", content: question }],
        detail: "brief",
      };
      const next = updateMsg(fvListRef.current, mp, (m) => ({
        ...m,
        threads: [...(m.threads ?? []), t],
      }));
      commitFvList(next);
      const tp: ThreadPath = [...mp, t.id];
      runFvStream(histForApi(threadHistory(next, tp)), pathKey(tp), (text) =>
        appendFvThreadMsg(tp, { role: "assistant", content: text })
      );
    },
    onReply(tp, question) {
      const next = expandPath(
        updateThread(fvListRef.current, tp, (t) => ({
          ...t,
          messages: [...t.messages, { role: "user" as const, content: question }],
        })),
        tp
      );
      commitFvList(next);
      runFvStream(histForApi(threadHistory(next, tp)), pathKey(tp), (text) =>
        appendFvThreadMsg(tp, { role: "assistant", content: text })
      );
    },
    onPatchThread(tp, patch) {
      commitFvList(updateThread(fvListRef.current, tp, (t) => ({ ...t, ...patch })));
    },
    onDeleteThread(tp) {
      deleteFvThread(tp);
    },
    onAbort() {
      fvAbortRef.current?.abort();
    },
  };

  const lines = useMemo(() => data?.content.split("\n") ?? [], [data]);

  return (
    <div className="fileview">
      <div className="fv-head">
        <span className="sb-item-icon file-icon">
          <IconFileCode size={14} />
        </span>
        <span className="fv-path" title={filePath}>
          {filePath}
        </span>
        {data && <span className="reader-chip">{data.language}</span>}
        <div className="fv-head-actions">
          {isMd && data && (
            <div className="fv-seg" role="group" aria-label="Markdown 显示方式">
              <button className={preview ? "on" : ""} onClick={() => setPreview(true)}>
                预览
              </button>
              <button className={!preview ? "on" : ""} onClick={() => setPreview(false)}>
                源码
              </button>
            </div>
          )}
          <button
            className="primary fv-slice-btn"
            onClick={onSlice}
            title="让 AI 把该文件切分成若干段，逐段阅读与问答"
          >
            切分阅读
          </button>
        </div>
      </div>
      <div className="fv-body" ref={bodyRef}>
        {loading && (
          <div className="ws-loading-card">
            <div className="ws-loading-spinner" />
            <div className="ws-loading-text">正在读取 {filePath}…</div>
          </div>
        )}
        {error && <div className="error-box">{error}</div>}
        {annotatable && (
          <div className="fv-doc-body">
            <ChatIndex
              containerRef={docScrollRef}
              messages={fvList}
              onExpand={(tp) => commitFvList(expandPath(fvListRef.current, tp))}
              onDeleteMark={deleteFvMark}
              onDeleteThread={deleteFvThread}
            />
            <div className="fv-doc-scroll" ref={docScrollRef}>
              <ThreadCtx.Provider value={fvThreadCtx}>
                <div className="msg assistant fv-md summary-body" data-msg-path={0}>
                  <MarkableMarkdown msg={fvList[0]} path={[0]} />
                </div>
                {fvList.slice(1).map((m, i) => {
                  const idx = i + 1;
                  return (
                    <div key={idx} className={`msg ${m.role}`} data-msg-path={idx}>
                      {m.role === "assistant" ? (
                        <MarkableMarkdown msg={m} path={[idx]} />
                      ) : (
                        <div className="user-text">{m.content}</div>
                      )}
                    </div>
                  );
                })}
                {fvStreamKey === "main" && (
                  <div className="msg assistant">
                    <Markdown remarkPlugins={[remarkGfm]}>{fvStreamText || "…"}</Markdown>
                    <span className="cursor">▍</span>
                  </div>
                )}
                <MarkRail containerRef={docScrollRef} onDeleteMark={deleteFvMark} />
              </ThreadCtx.Provider>
            </div>
          </div>
        )}
        {data && !annotatable && (
          <div className="fv-code">
            {lines.map((l, i) => (
              <div className="fv-row" key={i}>
                <span className="fv-ln">{i + 1}</span>
                <span className="fv-tx">{l === "" ? " " : l}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      {annotatable && (
        <div className="chat-input">
          <div className="composer-box overview-composer">
            <AutoTextarea
              className="composer-input"
              placeholder={fvStreaming ? "正在回答…" : "就这篇文档继续提问"}
              value={chatInput}
              disabled={fvStreaming}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendFvChat();
                }
              }}
            />
            <div className="composer-bottom">
              <span className="composer-hint">Enter 发送 · Shift+Enter 换行</span>
              <div className="composer-actions">
                {fvStreaming ? (
                  <button className="composer-stop" onClick={() => fvAbortRef.current?.abort()}>
                    中止
                  </button>
                ) : (
                  <button
                    className="primary composer-send"
                    disabled={!chatInput.trim()}
                    onClick={sendFvChat}
                    title="发送（Enter）"
                  >
                    <IconSend size={14} />
                    <span>发送</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
