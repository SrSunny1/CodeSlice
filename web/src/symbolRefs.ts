/**
 * 「双击查引用」纯函数：在同一文件里按标识符名称匹配出现位置，
 * 并用轻量规则把每处分成 定义/赋值/调用/导入/引用/文本。
 * 不做真正的语义/作用域分析，只保证快、可测、对多语言大体靠谱。
 */

export type RefKind = "def" | "assign" | "call" | "import" | "ref" | "text";

export interface SymbolRef {
  /** 1-based 行号 */
  line: number;
  /** 行内 0-based 字符偏移 */
  col: number;
  kind: RefKind;
  /** 所在函数/类名（缩进启发式，可能为空） */
  scope?: string;
  /** 该行文本（trim 后最多 160 字） */
  text: string;
}

export type Span = [number, number]; // [start, end) 行内列区间

export interface TokenLike {
  types: string[];
  content: string;
  empty?: boolean;
}

/** 标识符：Unicode 字母/_/$ 开头，后接字母/数字/_/$。数字永远不是标识符。 */
const IDENT = /[\p{L}_$][\p{L}\p{N}_$]*/gu;

/** 行内 col 处的标识符；caret 落在词尾时也算命中前一个词。 */
export function identifierAt(
  lineText: string,
  col: number
): { name: string; start: number; end: number } | null {
  let tailHit: { name: string; start: number; end: number } | null = null;
  for (const m of lineText.matchAll(IDENT)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (start <= col && col < end) return { name: m[0], start, end };
    if (end === col) tailHit = { name: m[0], start, end };
  }
  return tailHit;
}

// ---- Prism token → 行内区间分类 ----
// inert：注释/字符串等"不算引用"的文字；skip：双击时直接忽略的关键字/数字/符号。

const INERT_TYPES = new Set(["comment", "prolog", "doctype", "cdata", "regex", "char"]);
const SKIP_TYPES = new Set([
  "keyword",
  "number",
  "boolean",
  "operator",
  "punctuation",
  "builtin",
]);

function isInert(types: string[]): boolean {
  return types.some((t) => INERT_TYPES.has(t) || t.endsWith("string"));
}

function isSkip(types: string[]): boolean {
  return types.some((t) => SKIP_TYPES.has(t));
}

/** 把 normalizeTokens 的结果摊成逐行区间表（empty token 长度按 0 计）。 */
export function classifySpans(tokenLines: TokenLike[][]): {
  inert: Span[][];
  skip: Span[][];
} {
  const inert: Span[][] = [];
  const skip: Span[][] = [];
  for (const line of tokenLines) {
    const iSpans: Span[] = [];
    const sSpans: Span[] = [];
    let col = 0;
    for (const tok of line) {
      const len = tok.empty ? 0 : tok.content.length;
      const end = col + len;
      if (len > 0) {
        if (isInert(tok.types)) iSpans.push([col, end]);
        if (isSkip(tok.types)) sSpans.push([col, end]);
      }
      col = end;
    }
    inert.push(iSpans);
    skip.push(sSpans);
  }
  return { inert, skip };
}

// ---- 作用域（缩进启发式） ----

const SCOPE_KEYWORD =
  /^\s*(?:(?:export|default|public|private|protected|static|async|abstract|final|override|pub|unsafe|virtual|inline)\s+)*(?:def|function\*?|class|fn|func|fun|struct|interface|impl|trait|namespace|module)\s+(?:\([^)]*\)\s*)?([\p{L}_$][\p{L}\p{N}_$]*)/u;
const SCOPE_EXPR =
  /^\s*(?:export\s+)?(?:const|let|var)\s+([\p{L}_$][\p{L}\p{N}_$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[\p{L}_$][\p{L}\p{N}_$]*\s*=>)/u;
const SCOPE_METHOD =
  /^\s*(?:[\w<>\[\],.*&:\s]+\s+)?([\p{L}_$][\p{L}\p{N}_$]*)\s*\([^;]*\)\s*[^;{]*\{\s*$/u;
const SCOPE_METHOD_BAN = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "else",
  "return",
  "function",
  "do",
  "try",
  "with",
]);

function scopeName(line: string): string | undefined {
  let m = line.match(SCOPE_KEYWORD);
  if (m) return m[1];
  m = line.match(SCOPE_EXPR);
  if (m) return m[1];
  m = line.match(SCOPE_METHOD);
  if (m && !SCOPE_METHOD_BAN.has(m[1])) return m[1];
  return undefined;
}

function indentOf(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n += 1;
    else if (ch === "\t") n += 4;
    else break;
  }
  return n;
}

