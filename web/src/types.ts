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

export interface ChatMsg {
  role: "user" | "assistant";
  content: string;
  selection?: { startLine: number; endLine: number };
  marks?: TextMark[];
}

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
  overviewMessages: ChatMsg[];
  createdAt: number;
  lastFilePath?: string;
}
