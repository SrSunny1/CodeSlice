import type { Detail } from "./detail";

export interface Slice {
  id: string;
  startLine: number;
  endLine: number;
  title: string;
  role?: string;
}

export type SliceStatus = "unread" | "reading" | "done";

export type MarkColor = "y" | "g" | "b" | "p";

/** 回答正文里的高亮标注：start/end 是渲染后 textContent 的字符偏移量。 */
export interface TextMark {
  start: number;
  end: number;
  color: MarkColor;
  /** 文字标注内容（有备注的标注会带下划线） */
  note?: string;
}

/** 嵌在回答正文里的追问线程：锚定到父消息 textContent 的一段文字，插在所在块之后渲染。 */
export interface InlineThread {
  id: string;
  /** 锚定文字在父消息 textContent 里的起止偏移（与 TextMark 同一坐标系） */
  start: number;
  end: number;
  /** 所在块 hast position.end.offset；-1 或锚块未渲染时插在消息末尾 */
  blockEnd: number;
  /** 选中文字快照（折叠空白，最多 500 字） */
  quote: string;
  messages: ChatMsg[];
  collapsed?: boolean;
  /** 追问回答的详细程度，默认 brief */
  detail?: Detail;
}

export interface ChatMsg {
  role: "user" | "assistant";
  content: string;
  selection?: { startLine: number; endLine: number };
  marks?: TextMark[];
  threads?: InlineThread[];
}

/** [msgIdx, threadId, msgIdx, …]（奇数长度）：定位某条消息，可穿越任意层追问。 */
export type MsgPath = (number | string)[];
/** [msgIdx, threadId, …, msgIdx, threadId]（偶数长度）：定位某个追问线程。 */
export type ThreadPath = (number | string)[];

export interface SessionSlice extends Slice {
  status: SliceStatus;
  messages: ChatMsg[];
}

export interface Session {
  id: string;
  createdAt: number;
  title: string;
  code: string;
  language: string;
  slices: SessionSlice[];
  currentSliceId: string;
  codePurpose?: string;
  summary?: string;
  workspaceId?: string;
  filePath?: string;
}

export interface TreeNode {
  name: string;
  path: string;
  type: "dir" | "file";
  children?: TreeNode[];
}

export interface Workspace {
  id: string;
  root: string;
  name: string;
  tree: TreeNode[];
  truncated: boolean;
  overview?: string;
  overviewMarks?: TextMark[];
  overviewThreads?: InlineThread[];
  overviewMessages: ChatMsg[];
  createdAt: number;
  lastFilePath?: string;
}
