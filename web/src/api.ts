import type { ChatMsg, Slice, TreeNode } from "./types";
import type { Detail } from "./detail";

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
    slices?: Slice[];
    understoodTitles: string[];
    messages: ChatMsg[];
    selection?: { startLine: number; endLine: number };
    projectContext?: ProjectContext;
    codePurpose?: string;
    detail?: Detail;
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

/** markdown 预览里的相对资源（图片等）→ 服务端 /api/workspace/asset 地址。 */
export function workspaceAssetUrl(root: string, path: string): string {
  return `/api/workspace/asset?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`;
}

/** 生成某一段的总结：只带本段代码（带行号）与本段问题/追问/标注明细。 */
export function streamSliceQA(
  args: {
    language: string;
    slice: { title: string; startLine: number; endLine: number; role?: string };
    codePurpose?: string;
    code: string;
    digest: string;
  },
  onDelta: (t: string) => void,
  signal?: AbortSignal
): Promise<string> {
  return streamPost("/api/slice-qa", args, onDelta, signal);
}

/** 把若干 md 文件写入 <base>/summary/<sub>/ 目录，返回实际写入的文件名与目录。 */
export async function exportSummaryFiles(
  base: string,
  sub: string,
  files: { name: string; content: string }[]
): Promise<{ dir: string; written: string[] }> {
  const res = await fetch("/api/summary/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ base, sub, files }),
  });
  await checkErr(res);
  return (await res.json()) as { dir: string; written: string[] };
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
