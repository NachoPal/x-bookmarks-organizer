import { describe, expect, it } from "vitest";

// Plain browser JS, required directly (not compiled by tsc).
const view = require("./chat-view.js");

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    data,
  };
}

const throwing = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
  removeItem: () => {
    throw new Error("blocked");
  },
};

describe("parseEventStream", () => {
  it("returns complete events and keeps the unfinished tail", () => {
    const { events, rest } = view.parseEventStream('data: {"type":"text","text":"Hi"}\n\ndata: {"type":"st');
    expect(events).toEqual([{ type: "text", text: "Hi" }]);
    expect(rest).toBe('data: {"type":"st');
    const next = view.parseEventStream(rest + 'ep","step":"Thinking…"}\n\n');
    expect(next.events).toEqual([{ type: "step", step: "Thinking…" }]);
    expect(next.rest).toBe("");
  });

  it("drops a malformed frame and ignores comment lines, without ending the stream", () => {
    const { events } = view.parseEventStream(': ping\n\ndata: not json\n\ndata: {"type":"text","text":"ok"}\n\n');
    expect(events).toEqual([{ type: "text", text: "ok" }]);
  });

  it("reads a multi-line data frame as one event", () => {
    const { events } = view.parseEventStream('data: {"type":"text",\ndata: "text":"x"}\n\n');
    expect(events).toEqual([{ type: "text", text: "x" }]);
  });
});

describe("chips", () => {
  it("gives the one write its own icon, and says when a call failed in words", () => {
    expect(view.chipKind("show_in_app")).toBe("show");
    expect(view.chipKind("search_bookmarks")).toBe("search");
    expect(view.chipKind("get_bookmark")).toBe("read");
    expect(view.chipText({ label: "Read a post", status: "failed" })).toBe("Read a post (failed)");
    expect(view.chipText({ label: "Read a post", status: "done" })).toBe("Read a post");
  });
});

describe("effortLabel", () => {
  it("spells out each level", () => {
    expect(view.effortLabel("medium")).toBe("Medium");
    expect(view.effortLabel("xhigh")).toBe("Extra high");
  });
});

describe("canSend", () => {
  it("needs text, no reply running, and Claude Code able to run", () => {
    expect(view.canSend({ text: "hi", busy: false, available: true })).toBe(true);
    expect(view.canSend({ text: "   ", busy: false, available: true })).toBe(false);
    expect(view.canSend({ text: "hi", busy: true, available: true })).toBe(false);
    expect(view.canSend({ text: "hi", busy: false, available: false })).toBe(false);
    expect(view.canSend(null)).toBe(false);
  });
});

describe("isNearBottom", () => {
  it("follows a streaming reply only while the log is at its end", () => {
    expect(view.isNearBottom(900, 1500, 600)).toBe(true);
    expect(view.isNearBottom(200, 1500, 600)).toBe(false);
  });
});

describe("persistence", () => {
  it("remembers the model and effort only while they are still choices", () => {
    const storage = memoryStorage();
    view.writeModel(storage, "claude-opus-5-5");
    view.writeEffort(storage, "high");
    expect(view.readModel(storage, ["claude-opus-5-5", "claude-sonnet-5-5"], "claude-sonnet-5-5")).toBe("claude-opus-5-5");
    expect(view.readModel(storage, ["claude-sonnet-5-5"], "claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
    expect(view.readEffort(storage, ["low", "medium", "high"], "medium")).toBe("high");
  });

  it("remembers the open conversation, and forgets it on a new chat", () => {
    const storage = memoryStorage();
    expect(view.readConversation(storage)).toBeNull();
    view.writeConversation(storage, 7);
    expect(view.readConversation(storage)).toBe(7);
    view.writeConversation(storage, null);
    expect(storage.data.has(view.CONVERSATION_KEY)).toBe(false);
    expect(view.readConversation(memoryStorage({ [view.CONVERSATION_KEY]: "nope" }))).toBeNull();
  });

  it("survives blocked or absent storage", () => {
    expect(view.readModel(throwing, ["a"], "a")).toBe("a");
    expect(() => view.writeModel(throwing, "a")).not.toThrow();
    expect(view.readConversation(null)).toBeNull();
    expect(() => view.writeConversation(null, 3)).not.toThrow();
  });
});

describe("sendFailureText", () => {
  it("prefers the server's own words", () => {
    expect(view.sendFailureText(503, "The `claude` CLI was not found.")).toBe("The `claude` CLI was not found.");
    expect(view.sendFailureText(503, "")).toBe("Claude is not available right now.");
    expect(view.sendFailureText(500, "")).toBe("The message could not be sent. Try again.");
  });
});

describe("examples", () => {
  it("offers a few questions to start from", () => {
    expect(view.EXAMPLES.length).toBeGreaterThanOrEqual(3);
  });
});
