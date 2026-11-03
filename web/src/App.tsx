import { useCallback, useEffect, useRef, useState } from "react";
import NewPage from "./Home";
import Reader, { type ReaderHandle } from "./Reader";
import WorkspaceMain from "./WorkspaceView";
import { Sidebar, type Route } from "./Sidebar";
import type { Session, TreeNode, Workspace } from "./types";
import {
  deleteSession,
  deleteWorkspace,
  loadSessions,
  loadWorkspaces,
  saveSession,
  saveWorkspace,
} from "./store";
import { openWorkspace } from "./api";
import { loadLayout, saveLayout } from "./layout";
import { applyTheme, loadTheme, saveTheme, type Theme } from "./theme";

const ROUTE_KEY = "codeslice:route";

function loadRoute(): Route {
  try {
    const v = JSON.parse(localStorage.getItem(ROUTE_KEY) ?? "null");
    if (v && (v.kind === "new" || v.kind === "snippet" || v.kind === "workspace")) return v;
  } catch {
    /* ignore */
  }
  return { kind: "new" };
}

function ExpandIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <line x1="6" y1="3.5" x2="6" y2="12.5" stroke="currentColor" strokeWidth="1.4" />
      <polyline points="9,6 11,8 9,10" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

export default function App() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>(loadWorkspaces);
  const [sessions, setSessions] = useState<Session[]>(loadSessions);
  const [route, setRoute] = useState<Route>(loadRoute);
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const [sidebarPx, setSidebarPx] = useState(() => loadLayout().sidebarPx);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => loadLayout().sidebarCollapsed);
  const sidebarPxRef = useRef(sidebarPx);
  sidebarPxRef.current = sidebarPx;
  const dragRef = useRef(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const readerRef = useRef<ReaderHandle>(null);

  useEffect(() => {
    localStorage.setItem(ROUTE_KEY, JSON.stringify(route));
  }, [route]);

  // Ctrl/Cmd+B 切换侧栏（输入框内也生效）
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setSidebarCollapsed((c) => {
          const next = !c;
          saveLayout({ sidebarCollapsed: next });
          return next;
        });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((t) => {
      const next = t === "light" ? "dark" : "light";
      saveTheme(next);
      applyTheme(next);
      return next;
    });
  }, []);

  // ---------- 数据更新（不改变路由） ----------
  const updateSession = useCallback((next: Session) => {
    saveSession(next);
    setSessions((all) => {
      const i = all.findIndex((s) => s.id === next.id);
      if (i >= 0) {
        const out = [...all];
        out[i] = next;
        return out;
      }
      return [next, ...all];
    });
  }, []);

  const updateWorkspace = useCallback((next: Workspace) => {
    saveWorkspace(next);
    setWorkspaces((all) => {
      const i = all.findIndex((w) => w.id === next.id);
      if (i >= 0) {
        const out = [...all];
        out[i] = next;
        return out;
      }
      return [next, ...all];
    });
  }, []);

  async function refreshWorkspace(w: Workspace) {
    try {
      const r = await openWorkspace(w.root);
      updateWorkspace({ ...w, tree: r.tree, truncated: r.truncated, name: r.name });
    } catch {
      /* 刷新失败保持原样 */
    }
  }

  function removeWorkspace(w: Workspace) {
    if (!window.confirm(`删除工作区「${w.name}」及其所有阅读记录？`)) return;
    deleteWorkspace(w.id);
    setWorkspaces(loadWorkspaces());
    setSessions(loadSessions());
    if (route.kind === "workspace" && route.workspaceId === w.id) {
      setRoute({ kind: "new" });
    }
  }

  function removeSession(s: Session) {
    deleteSession(s.id);
    setSessions(loadSessions());
    if (route.kind === "snippet" && route.sessionId === s.id) {
      setRoute({ kind: "new" });
    }
  }

  function openOrCreateWorkspace(r: {
    root: string;
    name: string;
    tree: TreeNode[];
    truncated: boolean;
  }) {
    const existing = workspaces.find((w) => w.root === r.root);
    if (existing) {
      setRoute({ kind: "workspace", workspaceId: existing.id });
      return;
    }
    const ws: Workspace = {
      id: `w-${Date.now()}`,
      root: r.root,
      name: r.name,
      tree: r.tree,
      truncated: r.truncated,
      overviewMessages: [],
      createdAt: Date.now(),
    };
    updateWorkspace(ws);
    setRoute({ kind: "workspace", workspaceId: ws.id });
  }

  // ---------- 侧栏拖拽 ----------
  function onSbDown(e: React.PointerEvent<HTMLElement>) {
    dragRef.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    document.body.classList.add("dragging", "drag-v");
  }
  function onSbMove(e: React.PointerEvent<HTMLElement>) {
    if (!dragRef.current || !bodyRef.current) return;
    const r = bodyRef.current.getBoundingClientRect();
    setSidebarPx(Math.min(480, Math.max(200, e.clientX - r.left)));
  }
  function onSbUp() {
    if (!dragRef.current) return;
    dragRef.current = false;
    document.body.classList.remove("dragging", "drag-v");
    saveLayout({ sidebarPx: sidebarPxRef.current });
  }

  // ---------- 渲染 ----------
  const curSession =
    route.kind === "snippet" ? sessions.find((s) => s.id === route.sessionId) : undefined;
  const curWorkspace =
    route.kind === "workspace"
      ? workspaces.find((w) => w.id === route.workspaceId)
      : undefined;

  let breadcrumb = "新建";
  let main: React.ReactNode = (
    <NewPage
      onOpen={(s) => {
        updateSession(s);
        setRoute({ kind: "snippet", sessionId: s.id });
      }}
      onOpenWorkspace={openOrCreateWorkspace}
      workspaces={workspaces}
    />
  );
  let showReslice = false;

  if (route.kind === "snippet" && curSession) {
    breadcrumb = curSession.title;
    showReslice = true;
    main = (
      <Reader
        key={curSession.id}
        ref={readerRef}
        session={curSession}
        onChange={updateSession}
        onBack={() => setRoute({ kind: "new" })}
        theme={theme}
        onToggleTheme={toggleTheme}
        embedded
      />
    );
  } else if (route.kind === "workspace" && curWorkspace) {
    breadcrumb = route.filePath
      ? `${curWorkspace.name} / ${route.filePath}`
      : `${curWorkspace.name} / 项目概览`;
    showReslice = !!route.filePath;
    main = (
      <WorkspaceMain
        key={curWorkspace.id}
        workspace={curWorkspace}
        filePath={route.filePath}
        sessions={sessions}
        onWorkspaceChange={updateWorkspace}
        onSessionChange={updateSession}
        onOpenFile={(p) =>
          setRoute({ kind: "workspace", workspaceId: curWorkspace.id, filePath: p || undefined })
        }
        theme={theme}
        onToggleTheme={toggleTheme}
        readerRef={readerRef}
      />
    );
  }

  return (
    <div className="app-shell" ref={bodyRef}>
      {!sidebarCollapsed && (
        <>
          <div className="sidebar-wrap" style={{ width: sidebarPx }}>
            <Sidebar
              workspaces={workspaces}
              sessions={sessions}
              route={route}
              onNavigate={setRoute}
              onDeleteWorkspace={removeWorkspace}
              onDeleteSession={removeSession}
              onRefreshWorkspace={refreshWorkspace}
              theme={theme}
              onToggleTheme={toggleTheme}
              onCollapse={() => {
                setSidebarCollapsed(true);
                saveLayout({ sidebarCollapsed: true });
              }}
            />
          </div>
          <div
            className="splitter-v"
            onPointerDown={onSbDown}
            onPointerMove={onSbMove}
            onPointerUp={onSbUp}
          />
        </>
      )}
      <div className="main-area">
        <header className="reader-header">
          {sidebarCollapsed && (
            <button
              className="sb-icon-btn"
              title="展开侧栏（Ctrl+B）"
              onClick={() => {
                setSidebarCollapsed(false);
                saveLayout({ sidebarCollapsed: false });
              }}
            >
              <ExpandIcon />
            </button>
          )}
          <span className="reader-title">{breadcrumb}</span>
          {showReslice && (
            <button className="link" onClick={() => readerRef.current?.reslice()}>
              重新让 AI 切分
            </button>
          )}
        </header>
        <div className="main-content">{main}</div>
      </div>
    </div>
  );
}
