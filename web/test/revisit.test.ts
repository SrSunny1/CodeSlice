import { describe, it, expect } from "vitest";
import { collectRevisitReminders } from "../src/revisit";
import type { ChatMsg, InlineThread, RevisitReminder, SessionSlice } from "../src/types";

function reminder(id: string, extra?: Partial<RevisitReminder>): RevisitReminder {
  return { id, start: 5, end: 12, excerpt: `ex-${id}`, ...extra };
}

function thread(id: string, messages: ChatMsg[]): InlineThread {
  return { id, start: 0, end: 4, blockEnd: -1, quote: `q-${id}`, messages };
}

function slice(id: string, messages: ChatMsg[]): SessionSlice {
  return {
    id,
    startLine: 1,
    endLine: 10,
    title: `slice-${id}`,
    status: "reading",
    messages,
  };
}

describe("collectRevisitReminders", () => {
  it("收集顶层与嵌套追问里的 assistant 提醒，保留段落/文档顺序", () => {
    const slices = [
      slice("s1", [
        { role: "assistant", content: "a1", revisitReminders: [reminder("r1")] },
        {
          role: "assistant",
          content: "a2",
          threads: [
            thread("t1", [
              { role: "user", content: "u" },
              {
                role: "assistant",
                content: "a3",
                revisitReminders: [reminder("r2", { targetSliceId: "s2" })],
              },
            ]),
          ],
        },
      ]),
      slice("s2", [
        { role: "assistant", content: "b1", revisitReminders: [reminder("r3")] },
      ]),
    ];
    const entries = collectRevisitReminders(slices);
    expect(entries.map((e) => e.reminder.id)).toEqual(["r1", "r2", "r3"]);
    const nested = entries[1];
    expect(nested.sliceId).toBe("s1");
    expect(nested.path).toEqual([1, "t1", 1]);
    expect(nested.reminder.targetSliceId).toBe("s2");
  });

  it("忽略 user 消息上的提醒，保留 target 已失效的提醒", () => {
    const slices = [
      slice("s1", [
        { role: "user", content: "u", revisitReminders: [reminder("rUser")] },
        {
          role: "assistant",
          content: "a",
          revisitReminders: [reminder("rGone", { targetSliceId: "no-such" })],
        },
      ]),
    ];
    const entries = collectRevisitReminders(slices);
    expect(entries.map((e) => e.reminder.id)).toEqual(["rGone"]);
    expect(entries[0].reminder.targetSliceId).toBe("no-such");
    expect(entries[0].path).toEqual([1]);
  });

  it("空 messages / 无提醒时返回空数组", () => {
    expect(collectRevisitReminders([])).toEqual([]);
    expect(
      collectRevisitReminders([slice("s1", [{ role: "assistant", content: "a" }])])
    ).toEqual([]);
  });
});
