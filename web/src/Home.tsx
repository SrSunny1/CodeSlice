import { useMemo, useRef, useState } from "react";
import { openWorkspace, postSlice } from "./api";
import FolderPicker from "./FolderPicker";
import { guessLanguage, sessionTitle } from "./store";
import type { Session, SessionSlice, Workspace } from "./types";
import type { Theme } from "./theme";

const LANGS = ["python", "javascript", "typescript", "java", "c", "cpp", "go", "rust", "other"];

export function ThemeButton({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  return (
    <button className="link theme-btn" onClick={onToggle} aria-label="切换主题">
      {theme === "light" ? (
        <>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="12" cy="12" r="5" />
            <line x1="12" y1="1" x2="12" y2="3" />
            <line x1="12" y1="21" x2="12" y2="23" />
            <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
            <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
            <line x1="1" y1="12" x2="3" y2="12" />
            <line x1="21" y1="12" x2="23" y2="12" />
            <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
            <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
          </svg>
          <span>亮色</span>
        </>
      ) : (
        <>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79" />
          </svg>
          <span>暗色</span>
        </>
      )}
    </button>
  );
}

export default function NewPage({
  onOpen,
  onOpenWorkspace,
  onSelectWorkspace,
  workspaces,
  sessions = [],
}: {
  onOpen: (s: Session) => void;
  onOpenWorkspace: (r: {
    root: string;
    name: string;
    tree: Workspace["tree"];
    truncated: boolean;
  }) => void;
  onSelectWorkspace?: (w: Workspace) => void;
  workspaces: Workspace[];
  sessions?: Session[];
}) {
  const [code, setCode] = useState("");
  const [language, setLanguage] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dirBusy, setDirBusy] = useState(false);
  const [error, setError] = useState("");
  const gutterRef = useRef<HTMLDivElement>(null);

  const guessed = useMemo(() => (code.trim() ? guessLanguage(code) : "python"), [code]);
  const effective = language || guessed;

  // 最近会话：按创建时间倒序，最多 6 条
  const recent = useMemo(
    () => [...sessions].sort((a, b) => b.createdAt - a.createdAt).slice(0, 6),
    [sessions]
  );

  async function start() {
    if (!code.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const { purpose, slices } = await postSlice(code, effective);
      const sessionSlices: SessionSlice[] = slices.map((s, i) => ({
        ...s,
        status: i === 0 ? "reading" : "unread",
        messages: [],
      }));
      const session: Session = {
        id: `s-${Date.now()}`,
        createdAt: Date.now(),
        title: sessionTitle(code),
        code,
        language: effective,
        slices: sessionSlices,
        currentSliceId: sessionSlices[0]?.id ?? "",
        codePurpose: purpose,
      };
      onOpen(session);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function openDir(targetPath: string) {
    if (!targetPath.trim() || dirBusy) return;
    setPickerOpen(false);
    setDirBusy(true);
    setError("");
    try {
      const r = await openWorkspace(targetPath.trim());
      onOpenWorkspace(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDirBusy(false);
    }
  }

  return (
    <div className="home">
      <header className="home-head">
        <div className="home-brand">
          <span className="home-brand-mark">CS</span>
          <div>
            <h1 className="home-title">CodeSlice</h1>
            <p className="home-tagline">把代码切分成若干段，逐段与 AI 对话，读懂再进入下一段。</p>
          </div>
        </div>
      </header>

      <p className="home-intro">
        从粘贴代码或打开项目文件夹开始。每段代码拥有独立对话，标注与追问都会保存。
      </p>

      <div className="home-grid">
        <div className="entry-card card-open">
          <div className="card-icon">📁</div>
          <h2>打开文件夹</h2>
          <p className="card-desc">
            从电脑中选择一个项目文件夹，先看 AI 生成的整体概览，再逐文件分段阅读。
          </p>
          <button className="primary" disabled={dirBusy} onClick={() => setPickerOpen(true)}>
            {dirBusy ? "正在打开…" : "选择文件夹…"}
          </button>
        </div>
        {pickerOpen && (
          <FolderPicker onSelect={openDir} onClose={() => setPickerOpen(false)} />
        )}

        <div className="entry-card card-paste">
          <div className="card-icon">📋</div>
          <h2>粘贴代码</h2>
          <p className="card-desc">
            直接粘贴一段代码，AI 会自动切分并生成每段的讲解。
          </p>
          <div className="code-editor-wrap">
            <textarea
              className="code-input"
              placeholder="粘贴代码…"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onScroll={(e) => {
                if (gutterRef.current)
                  gutterRef.current.scrollTop = e.currentTarget.scrollTop;
              }}
              spellCheck={false}
            />
            <div className="code-gutter" ref={gutterRef}>
              {Array.from(
                { length: Math.max(1, code.split("\n").length) },
                (_, i) => i + 1
              ).map((n) => (
                <div key={n} className="gutter-line">{n}</div>
              ))}
            </div>
          </div>
          <div className="home-bar">
            <label>
              语言：
              <select value={effective} onChange={(e) => setLanguage(e.target.value)}>
                {LANGS.map((l) => (
                  <option key={l} value={l}>
                    {l}
                    {!language && l === guessed ? "（猜测）" : ""}
                  </option>
                ))}
              </select>
            </label>
            {code.trim() && (
              <span className="code-stats">
                {code.split("\n").length} 行 · {code.length} 字符
              </span>
            )}
            <button className="primary" disabled={!code.trim() || busy} onClick={start}>
              {busy ? "正在切分…" : "开始阅读"}
            </button>
          </div>
          {error && <div className="error-box">{error}</div>}
        </div>
      </div>

      {workspaces.length > 0 && (
        <section className="recent-section">
          <div className="recent-head">
            <h2>最近项目</h2>
            <span className="recent-count">{workspaces.length} 个</span>
          </div>
          <div className="recent-grid">
            {workspaces.map((w) => {
              const doneSessions = sessions.filter((s) => s.workspaceId === w.id);
              const allDone = doneSessions.filter(
                (s) => s.slices.every((x) => x.status === "done")
              ).length;
              return (
                <div
                  key={w.id}
                  className="recent-card ws-card"
                  onClick={() => onSelectWorkspace?.(w)}
                  title={w.root}
                >
                  <div className="recent-card-icon">📁</div>
                  <div className="recent-body">
                    <div className="recent-title">{w.name}</div>
                    <div className="recent-meta">
                      {doneSessions.length} 个文件已读 · {allDone} 个全部懂
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {recent.length > 0 && (
        <section className="recent-section">
          <div className="recent-head">
            <h2>最近会话</h2>
            <span className="recent-count">{recent.length} 个</span>
          </div>
          <div className="recent-list">
            {recent.map((s) => (
              <div key={s.id} className="recent-item" onClick={() => onOpen(s)} title={s.title}>
                <div className="recent-body">
                  <div className="recent-title">{s.title}</div>
                  <div className="recent-meta">
                    {s.language} · {s.slices.length} 段 · {formatDate(s.createdAt)}
                  </div>
                </div>
                <span className="recent-badge">{sessionBadge(s)}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function sessionBadge(s: Session): string {
  const done = s.slices.filter((x) => x.status === "done").length;
  return done === s.slices.length ? "全部已懂" : `${done}/${s.slices.length}`;
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60000) return "刚才";
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}