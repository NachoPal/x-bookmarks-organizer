"use strict";

/**
 * Pure, DOM-free half of the "Ask Claude" chat drawer (`chat.js` owns the
 * markup): reading the reply's event stream, the words the drawer shows, and
 * the guarded persistence of the model/effort pick and the open conversation.
 * Same style as assistant-lists.js / sort-order.js.
 *
 * Nothing here builds markup from a reply or a conversation title - those are
 * model output and the owner's own words, which chat.js sets as `textContent`
 * or (a reply's Markdown only) through the sanitizing `renderSummaryMarkdown`.
 */
(function (root) {
  const MODEL_KEY = "xbo:chat-model";
  const EFFORT_KEY = "xbo:chat-effort";
  const CONVERSATION_KEY = "xbo:chat-conversation";

  /** What the empty state offers to ask, one click each. */
  const EXAMPLES = [
    "What have I saved about AI agents lately?",
    "Find my unread posts about TypeScript and show them in the app.",
    "Which of my categories have the most unread posts?",
    "Summarize what @karpathy posts I bookmarked are about.",
  ];

  /**
   * Split a server-sent-events buffer into the complete events it holds and
   * the unfinished tail to keep for the next chunk. Only `data:` lines carry
   * anything; a frame that is not JSON is skipped rather than ending the reply.
   */
  function parseEventStream(buffer) {
    const frames = buffer.split("\n\n");
    const rest = frames.pop();
    const events = [];
    for (const frame of frames) {
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data) continue;
      try {
        events.push(JSON.parse(data));
      } catch (_) {
        // A malformed frame is dropped; the reply goes on.
      }
    }
    return { events, rest: rest === undefined ? "" : rest };
  }

  /** What kind of icon a tool chip wears: a search, a read, or the one write. */
  function chipKind(tool) {
    if (tool === "show_in_app") return "show";
    if (tool === "search_bookmarks") return "search";
    return "read";
  }

  /** A chip's full accessible text: its label, and that it failed when it did. */
  function chipText(activity) {
    return activity.status === "failed" ? `${activity.label} (failed)` : activity.label;
  }

  function effortLabel(effort) {
    if (effort === "xhigh") return "Extra high";
    return effort ? effort.charAt(0).toUpperCase() + effort.slice(1) : "";
  }

  /** The send button may act: text to send, no reply already running, and Claude Code able to run. */
  function canSend(state) {
    return !!state && !state.busy && state.available !== false && typeof state.text === "string" && state.text.trim() !== "";
  }

  /** Whether the log is scrolled to (near) its end, so a streaming reply should keep it there. */
  function isNearBottom(scrollTop, scrollHeight, clientHeight) {
    return scrollHeight - (scrollTop + clientHeight) < 48;
  }

  /** A stored pick, if it is still one of the choices; else the fallback. */
  function pick(stored, choices, fallback) {
    return choices.includes(stored) ? stored : fallback;
  }

  function read(storage, key) {
    try {
      return storage ? storage.getItem(key) : null;
    } catch (_) {
      return null;
    }
  }

  function write(storage, key, value) {
    try {
      if (!storage) return;
      if (value === null || value === undefined) storage.removeItem(key);
      else storage.setItem(key, String(value));
    } catch (_) {
      // Private mode / blocked storage: the pick just is not remembered.
    }
  }

  function readModel(storage, modelIds, fallback) {
    return pick(read(storage, MODEL_KEY), modelIds, fallback);
  }

  function readEffort(storage, efforts, fallback) {
    return pick(read(storage, EFFORT_KEY), efforts, fallback);
  }

  function writeModel(storage, id) {
    write(storage, MODEL_KEY, id);
  }

  function writeEffort(storage, effort) {
    write(storage, EFFORT_KEY, effort);
  }

  function readConversation(storage) {
    const id = Number.parseInt(read(storage, CONVERSATION_KEY) || "", 10);
    return Number.isInteger(id) && id > 0 ? id : null;
  }

  function writeConversation(storage, id) {
    write(storage, CONVERSATION_KEY, Number.isInteger(id) ? id : null);
  }

  /** The words for a failed send that never got a stream (a 4xx/5xx answer). */
  function sendFailureText(status, serverMessage) {
    if (serverMessage) return serverMessage;
    if (status === 503) return "Claude is not available right now.";
    return "The message could not be sent. Try again.";
  }

  const api = {
    EXAMPLES,
    MODEL_KEY,
    EFFORT_KEY,
    CONVERSATION_KEY,
    parseEventStream,
    chipKind,
    chipText,
    effortLabel,
    canSend,
    isNearBottom,
    readModel,
    readEffort,
    writeModel,
    writeEffort,
    readConversation,
    writeConversation,
    sendFailureText,
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.XBOChatView = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
