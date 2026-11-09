import type { Session, Workspace } from "./types";

const KEY = "codeslice:sessions";
const WS_KEY = "codeslice:workspaces";

export function loadSessions(): Session[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function saveSession(session: Session): void {
  const all = loadSessions();
  const i = all.findIndex((s) => s.id === session.id);
  if (i >= 0) all[i] = session;
  else all.unshift(session);
  localStorage.setItem(KEY, JSON.stringify(all));
}

export function deleteSession(id: string): void {
  localStorage.setItem(KEY, JSON.stringify(loadSessions().filter((s) => s.id !== id)));
}

export function loadWorkspaces(): Workspace[] {
  try {
    const v = JSON.parse(localStorage.getItem(WS_KEY) ?? "[]");
    // 统一按导入时间升序：先导入在前，后导入在后
    return Array.isArray(v) ? [...v].sort((a, b) => a.createdAt - b.createdAt) : [];
  } catch {
    return [];
  }
}

export function saveWorkspace(ws: Workspace): void {
  const all = loadWorkspaces();
  const i = all.findIndex((w) => w.id === ws.id);
  if (i >= 0) all[i] = ws;
  else all.push(ws);
  localStorage.setItem(WS_KEY, JSON.stringify(all));
}

export function deleteWorkspace(id: string): void {
  localStorage.setItem(WS_KEY, JSON.stringify(loadWorkspaces().filter((w) => w.id !== id)));
  // 一并删除属于该工作区的会话
  localStorage.setItem(KEY, JSON.stringify(loadSessions().filter((s) => s.workspaceId !== id)));
}

export function findFileSession(workspaceId: string, filePath: string): Session | undefined {
  return loadSessions().find((s) => s.workspaceId === workspaceId && s.filePath === filePath);
}

export function sessionTitle(code: string): string {
  const line = code.split("\n").find((l) => l.trim())?.trim() ?? "未命名会话";
  return line.length > 40 ? line.slice(0, 40) + "…" : line;
}

export function guessLanguage(code: string): string {
  const s = code;
  if (/^\s*#include|\bstd::|printf\s*\(/.test(s)) return s.includes("std::") ? "cpp" : "c";
  if (/^\s*(def |import |from |print\(|elif )/m.test(s)) return "python";
  if (/^\s*(package \w+[\s\S]*?func |func main\(\))/m.test(s)) return "go";
  if (/^\s*(fn |let mut |impl |use std)/m.test(s)) return "rust";
  if (/\bpublic\s+(static\s+)?(class|void)|System\.out\.println/.test(s)) return "java";
  if (/:\s*(string|number|boolean)\b|interface\s+\w+|import\s+\{[^}]*\}\s+from/.test(s))
    return "typescript";
  return "javascript";
}

// ---------- 侧栏展开状态 ----------
const SB_KEY = "codeslice:sidebar";

export interface SidebarState {
  wsExpanded: string[];
  dirExpanded: Record<string, string[]>;
}

export function loadSidebarState(): SidebarState {
  try {
    const v = JSON.parse(localStorage.getItem(SB_KEY) ?? "{}");
    return {
      wsExpanded: Array.isArray(v.wsExpanded) ? v.wsExpanded : [],
      dirExpanded:
        v.dirExpanded && typeof v.dirExpanded === "object" ? v.dirExpanded : {},
    };
  } catch {
    return { wsExpanded: [], dirExpanded: {} };
  }
}

export function saveSidebarState(s: SidebarState): void {
  localStorage.setItem(SB_KEY, JSON.stringify(s));
}
