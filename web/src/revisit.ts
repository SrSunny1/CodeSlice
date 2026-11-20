import type { ChatMsg, MsgPath, RevisitReminder, SessionSlice } from "./types";

export type RevisitEntry = {
  sliceId: string;
  path: MsgPath;
  reminder: RevisitReminder;
};

export function newRevisitId(): string {
  return `r-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 汇总所有段落里的待回看提醒：按段落顺序、每段消息树 DFS，只收 assistant 消息。 */
export function collectRevisitReminders(slices: SessionSlice[]): RevisitEntry[] {
  const out: RevisitEntry[] = [];
  for (const slice of slices) {
    const visit = (msgs: ChatMsg[], prefix: MsgPath) => {
      msgs.forEach((m, i) => {
        const path: MsgPath = [...prefix, i];
        if (m.role === "assistant") {
          for (const reminder of m.revisitReminders ?? []) {
            out.push({ sliceId: slice.id, path, reminder });
          }
        }
        for (const thread of m.threads ?? []) {
          visit(thread.messages, [...path, thread.id]);
        }
      });
    };
    visit(slice.messages, []);
  }
  return out;
}
