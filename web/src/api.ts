import type { ChatMsg, Slice, TreeNode } from "./types";

export interface ProjectContext {
  name: string;
  filePath: string;
  overview?: string;
}

async function checkErr(res: Response): Promise<void> {
  if (!res.ok) {
    let msg = `请求失败（${res.status}）`;
    const text = await res.text().catch(() => "");
    try {
      const j = JSON.parse(text);
      if (j?.error) msg = j.error;
    } catch {
      if (text.trim()) msg = `${msg}：${text.trim().slice(0, 300)}`;
    }
    throw new Error(msg);
  }
}

export interface SliceResult {
  purpose?: string;
  slices: Slice[];
}

export async function postSlice(
  code: string,
  language: string,
  projectContext?: ProjectContext
): Promise<SliceResult> {
  const res = await fetch("/api/slice", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, language, projectContext }),
  });
  await checkErr(res);
  return (await res.json()) as SliceResult;
}

async function streamPost(
  url: string,
  body: unknown,
  onDelta: (t: string) => void,
  signal?: AbortSignal
): Promise<string> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  await checkErr(res);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let full = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const t = dec.decode(value, { stream: true });
    full += t;
    onDelta(t);
  }
  return full;
}

export function streamChat(
  args: {
    code: string;
    language: string;
    slice: Slice;
    understoodTitles: string[];
    messages: ChatMsg[];
    selection?: { startLine: number; endLine: number };
    projectContext?: ProjectContext;
    codePurpose?: string;
  },
  onDelta: (t: string) => void,
  signal?: AbortSignal
): Promise<string> {
  return streamPost("/api/chat", args, onDelta, signal);
}

export interface BrowseResult {
  current: string;
  parent: string | null;
  dirs: { name: string; path: string }[];
  roots: { label: string; path: string }[];
}

export async function browseWorkspace(path?: string): Promise<BrowseResult> {
  const res = await fetch("/api/workspace/browse", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  await checkErr(res);
  return res.json();
}

export async function openWorkspace(
  path: string
): Promise<{ root: string; name: string; tree: TreeNode[]; truncated: boolean; fileCount: number }> {
  const res = await fetch("/api/workspace/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  await checkErr(res);
  return res.json();
}

export async function readWorkspaceFile(
  root: string,
  path: string
): Promise<{ content: string; language: string }> {
  const res = await fetch("/api/workspace/file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ root, path }),
  });
  await checkErr(res);
  return res.json();
}

export function streamOverview(
  root: string,
  onDelta: (t: string) => void,
  signal?: AbortSignal
): Promise<string> {
  return streamPost("/api/workspace/overview", { root }, onDelta, signal);
}

export function streamWorkspaceChat(
  args: { root: string; overview?: string; messages: ChatMsg[] },
  onDelta: (t: string) => void,
  signal?: AbortSignal
): Promise<string> {
  return streamPost("/api/workspace/chat", args, onDelta, signal);
}

export function streamSummary(
  args: {
    code: string;
    language: string;
    codePurpose?: string;
    slices: { title: string; startLine: number; endLine: number; qa: string }[];
  },
  onDelta: (t: string) => void,
  signal?: AbortSignal
): Promise<string> {
  return streamPost("/api/summary", args, onDelta, signal);
}
