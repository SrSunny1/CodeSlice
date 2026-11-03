export interface Slice {
  id: string;
  startLine: number;
  endLine: number;
  title: string;
  role?: string;
}

export type SliceStatus = "unread" | "reading" | "done";

export interface ChatMsg {
  role: "user" | "assistant";
  content: string;
  selection?: { startLine: number; endLine: number };
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
