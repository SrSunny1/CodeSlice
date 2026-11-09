import { useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  postSlice,
  readWorkspaceFile,
  streamOverview,
  streamWorkspaceChat,
} from "./api";
import Reader, { type ReaderHandle } from "./Reader";
import FileView from "./FileView";
import MarkableMarkdown, {
  ChatIndex,
  MarkRail,
  ThreadCtx,
  type ThreadCtxValue,
} from "./MarkableMarkdown";
import AutoTextarea from "./AutoTextarea";
import { IconSend } from "./icons";
import { usePaneZoom } from "./paneZoom";
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
import type { Theme } from "./theme";
import type {
  ChatMsg,
  InlineThread,
  MsgPath,
  Session,
  SessionSlice,
  ThreadPath,
  TreeNode,
  Workspace,
} from "./types";

function collectFilePaths(tree: TreeNode[], out = new Set<string>()): Set<string> {
  for (const n of tree) {
    if (n.type === "file") out.add(n.path);
    if (n.children) collectFilePaths(n.children, out);
  }
  return out;
}

export default function WorkspaceMain({
  workspace,
  filePath,
  fileMode,
  sessions,
  onWorkspaceChange,
  onSessionChange,
  onOpenFile,
  theme,
  onToggleTheme,
  readerRef,
  onReslicing,
}: {
  workspace: Workspace;
  filePath?: string;
  fileMode?: "view" | "slice";
  sessions: Session[];
  onWorkspaceChange: (w: Workspace) => void;
  onSessionChange: (s: Session) => void;
  onOpenFile: (path: string, mode?: "view" | "slice") => void;
  theme: Theme;
  onToggleTheme: () => void;
  readerRef: React.RefObject<ReaderHandle>;
  onReslicing?: (busy: boolean) => void;
}) {
  const wsRef = useRef(workspace);
  wsRef.current = workspace;

  const [loadingFile, setLoadingFile] = useState("");
  const [error, setError] = useState("");

  // 流式请求归属："overview" 生成概览 / "main" 概览问答 / 线程 pathKey；null 表示空闲
  const [ovStreamKey, setOvStreamKey] = useState<string | null>(null);
  const ovStreaming = ovStreamKey !== null;
  const [ovStreamText, setOvStreamText] = useState("");
  const ovReqRef = useRef(false);
  const ovAbortRef = useRef<AbortController | null>(null);
  const ovScrollRef = useRef<HTMLDivElement>(null);
  usePaneZoom(ovScrollRef, "zOverview");
  const [chatInput, setChatInput] = useState("");

  const filePaths = useMemo(() => collectFilePaths(workspace.tree), [workspace.tree]);

  // 概览正文当作第 0 条 assistant 消息，和问答消息合成一个列表统一渲染/索引；
  // 更新时再拆回 overviewMarks/overviewThreads/overviewMessages 三个字段
  const ovList = useMemo<ChatMsg[]>(() => {
    const head: ChatMsg[] = workspace.overview
      ? [
          {
            role: "assistant",
            content: workspace.overview,
            marks: workspace.overviewMarks,
            threads: workspace.overviewThreads,
          },
        ]
      : [];
    return [...head, ...workspace.overviewMessages];
  }, [
    workspace.overview,
    workspace.overviewMarks,
    workspace.overviewThreads,
    workspace.overviewMessages,
  ]);
  const ovListRef = useRef(ovList);
  ovListRef.current = ovList;

  const mdComponents = useMemo<NonNullable<ThreadCtxValue["components"]>>(
    () => ({
      code({ children }: { children?: React.ReactNode }) {
        const text = String(children ?? "").replace(/`/g, "").trim();
        if (filePaths.has(text)) {
          return (
            <button className="file-link" onClick={() => onOpenFile(text)}>
              {text}
            </button>
          );
        }
        return <code>{children}</code>;
      },
    }),
    [filePaths, onOpenFile]
  );

  const session = filePath
    ? sessions.find((s) => s.workspaceId === workspace.id && s.filePath === filePath)
    : undefined;

  function commitWs(next: Workspace) {
    wsRef.current = next;
    onWorkspaceChange(next);
  }

  // 进入项目概览时自动生成（防 StrictMode 重复）
  useEffect(() => {
    if (!filePath && !wsRef.current.overview && !ovReqRef.current) {
      ovReqRef.current = true;
      genOverview();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath]);

  // 记住最近打开的文件（预览或切分都算），供「最近项目」恢复
  useEffect(() => {
    if (filePath && wsRef.current.lastFilePath !== filePath) {
      commitWs({ ...wsRef.current, lastFilePath: filePath });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath]);

  // 切分模式（右击「切分阅读」）且没有 session：读取文件并切分，创建 session。
  // 普通左键打开走 FileView，不触发 AI 切分。
  useEffect(() => {
    if (!filePath || fileMode !== "slice" || session || loadingFile) return;
    let cancelled = false;
    (async () => {
      setLoadingFile(filePath);
      setError("");
      try {
        const f = await readWorkspaceFile(wsRef.current.root, filePath);
        if (cancelled) return;
        const ctx = {
          name: wsRef.current.name,
          filePath,
          overview: wsRef.current.overview,
        };
        const { purpose, slices } = await postSlice(f.content, f.language, ctx);
        if (cancelled) return;
        const sessionSlices: SessionSlice[] = slices.map((s, i) => ({
          ...s,
          status: i === 0 ? "reading" : "unread",
          messages: [],
        }));
        const sess: Session = {
          id: `s-${Date.now()}`,
          createdAt: Date.now(),
          title: filePath,
          code: f.content,
          language: f.language,
          slices: sessionSlices,
          currentSliceId: sessionSlices[0]?.id ?? "",
          workspaceId: wsRef.current.id,
          filePath,
          codePurpose: purpose,
        };
        onSessionChange(sess);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoadingFile("");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, fileMode, session?.id]);

  async function genOverview() {
    if (ovStreaming) return;
    const hasAnno =
      (wsRef.current.overviewMarks?.length ?? 0) > 0 ||
      (wsRef.current.overviewThreads?.length ?? 0) > 0;
    if (hasAnno && !window.confirm("重新生成会清空概览上的标注和追问，确定吗？")) return;
    if (hasAnno)
      commitWs({ ...wsRef.current, overviewMarks: undefined, overviewThreads: undefined });
    setOvStreamKey("overview");
    setOvStreamText("");
    setError("");
    const ac = new AbortController();
    ovAbortRef.current = ac;
    let acc = "";
    try {
      const full = await streamOverview(
        wsRef.current.root,
        (t) => {
          acc += t;
          setOvStreamText(acc);
        },
        ac.signal
      );
      commitWs({ ...wsRef.current, overview: full });
    } catch (e) {
      if (acc) commitWs({ ...wsRef.current, overview: acc });
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      setOvStreamKey(null);
      setOvStreamText("");
      ovAbortRef.current = null;
    }
  }

  /** 把组合列表写回 workspace：index0 拆回 overviewMarks/overviewThreads。 */
  function commitOvList(list: ChatMsg[]) {
    const w = wsRef.current;
    if (w.overview) {
      commitWs({
        ...w,
        overviewMarks: list[0]?.marks,
        overviewThreads: list[0]?.threads,
        overviewMessages: list.slice(1),
      });
    } else {
      commitWs({ ...w, overviewMessages: list });
    }
  }

  /** 发给 /api/workspace/chat 的历史：组合列表里 index0 的概览由 overview 字段单独携带，去掉防重复。 */
  function histForApi(hist: { role: "user" | "assistant"; content: string }[]) {
    return wsRef.current.overview ? hist.slice(1) : hist;
  }

  /** 统一的流式问答：主对话与追问线程共用。 */
  async function runWsStream(
    history: { role: "user" | "assistant"; content: string }[],
    key: string,
    onDone: (text: string) => void
  ) {
    setOvStreamKey(key);
    setOvStreamText("");
    setError("");
    const ac = new AbortController();
    ovAbortRef.current = ac;
    let acc = "";
    try {
      const full = await streamWorkspaceChat(
        { root: wsRef.current.root, overview: wsRef.current.overview, messages: history },
        (t) => {
          acc += t;
          setOvStreamText(acc);
        },
        ac.signal
      );
      onDone(full);
    } catch (e) {
      if (acc) onDone(acc);
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      if (ovAbortRef.current === ac) {
        setOvStreamKey(null);
        setOvStreamText("");
        ovAbortRef.current = null;
      }
    }
  }

  async function sendWsChat() {
    const text = chatInput.trim();
    if (!text || ovStreaming) return;
    const msgs: ChatMsg[] = [...wsRef.current.overviewMessages, { role: "user", content: text }];
    commitWs({ ...wsRef.current, overviewMessages: msgs });
    setChatInput("");
    runWsStream(msgs.map(({ role, content }) => ({ role, content })), "main", (t) =>
      commitWs({
        ...wsRef.current,
        overviewMessages: [...wsRef.current.overviewMessages, { role: "assistant", content: t }],
      })
    );
  }

  function appendWsThreadMsg(tp: ThreadPath, m: ChatMsg) {
    commitOvList(
      updateThread(ovListRef.current, tp, (t) => ({ ...t, messages: [...t.messages, m] }))
    );
  }

  /** 索引条/导航点右键删除：按 MsgPath 定位标注，按 ThreadPath 定位追问。 */
  function deleteOvMark(mp: MsgPath, markIdx: number) {
    commitOvList(
      updateMsg(ovListRef.current, mp, (m) => {
        const marks = m.marks?.filter((_, i) => i !== markIdx);
        return { ...m, marks: marks?.length ? marks : undefined };
      })
    );
  }
  function deleteOvThread(tp: ThreadPath) {
    commitOvList(removeThread(ovListRef.current, tp));
  }

  const ovRounds = useMemo(() => threadRoundMap(ovList), [ovList]);

  const wsThreadCtx: ThreadCtxValue = {
    messages: ovList,
    rounds: ovRounds,
    busy: ovStreaming,
    streamingKey:
      ovStreamKey === "main" || ovStreamKey === "overview" ? null : ovStreamKey,
    streamText: ovStreamText,
    showDetail: false,
    components: mdComponents,
    onMarks(mp, marks) {
      commitOvList(updateMsg(ovListRef.current, mp, (m) => ({ ...m, marks })));
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
      const next = updateMsg(ovListRef.current, mp, (m) => ({
        ...m,
        threads: [...(m.threads ?? []), t],
      }));
      commitOvList(next);
      const tp: ThreadPath = [...mp, t.id];
      runWsStream(histForApi(threadHistory(next, tp)), pathKey(tp), (text) =>
        appendWsThreadMsg(tp, { role: "assistant", content: text })
      );
    },
    onReply(tp, question) {
      const next = expandPath(
        updateThread(ovListRef.current, tp, (t) => ({
          ...t,
          messages: [...t.messages, { role: "user", content: question }],
        })),
        tp
      );
      commitOvList(next);
      runWsStream(histForApi(threadHistory(next, tp)), pathKey(tp), (text) =>
        appendWsThreadMsg(tp, { role: "assistant", content: text })
      );
    },
    onPatchThread(tp, patch) {
      commitOvList(updateThread(ovListRef.current, tp, (t) => ({ ...t, ...patch })));
    },
    onDeleteThread(tp) {
      deleteOvThread(tp);
    },
    onAbort() {
      ovAbortRef.current?.abort();
    },
  };

  if (filePath) {
    // slice=切分阅读；view/未指定 = 普通预览（旧路由缺省时按有无会话推断）
    const sliceMode = fileMode === "slice" || (fileMode === undefined && !!session);
    if (!sliceMode) {
      return (
        <FileView
          root={workspace.root}
          filePath={filePath}
          onSlice={() => onOpenFile(filePath, "slice")}
          onOpenFile={(p) => onOpenFile(p, "view")}
        />
      );
    }
    if (session) {
      return (
        <Reader
          key={session.id}
          ref={readerRef}
          session={session}
          onChange={onSessionChange}
          onBack={() => onOpenFile("")}
          theme={theme}
          onToggleTheme={onToggleTheme}
          projectContext={{
            name: workspace.name,
            filePath,
            overview: workspace.overview,
          }}
          embedded
          onReslicingChange={onReslicing}
          summaryBaseDir={workspace.root}
        />
      );
    }
    return (
      <div className="ws-main-inner ws-file-loading">
        {error ? (
          <div className="error-box">{error}</div>
        ) : (
          <div className="ws-loading-card">
            <div className="ws-loading-spinner" />
            <div className="ws-loading-text">正在读取并切分 {loadingFile || filePath}…</div>
            <div className="ws-loading-hint">大文件可能需要几秒，请稍候</div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="overview-pane">
      {error && <div className="error-box">{error}</div>}
      <div className="overview-head">
        <div className="overview-head-left">
          <strong>项目概览</strong>
          <span className="overview-sub">{workspace.name}</span>
        </div>
        <span className="overview-head-actions">
          {ovStreaming && (
            <button className="header-action-btn" onClick={() => ovAbortRef.current?.abort()}>
              中止
            </button>
          )}
          <button
            className="header-action-btn"
            disabled={ovStreaming}
            onClick={genOverview}
            title="重新生成项目概览"
          >
            重新生成
          </button>
        </span>
      </div>
      <div className="chat-body">
        <ChatIndex
          containerRef={ovScrollRef}
          messages={ovList}
          onExpand={(tp) => commitOvList(expandPath(ovListRef.current, tp))}
          onDeleteMark={deleteOvMark}
          onDeleteThread={deleteOvThread}
        />
        <div className="overview-body reading-font" ref={ovScrollRef}>
        <ThreadCtx.Provider value={wsThreadCtx}>
        {!workspace.overview && !ovStreaming && !ovStreamText && (
          <p className="hint">正在生成概览…</p>
        )}
        {workspace.overview && (
          <div className="msg assistant" data-msg-path={0}>
            <MarkableMarkdown msg={ovList[0]} path={[0]} />
          </div>
        )}
        {ovStreamKey === "overview" && (
          <Markdown remarkPlugins={[remarkGfm]}>{ovStreamText || "…"}</Markdown>
        )}
        {workspace.overviewMessages.map((m, j) => {
          const i = j + (workspace.overview ? 1 : 0);
          return (
            <div key={i} className={`msg ${m.role}`} data-msg-path={i}>
              {m.role === "assistant" ? (
                <MarkableMarkdown msg={m} path={[i]} />
              ) : (
                <div className="user-text">{m.content}</div>
              )}
            </div>
          );
        })}
        {ovStreamKey === "main" && (
          <div className="msg assistant">
            <Markdown remarkPlugins={[remarkGfm]}>{ovStreamText || "…"}</Markdown>
            <span className="cursor">▍</span>
          </div>
        )}
        <MarkRail containerRef={ovScrollRef} onDeleteMark={deleteOvMark} />
        </ThreadCtx.Provider>
        </div>
      </div>
      <div className="chat-input">
        <div className="composer-box overview-composer">
          <AutoTextarea
            className="composer-input"
            placeholder={ovStreaming ? "正在回答…" : "就这个项目继续提问"}
            value={chatInput}
            disabled={ovStreaming}
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendWsChat();
              }
            }}
          />
          <div className="composer-bottom">
            <span className="composer-hint">Enter 发送 · Shift+Enter 换行</span>
            <div className="composer-actions">
              {ovStreaming ? (
                <button className="composer-stop" onClick={() => ovAbortRef.current?.abort()}>
                  中止
                </button>
              ) : (
                <button
                  className="primary composer-send"
                  disabled={!chatInput.trim()}
                  onClick={sendWsChat}
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
    </div>
  );
}
