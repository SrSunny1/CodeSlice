import { useEffect, useMemo, useRef, useState } from "react";
import { loadSidebarState, saveSidebarState } from "./store";
import { usePaneZoom } from "./paneZoom";
import { ThemeButton } from "./Home";
import {
  IconCheck,
  IconCode,
  IconFileCode,
  IconFolder,
  IconFolderOpen,
  IconOverview,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconTrash,
} from "./icons";
import type { Theme } from "./theme";
import type { Session, TreeNode, Workspace } from "./types";

export type Route =
  | { kind: "new" }
  | { kind: "snippet"; sessionId: string }
  | {
      kind: "workspace";
      workspaceId: string;
      filePath?: string;
      /** view=普通打开预览（默认）；slice=切分阅读；缺省按有无会话推断（旧路由兼容） */
      fileMode?: "view" | "slice";
    };

function PanelIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <line x1="6" y1="3.5" x2="6" y2="12.5" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

/** 递归过滤文件树，保留名称或路径包含关键字的文件及其父目录 */
function filterTree(nodes: TreeNode[], q: string): TreeNode[] {
  if (!q) return nodes;
  const out: TreeNode[] = [];
  for (const n of nodes) {
    if (n.type === "dir") {
      const kids = filterTree(n.children ?? [], q);
      if (kids.length > 0 || n.name.toLowerCase().includes(q)) {
        out.push({ ...n, children: kids });
      }
    } else if (n.name.toLowerCase().includes(q) || n.path.toLowerCase().includes(q)) {
      out.push(n);
    }
  }
  return out;
}

