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
import AutoTextarea from "./AutoTextarea";
import type { Theme } from "./theme";
import type { ChatMsg, Session, SessionSlice, TreeNode, Workspace } from "./types";

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
  sessions,
  onWorkspaceChange,
  onSessionChange,
  onOpenFile,
  theme,
  onToggleTheme,
  readerRef,
}: {
  workspace: Workspace;
  filePath?: string;
  sessions: Session[];
  onWorkspaceChange: (w: Workspace) => void;
  onSessionChange: (s: Session) => void;
  onOpenFile: (path: string) => void;
  theme: Theme;
  onToggleTheme: () => void;
  readerRef: React.RefObject<ReaderHandle>;
}) {
  const wsRef = useRef(workspace);
  wsRef.current = workspace;

  const [loadingFile, setLoadingFile] = useState("");
  const [error, setError] = useState("");

  const [ovStreaming, setOvStreaming] = useState(false);
  const [ovStreamText, setOvStreamText] = useState("");
  const ovReqRef = useRef(false);
  const ovAbortRef = useRef<AbortController | null>(null);
  const [chatInput, setChatInput] = useState("");

  const filePaths = useMemo(() => collectFilePaths(workspace.tree), [workspace.tree]);

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

  // 有 filePath 但没有 session：读取文件并切分，创建 session
  useEffect(() => {
    if (!filePath || session || loadingFile) return;
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
        const slices = await postSlice(f.content, f.language, ctx);
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
        };
        onSessionChange(sess);
        commitWs({ ...wsRef.current, lastFilePath: filePath });
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
  }, [filePath, session?.id]);

  async function genOverview() {
    if (ovStreaming) return;
    setOvStreaming(true);
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
      setOvStreaming(false);
      setOvStreamText("");
      ovAbortRef.current = null;
    }
  }

  async function sendWsChat() {
    const text = chatInput.trim();
    if (!text || ovStreaming) return;
    const msgs: ChatMsg[] = [...wsRef.current.overviewMessages, { role: "user", content: text }];
    commitWs({ ...wsRef.current, overviewMessages: msgs });
    setChatInput("");
    setOvStreaming(true);
    setOvStreamText("");
    const ac = new AbortController();
    ovAbortRef.current = ac;
    let acc = "";
    try {
      const full = await streamWorkspaceChat(
        { root: wsRef.current.root, overview: wsRef.current.overview, messages: msgs },
        (t) => {
          acc += t;
          setOvStreamText(acc);
        },
        ac.signal
      );
      commitWs({
        ...wsRef.current,
        overviewMessages: [...msgs, { role: "assistant", content: full }],
      });
    } catch (e) {
      if (acc)
        commitWs({
          ...wsRef.current,
          overviewMessages: [...msgs, { role: "assistant", content: acc }],
        });
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      setOvStreaming(false);
      setOvStreamText("");
      ovAbortRef.current = null;
    }
  }

  const mdComponents = {
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
  };

  if (filePath) {
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
        />
      );
    }
    return (
      <div className="ws-main-inner">
        {error ? (
          <div className="error-box">{error}</div>
        ) : (
          <div className="ws-loading">正在读取并切分 {loadingFile || filePath}…</div>
        )}
      </div>
    );
  }

  return (
    <div className="overview-pane">
      {error && <div className="error-box">{error}</div>}
      <div className="overview-head">
        <strong>项目概览</strong>
        <span>
          {ovStreaming && (
            <button className="link" onClick={() => ovAbortRef.current?.abort()}>
              中止
            </button>
          )}
          <button className="link" disabled={ovStreaming} onClick={genOverview}>
            重新生成
          </button>
        </span>
      </div>
      <div className="overview-body reading-font">
        {!workspace.overview && !ovStreaming && !ovStreamText && (
          <p className="hint">正在生成概览…</p>
        )}
        <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>
          {workspace.overview ?? ""}
        </Markdown>
        {ovStreaming && (
          <Markdown remarkPlugins={[remarkGfm]}>{ovStreamText || "…"}</Markdown>
        )}
        {workspace.overviewMessages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.role === "assistant" ? (
              <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                {m.content}
              </Markdown>
            ) : (
              <div className="user-text">{m.content}</div>
            )}
          </div>
        ))}
      </div>
      <div className="chat-input">
        <div className="input-row">
          <AutoTextarea
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
          <button
            className="primary"
            disabled={!chatInput.trim() || ovStreaming}
            onClick={sendWsChat}
          >
            发送
          </button>
        </div>
      </div>
    </div>
  );
}
