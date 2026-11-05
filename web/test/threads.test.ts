import { describe, it, expect } from "vitest";
import {
  countTree,
  expandPath,
  flattenQA,
  getMsg,
  getThread,
  indexTree,
  pathKey,
  removeThread,
  threadHistory,
  threadRoundMap,
  updateMsg,
  updateThread,
} from "../src/threads";
import type { ChatMsg, InlineThread } from "../src/types";

function thread(id: string, messages: ChatMsg[], extra?: Partial<InlineThread>): InlineThread {
  return {
    id,
    start: 10,
    end: 20,
    blockEnd: 30,
    quote: `q-${id}`,
    messages,
    ...extra,
  };
}

const U = (content: string): ChatMsg => ({ role: "user", content });
const A = (content: string, extra?: Partial<ChatMsg>): ChatMsg => ({
  role: "assistant",
  content,
  ...extra,
});

describe("updateMsg / updateThread", () => {
  it("不可变更新嵌套消息：原数组与兄弟引用不变", () => {
    const inner: ChatMsg[] = [U("iq"), A("ia")];
    const msgs: ChatMsg[] = [U("q"), A("a", { threads: [thread("t1", inner)] }), U("q2")];
    const out = updateMsg(msgs, [1, "t1", 0], (m) => ({ ...m, content: "iq2" }));
    expect(out).not.toBe(msgs);
    expect(msgs[1].threads![0].messages[0].content).toBe("iq");
    expect(out[0]).toBe(msgs[0]);
    expect(out[2]).toBe(msgs[2]);
    expect(out[1].threads![0].messages[0].content).toBe("iq2");
    expect(out[1].threads![0].messages[1]).toBe(inner[1]);
  });

  it("updateThread 修改嵌套线程字段，路径无效返回原数组", () => {
    const msgs: ChatMsg[] = [A("a", { threads: [thread("t1", [U("q")], { collapsed: true })] })];
    const out = updateThread(msgs, [0, "t1"], (t) => ({ ...t, collapsed: false }));
    expect(out[0].threads![0].collapsed).toBe(false);
    expect(updateThread(msgs, [0, "nope"], (t) => t)).toBe(msgs);
    expect(updateMsg(msgs, [9], (m) => m)).toBe(msgs);
  });
});

describe("getMsg / getThread", () => {
  it("按路径取嵌套消息与线程", () => {
    const msgs: ChatMsg[] = [
      A("a", { threads: [thread("t1", [U("q"), A("ia", { threads: [thread("t2", [U("qq")])] })])] }),
    ];
    expect(getMsg(msgs, [0, "t1", 1, "t2", 0])?.content).toBe("qq");
    expect(getThread(msgs, [0, "t1", 1, "t2"])?.id).toBe("t2");
    expect(getThread(msgs, [0, "t1", 5, "t2"])).toBeUndefined();
  });
});

