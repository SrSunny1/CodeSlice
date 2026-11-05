import { useRef, useState } from "react";
import { loadSidebarState, saveSidebarState } from "./store";
import { usePaneZoom } from "./paneZoom";
import { ThemeButton } from "./Home";
import type { Theme } from "./theme";
import type { Session, TreeNode, Workspace } from "./types";

export type Route =
  | { kind: "new" }
  | { kind: "snippet"; sessionId: string }
  | { kind: "workspace"; workspaceId: string; filePath?: string };

function PanelIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <line x1="6" y1="3.5" x2="6" y2="12.5" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
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
  const sbRef = useRef<HTMLElement>(null);
  usePaneZoom(sbRef, "zSidebar");

  function updateSb(next: typeof sb) {
    setSb(next);
    saveSidebarState(next);
  }

  const snippets = sessions.filter((s) => !s.workspaceId);

  function sessionBadge(s: Session): string {
    const done = s.slices.filter((x) => x.status === "done").length;
    return done === s.slices.length ? "✓" : `${done}/${s.slices.length}`;
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
        const open = openDirs.has(n.path);
        return (
          <div key={n.path}>
            <button
              className="sb-row dir"
              style={{ paddingLeft: 14 + depth * 14 }}
              onClick={() => toggleDir(ws.id, n.path)}
            >
              <span className="caret">{open ? "▾" : "▸"}</span>
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
          style={{ paddingLeft: 14 + depth * 14 }}
          onClick={() =>
            onNavigate({ kind: "workspace", workspaceId: ws.id, filePath: n.path })
          }
        >
          <span className="sb-name">{n.name}</span>
          {fs && <span className="file-badge">{sessionBadge(fs)}</span>}
        </button>
      );
    });
  }

  return (
    <aside className="sidebar" ref={sbRef}>
      <div className="sb-head">
        <span className="sb-brand">CodeSlice</span>
        <button className="sb-icon-btn" title="收起侧栏（Ctrl+B）" onClick={onCollapse}>
          <PanelIcon />
        </button>
      </div>
      <button className="sb-new" onClick={() => onNavigate({ kind: "new" })}>
        ＋ 新建
      </button>

      <div className="sb-scroll">
        {workspaces.length > 0 && (
          <div className="sb-group">
            <div className="sb-group-title">工作区</div>
            {workspaces.map((w) => {
              const isCur = route.kind === "workspace" && route.workspaceId === w.id;
              const open = sb.wsExpanded.includes(w.id);
              return (
                <div key={w.id}>
                  <div className={`sb-ws-row ${isCur ? "active" : ""}`}>
                    <button
                      className="sb-row"
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
                      <span className="sb-name">📁 {w.name}</span>
                    </button>
                    <span className="sb-hover-actions">
                      <button
                        className="sb-icon-btn"
                        title="刷新文件树"
                        onClick={() => onRefreshWorkspace(w)}
                      >
                        ⟳
                      </button>
                      <button
                        className="sb-icon-btn danger"
                        title="删除工作区"
                        onClick={() => onDeleteWorkspace(w)}
                      >
                        ×
                      </button>
                    </span>
                  </div>
                  {open && (
                    <div className="sb-ws-children">
                      <button
                        className={`sb-row ${isCur && !route.filePath ? "active" : ""}`}
                        style={{ paddingLeft: 14 }}
                        onClick={() =>
                          onNavigate({ kind: "workspace", workspaceId: w.id })
                        }
                      >
                        <span className="sb-name">📋 项目概览</span>
                      </button>
                      {renderTree(w, w.tree, 1)}
                      {w.truncated && (
                        <div className="sb-truncated">文件过多，只显示了一部分</div>
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
            <div className="sb-group-title">代码片段</div>
            {snippets.map((s) => {
              const active = route.kind === "snippet" && route.sessionId === s.id;
              return (
                <div key={s.id} className={`sb-ws-row ${active ? "active" : ""}`}>
                  <button
                    className="sb-row"
                    onClick={() => onNavigate({ kind: "snippet", sessionId: s.id })}
                  >
                    <span className="sb-name">{s.title}</span>
                    <span className="file-badge">{sessionBadge(s)}</span>
                  </button>
                  <span className="sb-hover-actions">
                    <button
                      className="sb-icon-btn danger"
                      title="删除"
                      onClick={() => onDeleteSession(s)}
                    >
                      ×
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="sb-foot">
        <ThemeButton theme={theme} onToggle={onToggleTheme} />
      </div>
    </aside>
  );
}