export function Sidebar({
  workspaces,
  sessions,
  route,
  onNavigate,
  onDeleteWorkspace,
  onDeleteSession,
  onRefreshWorkspace,
  theme,
  onToggleTheme,
  onCollapse,
}: {
  workspaces: Workspace[];
  sessions: Session[];
  route: Route;
  onNavigate: (r: Route) => void;
  onDeleteWorkspace: (w: Workspace) => void;
  onDeleteSession: (s: Session) => void;
  onRefreshWorkspace: (w: Workspace) => void;
  theme: Theme;
  onToggleTheme: () => void;
  onCollapse: () => void;
}) {
  const [sb, setSb] = useState(loadSidebarState);
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; wsId: string; path: string; hasSession: boolean } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const sbRef = useRef<HTMLElement>(null);
  usePaneZoom(sbRef, "zSidebar");

  const q = query.trim().toLowerCase();

  // 右键菜单：点菜单外 / Esc / 滚动关闭
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    const closeAny = () => setMenu(null);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    window.addEventListener("scroll", closeAny, true);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
      window.removeEventListener("scroll", closeAny, true);
    };
  }, [menu]);

  function updateSb(next: typeof sb) {
    setSb(next);
    saveSidebarState(next);
  }

  const snippets = useMemo(
    () =>
      sessions
        .filter((s) => !s.workspaceId)
        .filter((s) => !q || s.title.toLowerCase().includes(q) || s.language.toLowerCase().includes(q)),
    [sessions, q]
  );

  function renderSessionBadge(s: Session) {
    const done = s.slices.filter((x) => x.status === "done").length;
    const allDone = done === s.slices.length && s.slices.length > 0;
    return (
      <span className={`file-badge${allDone ? " done" : ""}`}>
        {allDone ? <IconCheck size={11} /> : `${done}/${s.slices.length}`}
      </span>
    );
  }

  function fileSession(wsId: string, rel: string): Session | undefined {
    return sessions.find((s) => s.workspaceId === wsId && s.filePath === rel);
  }

  function toggleDir(wsId: string, rel: string) {
    const cur = new Set(sb.dirExpanded[wsId] ?? []);
    if (cur.has(rel)) cur.delete(rel);
    else cur.add(rel);
    updateSb({ ...sb, dirExpanded: { ...sb.dirExpanded, [wsId]: [...cur] } });
  }

  function renderTree(ws: Workspace, nodes: TreeNode[], depth: number): React.ReactNode {
    const openDirs = new Set(sb.dirExpanded[ws.id] ?? []);
    return nodes.map((n) => {
      if (n.type === "dir") {
        const open = q ? true : openDirs.has(n.path);
        return (
          <div key={n.path}>
            <button
              className="sb-row dir"
              style={{ paddingLeft: 12 + depth * 13 }}
              onClick={() => toggleDir(ws.id, n.path)}
            >
              <span className="caret">{open ? "▾" : "▸"}</span>
              <span className="sb-item-icon dir-icon">
                {open ? <IconFolderOpen size={13} /> : <IconFolder size={13} />}
              </span>
              <span className="sb-name">{n.name}</span>
            </button>
            {open && n.children && renderTree(ws, n.children, depth + 1)}
          </div>
        );
      }
      const fs = fileSession(ws.id, n.path);
      const active =
        route.kind === "workspace" &&
        route.workspaceId === ws.id &&
        route.filePath === n.path;
      return (
        <button
          key={n.path}
          className={`sb-row file ${active ? "active" : ""}`}
          style={{ paddingLeft: 12 + depth * 13 }}
          onClick={() =>
            onNavigate({
              kind: "workspace",
              workspaceId: ws.id,
              filePath: n.path,
              fileMode: "view",
            })
          }
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, wsId: ws.id, path: n.path, hasSession: !!fs });
          }}
          title={n.path}
        >
          <span className="sb-item-icon file-icon">
            <IconFileCode size={13} />
          </span>
          <span className="sb-name">{n.name}</span>
          {fs && renderSessionBadge(fs)}
        </button>
      );
    });
  }

  return (
    <aside className="sidebar" ref={sbRef}>
      <div className="sb-head">
        <div
          className="sb-brand-wrap"
          onClick={() => onNavigate({ kind: "new" })}
          title="回到开始页"
        >
          <span className="sb-brand-logo">CS</span>
          <span className="sb-brand">CodeSlice</span>
        </div>
        <button className="sb-icon-btn" title="收起侧栏（Ctrl+B）" onClick={onCollapse}>
          <PanelIcon />
        </button>
      </div>

      <button
        className={`sb-new${route.kind === "new" ? " active" : ""}`}
        onClick={() => onNavigate({ kind: "new" })}
      >
        <IconPlus size={14} />
        <span>新建阅读 / 打开项目</span>
      </button>

      {(workspaces.length > 0 || sessions.length > 0) && (
        <div className="sb-search-wrap">
          <span className="sb-search-icon">
            <IconSearch size={12} />
          </span>
          <input
            className="sb-search"
            value={query}
            placeholder="搜索文件或代码片段…"
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button className="sb-search-clear" onClick={() => setQuery("")} title="清空">
              ×
            </button>
          )}
        </div>
      )}

      <div className="sb-scroll">
        {workspaces.length > 0 && (
          <div className="sb-group">
            <div className="sb-group-title">工作区 ({workspaces.length})</div>
            {workspaces.map((w) => {
              const isCur = route.kind === "workspace" && route.workspaceId === w.id;
              const filteredTree = filterTree(w.tree, q);
              if (q && filteredTree.length === 0 && !w.name.toLowerCase().includes(q)) {
                return null;
              }
              const open = q ? true : sb.wsExpanded.includes(w.id);
              return (
                <div key={w.id} className="sb-ws-block">
                  <div className={`sb-ws-row ${isCur && !route.filePath ? "active" : ""}`}>
                    <button
                      className="sb-row ws-root-row"
                      onClick={() => {
                        if (!isCur) {
                          onNavigate({ kind: "workspace", workspaceId: w.id });
                          if (!open)
                            updateSb({ ...sb, wsExpanded: [...sb.wsExpanded, w.id] });
                        } else {
                          updateSb({
                            ...sb,
                            wsExpanded: open
                              ? sb.wsExpanded.filter((x) => x !== w.id)
                              : [...sb.wsExpanded, w.id],
                          });
                        }
                      }}
                    >
                      <span className="caret">{open ? "▾" : "▸"}</span>
                      <span className="sb-item-icon ws-icon">
                        {open ? <IconFolderOpen size={14} /> : <IconFolder size={14} />}
                      </span>
                      <span className="sb-name">{w.name}</span>
                    </button>
                    <span className="sb-hover-actions">
                      <button
                        className="sb-icon-btn"
                        title="刷新文件树"
                        onClick={() => onRefreshWorkspace(w)}
                      >
                        <IconRefresh size={12} />
                      </button>
                      <button
                        className="sb-icon-btn danger"
                        title="删除工作区"
                        onClick={() => onDeleteWorkspace(w)}
                      >
                        <IconTrash size={12} />
                      </button>
                    </span>
                  </div>
                  {open && (
                    <div className="sb-ws-children">
                      <button
                        className={`sb-row ${isCur && !route.filePath ? "active" : ""}`}
                        style={{ paddingLeft: 24 }}
                        onClick={() =>
                          onNavigate({ kind: "workspace", workspaceId: w.id })
                        }
                      >
                        <span className="sb-item-icon ov-icon">
                          <IconOverview size={13} />
                        </span>
                        <span className="sb-name">项目概览</span>
                      </button>
                      {renderTree(w, filteredTree, 1)}
                      {w.truncated && !q && (
                        <div className="sb-truncated">文件较多，仅展示前序部分</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {snippets.length > 0 && (
          <div className="sb-group">
            <div className="sb-group-title">代码片段 ({snippets.length})</div>
            {snippets.map((s) => {
              const active = route.kind === "snippet" && route.sessionId === s.id;
              return (
                <div key={s.id} className={`sb-ws-row ${active ? "active" : ""}`}>
                  <button
                    className="sb-row"
                    onClick={() => onNavigate({ kind: "snippet", sessionId: s.id })}
                    title={s.title}
                  >
                    <span className="sb-item-icon snippet-icon">
                      <IconCode size={13} />
                    </span>
                    <span className="sb-name">{s.title}</span>
                    {renderSessionBadge(s)}
                  </button>
                  <span className="sb-hover-actions">
                    <button
                      className="sb-icon-btn danger"
                      title="删除会话"
                      onClick={() => onDeleteSession(s)}
                    >
                      <IconTrash size={12} />
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {workspaces.length === 0 && snippets.length === 0 && (
          <div className="sb-empty">
            {q ? "没有匹配的文件或会话" : "暂无工作区或代码片段"}
          </div>
        )}
      </div>

      <div className="sb-foot">
        <ThemeButton theme={theme} onToggle={onToggleTheme} />
        <span className="sb-shortcut-hint" title="Ctrl+B 收起侧栏 · Ctrl+滚轮缩放各栏字号">
          Ctrl+B 侧栏
        </span>
      </div>

      {menu && (
        <div
          ref={menuRef}
          className="ctx-menu file-menu"
          style={{
            left: Math.min(menu.x, window.innerWidth - 180),
            top: Math.min(menu.y, window.innerHeight - 100),
          }}
        >
          <button
            className="ctx-item"
            onClick={() => {
              onNavigate({
                kind: "workspace",
                workspaceId: menu.wsId,
                filePath: menu.path,
                fileMode: "view",
              });
              setMenu(null);
            }}
          >
            打开
          </button>
          <button
            className="ctx-item"
            onClick={() => {
              onNavigate({
                kind: "workspace",
                workspaceId: menu.wsId,
                filePath: menu.path,
                fileMode: "slice",
              });
              setMenu(null);
            }}
          >
            {menu.hasSession ? "切分阅读（继续）" : "切分阅读"}
          </button>
        </div>
      )}
    </aside>
  );
}