describe("threadHistory", () => {
  it("顶层线程：含锚定消息为止的主历史 + 带引用前缀的线程消息", () => {
    const msgs: ChatMsg[] = [
      U("u0"),
      A("a1", { threads: [thread("t1", [U("tq"), A("ta"), U("tq2")])] }),
      U("u2"),
      A("a3"),
    ];
    const h = threadHistory(msgs, [1, "t1"]);
    expect(h.map((x) => x.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
    expect(h[0].content).toBe("u0");
    expect(h[1].content).toBe("a1");
    expect(h[2].content).toBe("针对你上面回答中的这段内容：\n> q-t1\n\n我的问题：tq");
    expect(h[3].content).toBe("ta");
    expect(h[4].content).toBe("tq2");
    // u2/a3 在锚定消息之后，不进历史
    expect(h.some((x) => x.content === "u2" || x.content === "a3")).toBe(false);
    // 存储内容不被改写
    expect(msgs[1].threads![0].messages[0].content).toBe("tq");
  });

  it("嵌套线程：每层第一条用户消息都加引用前缀，父线程 j 之后的消息不进历史", () => {
    const msgs: ChatMsg[] = [
      A("a0", {
        threads: [
          thread("t1", [
            U("tq0"),
            A("ta1", { threads: [thread("t2", [U("tq2"), A("ta2")])] }),
            U("after-j"),
            A("after-j-a"),
          ]),
        ],
      }),
      U("later"),
    ];
    const h = threadHistory(msgs, [0, "t1", 1, "t2"]);
    expect(h.map((x) => x.role)).toEqual([
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(h[0].content).toBe("a0");
    expect(h[1].content).toBe("针对你上面回答中的这段内容：\n> q-t1\n\n我的问题：tq0");
    expect(h[2].content).toBe("ta1");
    expect(h[3].content).toBe("针对你上面回答中的这段内容：\n> q-t2\n\n我的问题：tq2");
    expect(h[4].content).toBe("ta2");
    expect(h.some((x) => x.content.includes("after-j") || x.content === "later")).toBe(false);
  });
});

describe("expandPath", () => {
  it("只展开路径上的线程", () => {
    const msgs: ChatMsg[] = [
      A("a", {
        threads: [
          thread("t1", [U("q"), A("ia", { threads: [thread("t2", [U("qq")], { collapsed: true })] })], {
            collapsed: true,
          }),
          thread("t3", [U("other")], { collapsed: true }),
        ],
      }),
    ];
    const out = expandPath(msgs, [0, "t1", 1, "t2"]);
    expect(getThread(out, [0, "t1"])?.collapsed).toBe(false);
    expect(getThread(out, [0, "t1", 1, "t2"])?.collapsed).toBe(false);
    expect(getThread(out, [0, "t3"])?.collapsed).toBe(true);
    expect(getThread(msgs, [0, "t1"])?.collapsed).toBe(true);
  });
});

describe("countTree", () => {
  it("统计所有层级的提问与标注", () => {
    const msgs: ChatMsg[] = [
      U("q0"),
      A("a1", {
        marks: [{ start: 0, end: 2, color: "y" }],
        threads: [
          thread("t1", [
            U("tq"),
            A("ta", {
              marks: [{ start: 0, end: 1, color: "b" }],
              threads: [thread("t2", [U("tq2"), A("ta2")])],
            }),
          ]),
        ],
      }),
    ];
    expect(countTree(msgs)).toEqual({ questions: 3, marks: 2 });
  });
});

describe("indexTree", () => {
  it("标注与追问按 start 交错，同偏移标注在前", () => {
    const msgs: ChatMsg[] = [
      U("q0"),
      A("a1", {
        marks: [
          { start: 5, end: 6, color: "y" },
          { start: 10, end: 12, color: "g" },
        ],
        threads: [
          thread("t1", [U("tq")], { start: 10 }),
          thread("t2", [U("tq2")], { start: 1 }),
        ],
      }),
    ];
    const tree = indexTree(msgs);
    // 顺序：t2(s=1) → mark(5) → mark(10) → t1(s=10，同偏移标注在前)
    expect(tree.map((n) => n.kind)).toEqual(["q", "thread", "mark", "mark", "thread"]);
    const t1 = tree[4] as Extract<(typeof tree)[number], { kind: "thread" }>;
    expect(t1.path).toEqual([1, "t1"]);
    expect(t1.children[0]).toMatchObject({ kind: "q", path: [1, "t1", 0] });
  });
});

describe("removeThread", () => {
  it("删除嵌套线程，兄弟线程保留", () => {
    const msgs: ChatMsg[] = [
      A("a", { threads: [thread("t1", [U("q")]), thread("t2", [U("q2")])] }),
    ];
    const out = removeThread(msgs, [0, "t1"]);
    expect(out[0].threads).toHaveLength(1);
    expect(out[0].threads![0].id).toBe("t2");
    expect(msgs[0].threads).toHaveLength(2);
    expect(removeThread(msgs, [0, "nope"])).toBe(msgs);
  });
});

describe("flattenQA", () => {
  it("追问线程缩进附在所属回答之后", () => {
    const msgs: ChatMsg[] = [
      U("q0"),
      A("a1", { threads: [thread("t1", [U("tq"), A("ta")], { quote: "some quoted text" })] }),
      U("q2"),
      A("a3"),
    ];
    const out = flattenQA(msgs);
    expect(out).toBe(
      [
        "问：q0",
        "答：a1",
        "  [追问「some quoted text」] 问：tq",
        "  答：ta",
        "问：q2",
        "答：a3",
      ].join("\n")
    );
  });
});

describe("threadRoundMap", () => {
  it("顶层追问块各自从第 1 轮起，嵌套块在所属块内续号", () => {
    const t1 = thread("t1", [
      U("q1"),
      A("a1", { threads: [thread("t3", [U("x"), A("y")])] }),
    ]);
    const msgs: ChatMsg[] = [
      U("q"),
      A("a", { threads: [t1, thread("t2", [U("q2"), A("a2")])] }),
    ];
    const map = threadRoundMap(msgs);
    expect(map.get(pathKey([1, "t1"]))).toBe(1);
    // t3 嵌套在 t1 的回答里 → t1 块内第 2 轮
    expect(map.get(pathKey([1, "t1", 1, "t3"]))).toBe(2);
    // t2 是回答的另一个地方 → 重新从第 1 轮
    expect(map.get(pathKey([1, "t2"]))).toBe(1);
  });

  it("块内多个嵌套追问按锚点位置续号", () => {
    const t1 = thread("t1", [
      U("q"),
      A("a1", {
        threads: [
          thread("ta", [U("x"), A("y")], { start: 20 }),
          thread("tb", [U("x"), A("y")], { start: 5 }),
        ],
      }),
    ]);
    const msgs: ChatMsg[] = [U("q"), A("a", { threads: [t1] })];
    const map = threadRoundMap(msgs);
    expect(map.get(pathKey([1, "t1"]))).toBe(1);
    // tb(start5) 锚点靠前 → 第 2 轮；ta(start20) → 第 3 轮
    expect(map.get(pathKey([1, "t1", 1, "tb"]))).toBe(2);
    expect(map.get(pathKey([1, "t1", 1, "ta"]))).toBe(3);
  });
});
