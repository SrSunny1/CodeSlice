import { useEffect, useMemo, useState } from "react";
import { browseWorkspace, type BrowseResult } from "./api";
import { IconFolder, IconSearch } from "./icons";

const LAST_DIR_KEY = "codeslice:lastBrowseDir";

export default function FolderPicker({
  onSelect,
  onClose,
  title = "选择项目文件夹",
  actionLabel = "打开此文件夹",
}: {
  onSelect: (path: string) => void;
  onClose: () => void;
  title?: string;
  actionLabel?: string;
}) {
  const [data, setData] = useState<BrowseResult | null>(null);
  const [pathInput, setPathInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [filter, setFilter] = useState("");

  async function go(p?: string) {
    setLoading(true);
    setErr("");
    try {
      const r = await browseWorkspace(p);
      setData(r);
      setPathInput(r.current);
      setFilter("");
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

  const filteredDirs = useMemo(() => {
    if (!data) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return data.dirs;
    return data.dirs.filter((d) => d.name.toLowerCase().includes(q));
  }, [data, filter]);

  // 把当前路径拆成可点击的面包屑段（跳过根前缀，只保留有意义的层级）
  const crumbs = useMemo(() => {
    if (!data?.current) return [];
    const parts = data.current.split(/[\\/]+/).filter(Boolean);
    const out: { label: string; path: string }[] = [];
    let acc = "";
    for (let i = 0; i < parts.length; i++) {
      acc = i === 0 ? parts[i] : `${acc}${data.current.includes("\\") ? "\\" : "/"}${parts[i]}`;
      out.push({ label: parts[i], path: acc });
    }
    return out;
  }, [data?.current]);

  return (
    <div className="summary-overlay" onClick={onClose}>
      <div className="picker-panel" onClick={(e) => e.stopPropagation()}>
        <div className="summary-head">
          <strong>{title}</strong>
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

        {data?.current && crumbs.length > 0 && (
          <div className="picker-crumbs">
            {crumbs.map((c, i) => (
              <button
                key={i}
                className={`picker-crumb${i === crumbs.length - 1 ? " current" : ""}`}
                onClick={() => i < crumbs.length - 1 && go(c.path)}
                title={c.path}
              >
                {c.label}
              </button>
            ))}
          </div>
        )}

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

          <div className="picker-main">
            {data && data.dirs.length > 4 && (
              <div className="picker-filter-wrap">
                <span className="picker-filter-icon"><IconSearch size={12} /></span>
                <input
                  className="picker-filter"
                  value={filter}
                  placeholder="筛选子文件夹…"
                  onChange={(e) => setFilter(e.target.value)}
                />
                {filter && (
                  <button className="picker-filter-clear" onClick={() => setFilter("")}>
                    ×
                  </button>
                )}
              </div>
            )}
            <div className="picker-dirs">
              {loading && <div className="picker-empty">加载中…</div>}
              {!loading && data && filteredDirs.length === 0 && (
                <div className="picker-empty">
                  {filter ? "没有匹配的文件夹" : "（当前目录下没有子文件夹，可直接选择当前文件夹）"}
                </div>
              )}
              {!loading &&
                filteredDirs.map((d) => (
                  <button key={d.path} className="picker-dir" onClick={() => go(d.path)}>
                    <span className="picker-dir-name">
                      <IconFolder size={14} />
                      <span>{d.name}</span>
                    </span>
                    <span className="picker-dir-enter">进入 ›</span>
                  </button>
                ))}
            </div>
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
              {actionLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
