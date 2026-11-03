import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface TreeNode {
  name: string;
  path: string; // 相对 root 的 posix 路径
  type: "dir" | "file";
  children?: TreeNode[];
}

const IGNORED_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "out", ".venv", "venv", "env",
  "__pycache__", ".next", ".nuxt", "target", ".idea", ".vscode", "coverage",
  ".pytest_cache", ".mypy_cache",
]);

const MAX_FILES = 3000;
const MAX_DEPTH = 12;
const MAX_FILE_BYTES = 400 * 1024;

/** Windows / WSL UNC / POSIX 路径统一转成本机 POSIX 路径。 */
export function toLocalPath(input: string): string {
  let p = input.trim().replace(/^["']+|["']+$/g, "").trim();
  // \\wsl.localhost\<发行版>\home\x 或 \\wsl$\<发行版>\home\x → /home/x
  const unc = p.match(/^[/\\]{2}wsl(?:\.localhost|\$)[/\\][^/\\]+[/\\](.*)$/i);
  if (unc) return "/" + unc[1].replace(/\\/g, "/").replace(/\/+$/, "");
  // E:\a\b 或 E:/a/b → /mnt/e/a/b
  const drive = p.match(/^([A-Za-z]):[/\\](.*)$/);
  if (drive) {
    return `/mnt/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, "/")}`.replace(/\/+$/, "");
  }
  if (/^[A-Za-z]:$/.test(p)) return `/mnt/${p[0].toLowerCase()}`;
  return p.replace(/\/+$/, "") || "/";
}

/** 递归列目录：目录在前、按名称排序；忽略 . 开头和常见产物目录。 */
export function listTree(root: string): { tree: TreeNode[]; truncated: boolean; fileCount: number } {
  let fileCount = 0;
  let truncated = false;

  function walk(dir: string, rel: string, depth: number): TreeNode[] {
    if (truncated) return [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const nodes: TreeNode[] = [];
    const sorted = entries
      .filter((e) => !e.name.startsWith(".") && !e.isSymbolicLink())
      .sort((a, b) => {
        const da = a.isDirectory() ? 0 : 1;
        const db = b.isDirectory() ? 0 : 1;
        return da - db || a.name.localeCompare(b.name);
      });
    for (const e of sorted) {
      if (truncated) break;
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name)) continue;
        const children = depth + 1 > MAX_DEPTH ? [] : walk(path.join(dir, e.name), relPath, depth + 1);
        if (depth + 1 > MAX_DEPTH) truncated = true;
        nodes.push({ name: e.name, path: relPath, type: "dir", children });
      } else if (e.isFile()) {
        fileCount++;
        if (fileCount > MAX_FILES) {
          truncated = true;
          break;
        }
        nodes.push({ name: e.name, path: relPath, type: "file" });
      }
    }
    return nodes;
  }

  const tree = walk(root, "", 0);
  return { tree, truncated, fileCount };
}

/** 解析 root 内的相对路径，越界（含符号链接逃逸）抛错。 */
export async function resolveInside(root: string, rel: string): Promise<string> {
  const realRoot = await fsp.realpath(root);
  const joined = path.resolve(realRoot, rel);
  const relTo = path.relative(realRoot, joined);
  if (relTo === ".." || relTo.startsWith(`..${path.sep}`) || path.isAbsolute(relTo)) {
    throw new Error("路径越界：只能访问项目目录内的文件。");
  }
  let target = joined;
  try {
    target = await fsp.realpath(joined); // 符号链接逃逸检查
  } catch {
    // 目标不存在：词法检查已保证在 root 内，由调用方处理 ENOENT
  }
  const relTo2 = path.relative(realRoot, target);
  if (relTo2 === ".." || relTo2.startsWith(`..${path.sep}`) || path.isAbsolute(relTo2)) {
    throw new Error("路径越界：只能访问项目目录内的文件。");
  }
  return target;
}

const LANG_MAP: Record<string, string> = {
  py: "python", js: "javascript", mjs: "javascript", cjs: "javascript",
  jsx: "javascript", ts: "typescript", mts: "typescript", cts: "typescript",
  tsx: "typescript", java: "java", c: "c", h: "c", cpp: "cpp", hpp: "cpp",
  cc: "cpp", go: "go", rs: "rust", rb: "ruby", php: "php", cs: "csharp",
  kt: "kotlin", swift: "swift", sh: "bash", bash: "bash", json: "json",
  yaml: "yaml", yml: "yaml", toml: "toml", md: "markdown", html: "markup",
  htm: "markup", css: "css", sql: "sql", xml: "markup", vue: "markup",
};

export function languageOf(p: string): string {
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  return LANG_MAP[ext] ?? "text";
}

/** 读文件：>400KB 或含 NUL 视为不可读。 */
export async function readProjectFile(root: string, rel: string): Promise<{ content: string; language: string }> {
  const abs = await resolveInside(root, rel);
  const st = await fsp.stat(abs);
  if (!st.isFile()) throw new Error("这不是一个文件。");
  if (st.size > MAX_FILE_BYTES) throw new Error("文件过大（超过 400KB），暂不支持阅读。");
  const buf = await fsp.readFile(abs);
  if (buf.subarray(0, 8192).includes(0)) throw new Error("二进制文件无法阅读。");
  return { content: buf.toString("utf-8"), language: languageOf(rel) };
}