/** 向上找包住第 lineIdx 行（0-based）的函数/类名；找不到返回 undefined。 */
export function enclosingScope(lines: string[], lineIdx: number): string | undefined {
  let limit = indentOf(lines[lineIdx] ?? "");
  for (let i = lineIdx - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.trim()) continue;
    const ind = indentOf(line);
    if (ind < limit) {
      const name = scopeName(line);
      if (name) return name;
      limit = ind;
    }
  }
  return undefined;
}

// ---- 单处出现的类型判定 ----

const CONTROL = new Set([
  "return",
  "new",
  "else",
  "await",
  "yield",
  "throw",
  "case",
  "delete",
  "typeof",
  "instanceof",
  "in",
  "of",
  "is",
  "not",
  "and",
  "or",
  "if",
  "elif",
  "while",
  "for",
  "until",
  "unless",
  "do",
  "go",
  "defer",
  "print",
  "default",
  "void",
  "assert",
  "raise",
  "with",
  "del",
  "except",
  "lambda",
  "echo",
  "puts",
  "then",
  "when",
  "match",
  "switch",
  "catch",
  "from",
  "as",
  "extends",
]);

const RE_IMPORT_LINE = /^\s*(import|from|use|using|#\s*include|extern\s+crate)\b/;
const RE_REQUIRE = /\brequire\s*\(/;
const RE_DEF_BEFORE =
  /\b(def|function\*?|class|fn|func|fun|struct|interface|type|enum|trait|namespace|module|const|let|var|val)\s+$/;
const RE_GO_RECV = /\bfunc\s*\([^)]*\)\s*$/;
const RE_TYPED_AFTER = /^\s*\(/;
const RE_TYPED_BEFORE = /[\p{L}\p{N}_$]\s+$/u;
const RE_BARE_METHOD_AFTER = /^\s*\([^)]*\)\s*(:\s*[^{]+)?\{\s*$/;
const RE_ASSIGN =
  /^\s*(:\s*[^=,)]+?)?\s*(=|\+=|-=|\*=|\/=|%=|:=|\|\|=|&&=|\?\?=)(?![=>])/;
const RE_CALL = /^!?\s*\(/;

function hasUnclosedParen(before: string): boolean {
  let depth = 0;
  for (const ch of before) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
  }
  return depth > 0;
}

function classifyAt(
  line: string,
  start: number,
  end: number,
  inertSpans?: Span[]
): RefKind {
  if (inertSpans?.some(([s, e]) => start >= s && start < e)) return "text";
  const before = line.slice(0, start);
  const after = line.slice(end);
  if (RE_IMPORT_LINE.test(line) || RE_REQUIRE.test(line)) return "import";
  if (RE_DEF_BEFORE.test(before) || RE_GO_RECV.test(before)) return "def";
  if (RE_TYPED_AFTER.test(after) && RE_TYPED_BEFORE.test(before)) {
    const lastWord = before.trimEnd().match(/[\p{L}\p{N}_$]+$/u)?.[0];
    if (lastWord && !CONTROL.has(lastWord)) return "def";
  }
  if (/^\s*$/.test(before) && RE_BARE_METHOD_AFTER.test(after)) return "def";
  if (RE_ASSIGN.test(after) && !hasUnclosedParen(before)) return "assign";
  if (RE_CALL.test(after)) return "call";
  return "ref";
}

/** 收集 name 在整份文件里的全部出现（行序），逐处分类。 */
export function findSymbolRefs(
  lines: string[],
  name: string,
  inert?: Span[][]
): SymbolRef[] {
  const out: SymbolRef[] = [];
  lines.forEach((line, i) => {
    for (const m of line.matchAll(IDENT)) {
      if (m[0] !== name) continue;
      out.push({
        line: i + 1,
        col: m.index!,
        kind: classifyAt(line, m.index!, m.index! + name.length, inert?.[i]),
        scope: enclosingScope(lines, i),
        text: line.trim().slice(0, 160),
      });
    }
  });
  return out;
}
