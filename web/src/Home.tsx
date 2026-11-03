import { useMemo, useState } from "react";
import { openWorkspace, postSlice } from "./api";
import FolderPicker from "./FolderPicker";
import { guessLanguage, sessionTitle } from "./store";
import type { Session, SessionSlice, Workspace } from "./types";
import type { Theme } from "./theme";

const LANGS = ["python", "javascript", "typescript", "java", "c", "cpp", "go", "rust", "other"];

export function ThemeButton({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  return (
    <button className="link theme-btn" onClick={onToggle}>
      {theme === "light" ? "☀ 亮色" : "🌙 暗色"}
    </button>
  );
}

export default function NewPage({
  onOpen,
  onOpenWorkspace,
  workspaces,
}: {
  onOpen: (s: Session) => void;
  onOpenWorkspace: (r: {
    root: string;
    name: string;
    tree: Workspace["tree"];
    truncated: boolean;
  }) => void;
  workspaces: Workspace[];
}) {
  const [code, setCode] = useState("");
  const [language, setLanguage] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dirBusy, setDirBusy] = useState(false);
  const [error, setError] = useState("");

  const guessed = useMemo(() => (code.trim() ? guessLanguage(code) : "python"), [code]);
  const effective = language || guessed;

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
      <p className="hint">
        把代码或整个文件夹交给 AI 切分成若干段。每段一个独立对话，读懂一段再进下一段。
      </p>

      <div className="entry-card">
        <h2>打开文件夹</h2>
        <p className="hint" style={{ margin: "0 0 10px" }}>
          从电脑中选择一个项目文件夹，先看 AI 生成的整体概览，再逐文件分段阅读。
        </p>
        <button className="primary" disabled={dirBusy} onClick={() => setPickerOpen(true)}>
          {dirBusy ? "正在打开…" : "📁 选择文件夹…"}
        </button>
      </div>
      {pickerOpen && (
        <FolderPicker onSelect={openDir} onClose={() => setPickerOpen(false)} />
      )}

      <div className="entry-card">
        <h2>粘贴代码</h2>
        <textarea
          className="code-input"
          placeholder="粘贴代码…"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          spellCheck={false}
        />
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
          <button className="primary" disabled={!code.trim() || busy} onClick={start}>
            {busy ? "正在切分…" : "开始阅读"}
          </button>
        </div>
      </div>
      {error && <div className="error-box">{error}</div>}
    </div>
  );
}
