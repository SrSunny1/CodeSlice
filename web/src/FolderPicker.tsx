import { useEffect, useState } from "react";
import { browseWorkspace, type BrowseResult } from "./api";

const LAST_DIR_KEY = "codeslice:lastBrowseDir";

export default function FolderPicker({
  onSelect,
  onClose,
}: {
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const [data, setData] = useState<BrowseResult | null>(null);
  const [pathInput, setPathInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  async function go(p?: string) {
    setLoading(true);
    setErr("");
    try {
      const r = await browseWorkspace(p);
      setData(r);
      setPathInput(r.current);
      try {
        localStorage.setItem(LAST_DIR_KEY, r.current);
      } catch { /* ignore */ }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const saved = localStorage.getItem(LAST_DIR_KEY) || undefined;
    go(saved).catch(() => go(undefined));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="summary-overlay" onClick={onClose}>
      <div className="picker-panel" onClick={(e) => e.stopPropagation()}>
        <div className="summary-head">
          <strong>选择项目文件夹</strong>
          <button className="link" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="picker-bar">
          <button
            className="picker-up"
            disabled={!data?.parent || loading}
            onClick={() => data?.parent && go(data.parent)}
            title="上一级目录"
          >
            ↑ 上一级
          </button>
          <input
            className="path-input"
            value={pathInput}
            placeholder="输入或粘贴路径（支持 E:\... 或 /mnt/e/...）回车跳转"
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && go(pathInput)}
          />
          <button onClick={() => go(pathInput)} disabled={loading}>
            前往
          </button>
        </div>

        {err && <div className="error-box picker-err">{err}</div>}

        <div className="picker-body">
          <div className="picker-roots">
            <div className="picker-sec">位置</div>
            {data?.roots.map((r) => (
              <button
                key={r.path}
                className={`picker-root ${data.current.startsWith(r.path) && r.path !== "/" ? "active" : ""}`}
                onClick={() => go(r.path)}
              >
                💾 {r.label}
              </button>
            ))}
          </div>

          <div className="picker-dirs">
            {loading && <div className="picker-empty">加载中…</div>}
            {!loading && data && data.dirs.length === 0 && (
              <div className="picker-empty">（当前目录下没有子文件夹，可直接选择当前文件夹）</div>
            )}
            {!loading &&
              data?.dirs.map((d) => (
                <button key={d.path} className="picker-dir" onClick={() => go(d.path)}>
                  <span className="picker-dir-name">📁 {d.name}</span>
                  <span className="picker-dir-enter">进入 ›</span>
                </button>
              ))}
          </div>
        </div>

        <div className="picker-foot">
          <span className="picker-cur" title={data?.current}>
            当前：{data?.current || "…"}
          </span>
          <div className="picker-actions">
            <button onClick={onClose}>取消</button>
            <button
              className="primary"
              disabled={!data?.current || loading}
              onClick={() => data?.current && onSelect(data.current)}
            >
              打开此文件夹
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