const MANIFESTS = [
  "package.json", "requirements.txt", "pyproject.toml", "go.mod",
  "Cargo.toml", "pom.xml", "build.gradle",
];
const ENTRY_CANDIDATES = [
  "main.py", "app.py", "manage.py", "index.js", "index.ts", "server.js", "server.ts",
  "src/main.py", "src/main.js", "src/main.ts", "src/index.js", "src/index.ts",
  "src/App.js", "src/App.jsx", "src/App.ts", "src/App.tsx", "cmd/main.go",
];

export function treeToText(tree: TreeNode[], indent = "", out: string[] = []): string[] {
  for (const n of tree) {
    out.push(indent + n.name + (n.type === "dir" ? "/" : ""));
    if (n.type === "dir" && n.children) treeToText(n.children, indent + "  ", out);
  }
  return out;
}

async function readHead(abs: string, maxChars: number): Promise<string | null> {
  try {
    // 由调用方保证 abs 在 root 内
    const buf = await fsp.readFile(abs);
    if (buf.subarray(0, 8192).includes(0)) return null;
    return buf.toString("utf-8").slice(0, maxChars);
  } catch {
    return null;
  }
}

export interface BrowseRoot {
  label: string;
  path: string;
}

export interface BrowseResult {
  current: string;
  parent: string | null;
  dirs: { name: string; path: string }[];
  roots: BrowseRoot[];
}

/** 探测电脑上的快捷根路径（Windows 各盘符 + WSL 主目录 + 当前工作目录上级）。 */
export function detectRoots(): BrowseRoot[] {
  const roots: BrowseRoot[] = [];
  // WSL 下 /mnt/c, /mnt/d, /mnt/e ...
  try {
    for (const d of fs.readdirSync("/mnt", { withFileTypes: true })) {
      if (d.isDirectory() && /^[a-z]$/i.test(d.name)) {
        const p = `/mnt/${d.name}`;
        try {
          fs.accessSync(p, fs.constants.R_OK);
          roots.push({ label: `${d.name.toUpperCase()}: 盘`, path: p });
        } catch { /* 无权限或未挂载 */ }
      }
    }
  } catch { /* 非 WSL */ }
  const home = os.homedir();
  if (home) roots.push({ label: "主目录 (~)", path: home });
  roots.push({ label: "根目录 (/)", path: "/" });
  return roots;
}

/** 列出指定目录下的直接子文件夹，供前端文件夹选择器浏览。 */
export async function browseDir(input?: string): Promise<BrowseResult> {
  const roots = detectRoots();
  const fallback = roots[0]?.path || os.homedir() || "/";
  const target = input && input.trim() ? toLocalPath(input) : fallback;
  const resolved = path.resolve(target);
  const st = await fsp.stat(resolved);
  if (!st.isDirectory()) throw new Error(`不是文件夹：${resolved}`);

  let entries: fs.Dirent[] = [];
  try {
    entries = await fsp.readdir(resolved, { withFileTypes: true });
  } catch (e) {
    throw new Error(`无法读取目录：${(e as Error).message}`);
  }
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => ({ name: e.name, path: path.posix.join(resolved.replace(/\\/g, "/"), e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const parent = resolved === "/" ? null : path.posix.dirname(resolved.replace(/\\/g, "/"));
  return { current: resolved, parent, dirs, roots };
}

/** 收集项目概览所需的上下文文本（总量约 30000 字以内）。 */
export async function collectOverviewContext(root: string, tree: TreeNode[]): Promise<string> {
  const parts: string[] = [];
  const treeText = treeToText(tree).slice(0, 400).join("\n");
  parts.push(`文件树：\n${treeText}`);
  let budget = 30000 - treeText.length;

  // README*
  try {
    const entries = await fsp.readdir(root);
    const readme = entries.find((e) => /^readme/i.test(e));
    if (readme) {
      const t = await readHead(path.join(root, readme), 6000);
      if (t) {
        parts.push(`\nREADME (${readme})：\n${t}`);
        budget -= t.length;
      }
    }
  } catch { /* ignore */ }

  for (const m of MANIFESTS) {
    if (budget <= 0) break;
    const t = await readHead(path.join(root, m), 3000);
    if (t) {
      parts.push(`\n${m}：\n${t}`);
      budget -= t.length;
    }
  }

  // 入口候选 + cmd/*/main.go
  const candidates = [...ENTRY_CANDIDATES];
  try {
    const cmd = path.join(root, "cmd");
    for (const d of await fsp.readdir(cmd)) {
      candidates.push(`cmd/${d}/main.go`);
    }
  } catch { /* ignore */ }

  let taken = 0;
  for (const c of candidates) {
    if (taken >= 4 || budget <= 0) break;
    try {
      const abs = await resolveInside(root, c);
      const t = await readHead(abs, Math.min(3000, budget));
      if (t !== null) {
        parts.push(`\n入口文件 ${c}：\n${t}`);
        budget -= t.length;
        taken++;
      }
    } catch { /* 不存在或越界，跳过 */ }
  }
  return parts.join("\n");
}
