import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TextDecoder, TextEncoder } from "node:util";
import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";

// Drives the REAL chat.js (with the vendored marked + DOMPurify behind
// renderSummaryMarkdown) against index.html in jsdom, with a stubbed fetch
// whose /api/chat/messages answers a scripted event stream. Pins: where the
// bot button sits, the empty state and pickers, a streamed reply with its
// tool chips, that model output is sanitized and the owner's words are text,
// Escape, a failed send keeping the message, and the unavailable state.

const dir = __dirname;
const read = (f: string) => readFileSync(join(dir, f), "utf8");

interface Opts {
  available?: boolean;
  reason?: string;
  /** The events /api/chat/messages streams, or a status to refuse with. */
  stream?: unknown[] | { status: number; error: string };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

async function boot(opts: Opts = {}) {
  const dom = new JSDOM(read("index.html").replace(/<script[^>]*><\/script>/g, ""), {
    runScripts: "outside-only",
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  const w = dom.window as any;
  w.TextDecoder = TextDecoder;
  w.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
  const calls: { url: string; method: string; body?: string }[] = [];
  w.fetch = async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body });
    const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (url === "/api/chat") {
      return json({
        available: opts.available ?? true,
        ...(opts.reason ? { reason: opts.reason } : {}),
        models: [
          { id: "claude-opus-5-5", label: "Opus 5.5", description: "" },
          { id: "claude-sonnet-5-5", label: "Sonnet 5.5", description: "" },
        ],
        efforts: ["low", "medium", "high", "xhigh", "max"],
        defaults: { model: "claude-sonnet-5-5", effort: "medium" },
      });
    }
    if (url === "/api/chat/conversations") return json({ conversations: [] });
    if (url === "/api/chat/messages") {
      const stream = opts.stream ?? [];
      if (!Array.isArray(stream)) return json({ error: stream.error }, stream.status);
      const chunks = stream.map((e) => new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`));
      return {
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read: async () => (chunks.length ? { done: false, value: chunks.shift() } : { done: true, value: undefined }),
          }),
        },
      };
    }
    return json({});
  };
  for (const f of ["vendor/marked.min.js", "vendor/dompurify.min.js", "render-markdown.js", "assistant-lists.js", "chat-view.js", "chat.js"]) {
    w.eval(read(f));
  }
  const doc = w.document as Document;
  const $ = <T extends Element = HTMLElement>(sel: string) => doc.querySelector(sel) as unknown as T;
  return { w, doc, $, calls };
}

async function openDrawer(ctx: Awaited<ReturnType<typeof boot>>) {
  ctx.$<HTMLButtonElement>("#chat-toggle").click();
  for (let i = 0; i < 5; i++) await flush();
}

async function type(ctx: Awaited<ReturnType<typeof boot>>, text: string) {
  const input = ctx.$<HTMLTextAreaElement>("#chat-input");
  input.value = text;
  input.dispatchEvent(new ctx.w.Event("input"));
}

async function settle() {
  for (let i = 0; i < 20; i++) await flush();
  await new Promise((r) => setTimeout(r, 30));
}

const done = (userText: string, replyText: string, tools: unknown[] = []) => ({
  type: "done",
  conversation: { id: 4, title: userText, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
  messages: [
    { id: 1, role: "user", text: userText, model: null, effort: null, stopped: false, tools: [], createdAt: "" },
    { id: 2, role: "assistant", text: replyText, model: "claude-sonnet-5-5", effort: "medium", stopped: false, tools, createdAt: "" },
  ],
});

describe("Ask Claude drawer", () => {
  it("is a bot button immediately left of the Settings gear, named Ask Claude", async () => {
    const { $ } = await boot();
    const toggle = $("#chat-toggle");
    expect(toggle.getAttribute("aria-label")).toBe("Ask Claude");
    expect(toggle.getAttribute("title")).toBe("Ask Claude");
    expect(toggle.getAttribute("aria-controls")).toBe("chat-drawer");
    const next = toggle.nextElementSibling!;
    expect(next.querySelector("#settings-toggle")).not.toBeNull();
  });

  it("opens to the empty state with example questions, Sonnet 5.5 and medium effort picked", async () => {
    const ctx = await boot();
    await openDrawer(ctx);
    expect(ctx.$("#chat-drawer").hidden).toBe(false);
    expect(ctx.$("#chat-toggle").getAttribute("aria-expanded")).toBe("true");
    expect(ctx.doc.querySelectorAll(".chat-example").length).toBeGreaterThanOrEqual(3);
    expect(ctx.$<HTMLSelectElement>("#chat-model").value).toBe("claude-sonnet-5-5");
    expect(ctx.$<HTMLSelectElement>("#chat-effort").value).toBe("medium");
    expect(ctx.$<HTMLButtonElement>("#chat-send").disabled).toBe(true);
    await type(ctx, "hello");
    expect(ctx.$<HTMLButtonElement>("#chat-send").disabled).toBe(false);
  });

  it("streams a reply with its tool chips, sanitizes the Markdown and shows the owner's words as text", async () => {
    const reply = "See [this post](https://x.com/a/status/1) <script>window.pwned=1</script> [bad](javascript:alert(1))";
    const chip = { tool: "show_in_app", label: 'Showing 2 posts in the app as "Evals"', status: "done", listId: 9 };
    const ctx = await boot({
      stream: [
        { type: "step", step: "Searching bookmarks…" },
        { type: "tool", tool: { tool: "search_bookmarks", label: 'Searched bookmarks for "evals"', status: "done" } },
        { type: "tool", tool: chip },
        { type: "text", text: reply },
        done("<b>evals</b>?", reply, [chip]),
      ],
    });
    await openDrawer(ctx);
    await type(ctx, "<b>evals</b>?");
    ctx.$<HTMLButtonElement>("#chat-send").click();
    await settle();

    const sent = ctx.calls.find((c) => c.url === "/api/chat/messages")!;
    expect(JSON.parse(sent.body!)).toMatchObject({ text: "<b>evals</b>?", model: "claude-sonnet-5-5", effort: "medium", conversationId: null });
    expect(ctx.$(".chat-bubble").textContent).toBe("<b>evals</b>?");
    expect(ctx.$(".chat-bubble").querySelector("b")).toBeNull();
    const md = ctx.$(".chat-md");
    expect(md.querySelector("script")).toBeNull();
    expect(ctx.w.pwned).toBeUndefined();
    const links = Array.from(md.querySelectorAll("a"));
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["https://x.com/a/status/1", null]);
    expect(links[0]!.getAttribute("target")).toBe("_blank");
    expect(links[0]!.getAttribute("rel")).toBe("noopener noreferrer");
    expect(Array.from(ctx.doc.querySelectorAll(".chat-chip-label")).map((n) => n.textContent)).toEqual([
      'Showing 2 posts in the app as "Evals"',
    ]);
    expect(ctx.$("#chat-subtitle").textContent).toBe("<b>evals</b>?");
    expect(ctx.w.localStorage.getItem("xbo:chat-conversation")).toBe("4");

    let opened: unknown = null;
    ctx.doc.addEventListener("xbo:open-list", (e) => (opened = (e as CustomEvent).detail));
    ctx.$<HTMLButtonElement>(".chat-chip-open").click();
    expect(opened).toEqual({ id: 9 });
  });

  it("gives the message back when the send is refused, with the server's reason", async () => {
    const ctx = await boot({ stream: { status: 503, error: "The `claude` CLI was not found." } });
    await openDrawer(ctx);
    await type(ctx, "keep me");
    ctx.$<HTMLButtonElement>("#chat-send").click();
    await settle();
    expect(ctx.$<HTMLTextAreaElement>("#chat-input").value).toBe("keep me");
    expect(ctx.$("#chat-error").hidden).toBe(false);
    expect(ctx.$("#chat-error").textContent).toBe("The `claude` CLI was not found.");
  });

  it("gives the message back when the reply fails mid-stream", async () => {
    const ctx = await boot({ stream: [{ type: "error", error: { kind: "login", message: "Run claude, then /login." } }] });
    await openDrawer(ctx);
    await type(ctx, "hi");
    ctx.$<HTMLButtonElement>("#chat-send").click();
    await settle();
    expect(ctx.$<HTMLTextAreaElement>("#chat-input").value).toBe("hi");
    expect(ctx.$("#chat-error").textContent).toBe("Run claude, then /login.");
    expect(ctx.doc.querySelectorAll(".chat-msg").length).toBe(0);
  });

  it("explains why when Claude Code cannot run, and Send stays off", async () => {
    const ctx = await boot({ available: false, reason: "The `claude` CLI was not found." });
    await openDrawer(ctx);
    expect(ctx.$(".chat-notice").textContent).toContain("The `claude` CLI was not found.");
    expect(ctx.doc.querySelectorAll(".chat-example").length).toBe(0);
    await type(ctx, "hello");
    expect(ctx.$<HTMLButtonElement>("#chat-send").disabled).toBe(true);
  });

  it("Escape closes it, returns focus to the bot button, and goes no further", async () => {
    const ctx = await boot();
    await openDrawer(ctx);
    let reachedDocument = false;
    ctx.doc.addEventListener("keydown", () => (reachedDocument = true));
    ctx.$("#chat-input").dispatchEvent(new ctx.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(ctx.$("#chat-drawer").hidden).toBe(true);
    expect(ctx.doc.activeElement).toBe(ctx.$("#chat-toggle"));
    expect(reachedDocument).toBe(false);
  });

  it("Escape in the conversation list goes back to the conversation first", async () => {
    const ctx = await boot();
    await openDrawer(ctx);
    ctx.$<HTMLButtonElement>("#chat-history-toggle").click();
    await settle();
    expect(ctx.$("#chat-history").hidden).toBe(false);
    expect(ctx.$("#chat-history-state").textContent).toContain("No conversations yet");
    ctx.$("#chat-history").dispatchEvent(new ctx.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(ctx.$("#chat-history").hidden).toBe(true);
    expect(ctx.$("#chat-drawer").hidden).toBe(false);
  });
});
