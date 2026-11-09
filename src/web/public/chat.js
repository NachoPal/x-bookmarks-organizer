"use strict";

/**
 * The "Ask Claude" drawer: the top bar's bot button opens it, and it talks to
 * `/api/chat*` (`src/web/chat-routes.ts`). The pure half - the stream parser,
 * the words, the guarded persistence - is `chat-view.js` (`XBOChatView`).
 *
 * Model output reaches the page ONE way: a reply's Markdown through the
 * vendored marked + DOMPurify (`renderSummaryMarkdown`, the summary modal's
 * sanitizer). Everything else a reply or a conversation carries - the owner's
 * own messages, titles, tool chips - is `textContent`.
 *
 * A list `show_in_app` creates is announced by the server's assistant-list
 * stream like any MCP assistant's, so app.js's own "Your assistant sent…"
 * toast and Lists page handle it; a chip's "Open list" asks app.js to open it
 * through the `xbo:open-list` event.
 */
(function () {
  const view = window.XBOChatView;
  const toggle = document.getElementById("chat-toggle");
  const drawer = document.getElementById("chat-drawer");
  if (!view || !toggle || !drawer) return;

  const dot = document.getElementById("chat-dot");
  const historyToggle = document.getElementById("chat-history-toggle");
  const historyEl = document.getElementById("chat-history");
  const historyState = document.getElementById("chat-history-state");
  const conversationsEl = document.getElementById("chat-conversations");
  const mainEl = document.getElementById("chat-main");
  const logEl = document.getElementById("chat-log");
  const statusEl = document.getElementById("chat-status");
  const form = document.getElementById("chat-form");
  const errorEl = document.getElementById("chat-error");
  const input = document.getElementById("chat-input");
  const modelSelect = document.getElementById("chat-model");
  const effortSelect = document.getElementById("chat-effort");
  const sendBtn = document.getElementById("chat-send");
  const stopBtn = document.getElementById("chat-stop");
  const newBtn = document.getElementById("chat-new");
  const closeBtn = document.getElementById("chat-close");
  const subtitleEl = document.getElementById("chat-subtitle");

  const storage = (() => {
    try {
      return window.localStorage;
    } catch (_) {
      return null;
    }
  })();
  const narrow = window.matchMedia("(max-width: 640px)");

  const state = {
    /** `/api/chat`: availability, models, efforts, defaults - null until read. */
    info: null,
    infoError: null,
    conversationId: view.readConversation(storage),
    messages: [],
    loadedConversation: false,
    /** The reply being written: `{ userText, text, tools, step }`, or null. */
    pending: null,
    requestId: null,
    stopping: false,
    conversations: null,
    /** The conversation row asking "Delete?" in the history view. */
    confirmingDelete: null,
  };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function svgIcon(paths) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 20 20");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.setAttribute("class", "chat-chip-icon");
    const g = document.createElementNS(ns, "g");
    g.setAttribute("fill", "none");
    g.setAttribute("stroke", "currentColor");
    g.setAttribute("stroke-width", "2");
    g.setAttribute("stroke-linecap", "round");
    g.setAttribute("stroke-linejoin", "round");
    for (const d of paths) {
      const path = document.createElementNS(ns, "path");
      path.setAttribute("d", d);
      g.append(path);
    }
    svg.append(g);
    return svg;
  }

  const CHIP_ICONS = {
    search: ["M12.5 12.5L17 17", "M8.5 3a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11z"],
    read: ["M5 3h7l3 3v11H5z", "M8 10h5M8 13h5"],
    show: ["M4 5h12M4 10h12M4 15h6", "M13 13l3 2-3 2"],
    failed: ["M10 3l8 14H2z", "M10 8v4", "M10 14.5v.01"],
  };

  // ---- open / close ------------------------------------------------------

  function isOpen() {
    return !drawer.hidden;
  }

  function setOpen(open, opts) {
    const options = opts || {};
    drawer.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    document.body.toggleAttribute("data-chat-open", open);
    updateDot();
    if (open) {
      void loadInfo();
      if (!state.loadedConversation) void loadConversation(state.conversationId);
      showHistory(false);
      input.focus();
    } else if (options.returnFocus !== false) {
      toggle.focus();
    }
  }

  /** The toggle's dot: a reply still being written while the drawer is closed. */
  function updateDot() {
    const busy = !!state.pending;
    toggle.classList.toggle("is-busy", busy);
    if (dot) dot.hidden = !(busy && !isOpen());
    toggle.title = busy && !isOpen() ? "Ask Claude - Claude is still answering" : "Ask Claude";
  }

  toggle.addEventListener("click", () => setOpen(!isOpen()));
  closeBtn.addEventListener("click", () => setOpen(false));

  drawer.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    // The drawer owns Escape while focus is in it: the sidebar's own handler
    // (app.js) must not also collapse the categories drawer behind it.
    e.stopPropagation();
    e.preventDefault();
    if (!historyEl.hidden) {
      showHistory(false);
      historyToggle.focus();
      return;
    }
    setOpen(false);
  });

  // ---- what /api/chat says ------------------------------------------------

  async function loadInfo() {
    try {
      const res = await fetch("/api/chat");
      if (!res.ok) throw new Error(String(res.status));
      state.info = await res.json();
      state.infoError = null;
    } catch (_) {
      state.infoError = "Could not reach the app. Is the viewer still running?";
    }
    renderPickers();
    renderLog();
    updateComposer();
  }

  function renderPickers() {
    const info = state.info;
    if (!info) return;
    const modelIds = info.models.map((m) => m.id);
    const model = view.readModel(storage, modelIds, info.defaults.model);
    modelSelect.replaceChildren(
      ...info.models.map((m) => {
        const option = el("option", null, m.label);
        option.value = m.id;
        option.title = m.description;
        return option;
      }),
    );
    modelSelect.value = model;
    const effort = view.readEffort(storage, info.efforts, info.defaults.effort);
    effortSelect.replaceChildren(
      ...info.efforts.map((e) => {
        const option = el("option", null, view.effortLabel(e));
        option.value = e;
        return option;
      }),
    );
    effortSelect.value = effort;
  }

  modelSelect.addEventListener("change", () => view.writeModel(storage, modelSelect.value));
  effortSelect.addEventListener("change", () => view.writeEffort(storage, effortSelect.value));

  function modelLabel(id) {
    const model = state.info && state.info.models.find((m) => m.id === id);
    return model ? model.label : id;
  }

  // ---- a conversation ------------------------------------------------------

  async function loadConversation(id) {
    state.loadedConversation = true;
    if (!id) {
      state.conversationId = null;
      state.messages = [];
      renderLog();
      return;
    }
    renderLoading();
    try {
      const res = await fetch(`/api/chat/conversations/${id}`);
      if (res.status === 404) {
        startNewChat({ focus: false });
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json();
      state.conversationId = body.conversation.id;
      state.messages = body.messages;
      subtitleEl.textContent = body.conversation.title;
      renderLog({ scroll: "end" });
    } catch (_) {
      state.messages = [];
      renderLog();
      showError("This conversation could not be loaded. Try again, or start a new chat.");
    }
  }

  function startNewChat(opts) {
    if (state.pending) return;
    state.conversationId = null;
    state.messages = [];
    state.loadedConversation = true;
    view.writeConversation(storage, null);
    subtitleEl.textContent = "On your Claude subscription";
    hideError();
    showHistory(false);
    renderLog();
    if (!opts || opts.focus !== false) input.focus();
  }

  newBtn.addEventListener("click", () => startNewChat());

  // ---- the log -------------------------------------------------------------

  function renderLoading() {
    const loading = el("div", "chat-state chat-state-loading");
    loading.setAttribute("role", "status");
    const spinner = el("span", "list-spinner");
    spinner.setAttribute("aria-hidden", "true");
    loading.append(spinner, el("span", null, "Loading the conversation…"));
    logEl.replaceChildren(loading);
  }

  function renderEmpty() {
    const wrap = el("div", "chat-empty");
    const badge = el("span", "chat-empty-badge");
    badge.setAttribute("aria-hidden", "true");
    badge.append(toggle.querySelector("svg").cloneNode(true));
    wrap.append(
      badge,
      el("h3", "chat-empty-title", "Ask about your bookmarks"),
      el(
        "p",
        "chat-empty-body",
        "Claude searches your library with the same tools an AI assistant gets over MCP, and can open what it finds here as a list.",
      ),
    );
    if (unavailableReason()) {
      wrap.append(unavailableNotice());
      return wrap;
    }
    const examples = el("ul", "chat-examples");
    examples.setAttribute("aria-label", "Example questions");
    for (const example of view.EXAMPLES) {
      const li = el("li");
      const btn = el("button", "chat-example", example);
      btn.type = "button";
      btn.addEventListener("click", () => {
        input.value = example;
        autosize();
        void send();
      });
      li.append(btn);
      examples.append(li);
    }
    wrap.append(examples);
    return wrap;
  }

  function unavailableReason() {
    if (state.infoError) return state.infoError;
    return state.info && !state.info.available ? state.info.reason || "Claude is not available right now." : null;
  }

  function unavailableNotice() {
    const notice = el("div", "chat-notice");
    notice.setAttribute("role", "status");
    notice.append(svgIcon(CHIP_ICONS.failed), el("p", null, unavailableReason()));
    return notice;
  }

  function linkify(container) {
    for (const a of container.querySelectorAll("a[href]")) {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    }
  }

  function renderMarkdown(container, text) {
    container.innerHTML = window.renderSummaryMarkdown ? window.renderSummaryMarkdown(text) : "";
    if (!window.renderSummaryMarkdown) container.textContent = text;
    linkify(container);
  }

  function renderChips(tools) {
    const list = el("ul", "chat-chips");
    list.setAttribute("aria-label", "What Claude did");
    for (const activity of tools) {
      const kind = activity.status === "failed" ? "failed" : view.chipKind(activity.tool);
      const chip = el("li", "chat-chip");
      chip.dataset.kind = kind;
      chip.append(svgIcon(CHIP_ICONS[kind]), el("span", "chat-chip-label", view.chipText(activity)));
      if (activity.tool === "show_in_app" && Number.isInteger(activity.listId)) {
        const open = el("button", "chat-chip-open", "Open list");
        open.type = "button";
        open.addEventListener("click", () => {
          document.dispatchEvent(new CustomEvent("xbo:open-list", { detail: { id: activity.listId } }));
          if (narrow.matches) setOpen(false, { returnFocus: false });
        });
        chip.append(open);
      }
      list.append(chip);
    }
    return list;
  }

  function renderAssistant(message, opts) {
    const options = opts || {};
    const node = el("article", "chat-msg chat-msg-assistant");
    node.setAttribute("aria-label", "Claude");
    if (message.tools && message.tools.length) node.append(renderChips(message.tools));
    if (message.text) {
      const body = el("div", "chat-md");
      renderMarkdown(body, message.text);
      node.append(body);
    }
    if (options.working) {
      const working = el("div", "chat-working");
      const spinner = el("span", "list-spinner");
      spinner.setAttribute("aria-hidden", "true");
      working.append(spinner, el("span", null, options.working));
      node.append(working);
    } else {
      const meta = el("p", "chat-meta");
      if (message.stopped) meta.append(el("span", "chat-stopped", "Stopped"));
      if (message.model) {
        meta.append(
          el("span", null, `${modelLabel(message.model)}${message.effort ? ` · ${view.effortLabel(message.effort)}` : ""}`),
        );
      }
      if (meta.childNodes.length) node.append(meta);
    }
    return node;
  }

  function renderUser(text) {
    const node = el("article", "chat-msg chat-msg-user");
    node.setAttribute("aria-label", "You");
    node.append(el("p", "chat-bubble", text));
    return node;
  }

  /** Redraw the log. `scroll: "end"` jumps to the newest turn; otherwise it follows only if it was already there. */
  function renderLog(opts) {
    const options = opts || {};
    const follow = options.scroll === "end" || view.isNearBottom(logEl.scrollTop, logEl.scrollHeight, logEl.clientHeight);
    const nodes = [];
    if (state.messages.length === 0 && !state.pending) {
      nodes.push(renderEmpty());
    } else {
      if (unavailableReason()) nodes.push(unavailableNotice());
      for (const message of state.messages) {
        nodes.push(message.role === "user" ? renderUser(message.text) : renderAssistant(message));
      }
      if (state.pending) {
        nodes.push(renderUser(state.pending.userText));
        nodes.push(
          renderAssistant(
            { text: state.pending.text, tools: state.pending.tools },
            { working: state.stopping ? "Stopping…" : state.pending.step },
          ),
        );
      }
    }
    logEl.replaceChildren(...nodes);
    logEl.classList.toggle("is-empty", state.messages.length === 0 && !state.pending);
    if (follow) logEl.scrollTop = logEl.scrollHeight;
  }

  let frame = 0;
  function scheduleRender() {
    if (frame) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      renderLog();
    });
  }

  // ---- the composer ----------------------------------------------------------

  function autosize() {
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  }

  function updateComposer() {
    const busy = !!state.pending;
    sendBtn.disabled = !view.canSend({ text: input.value, busy, available: !unavailableReason() });
    sendBtn.hidden = busy;
    stopBtn.hidden = !busy;
    stopBtn.disabled = state.stopping;
    newBtn.disabled = busy;
    form.setAttribute("aria-busy", String(busy));
    updateDot();
  }

  function showError(message) {
    errorEl.textContent = message;
    errorEl.hidden = false;
  }

  function hideError() {
    errorEl.hidden = true;
    errorEl.textContent = "";
  }

  input.addEventListener("input", () => {
    autosize();
    updateComposer();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void send();
    }
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void send();
  });

  function newRequestId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
    return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  function announce(text) {
    statusEl.textContent = text;
  }

  async function send() {
    const text = input.value.trim();
    if (!view.canSend({ text, busy: !!state.pending, available: !unavailableReason() })) return;
    hideError();
    const requestId = newRequestId();
    state.pending = { userText: text, text: "", tools: [], step: "Thinking…" };
    state.requestId = requestId;
    state.stopping = false;
    input.value = "";
    autosize();
    updateComposer();
    renderLog({ scroll: "end" });
    announce("Claude is answering…");

    let saved = false;
    let failure = null;
    try {
      const res = await fetch("/api/chat/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text,
          model: modelSelect.value,
          effort: effortSelect.value,
          conversationId: state.conversationId,
          requestId,
        }),
      });
      if (!res.ok || !res.body) {
        let message = "";
        try {
          message = (await res.json()).error || "";
        } catch (_) {
          // Not JSON: the generic words below.
        }
        failure = view.sendFailureText(res.status, message);
        if (res.status === 503) void loadInfo();
      } else {
        const reader = res.body.getReader();
        const decoder = new window.TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parsed = view.parseEventStream(buffer);
          buffer = parsed.rest;
          for (const event of parsed.events) {
            const outcome = handleEvent(event);
            if (outcome === "saved") saved = true;
            else if (outcome) failure = outcome;
          }
        }
        if (!saved && !failure) failure = "The reply ended before it was saved. Try sending it again.";
      }
    } catch (_) {
      failure = "Lost the connection to the app while Claude was answering. Try again.";
    }

    const userText = state.pending ? state.pending.userText : text;
    state.pending = null;
    state.requestId = null;
    state.stopping = false;
    if (!saved) {
      // Nothing was saved: the message goes back where it was typed.
      if (!input.value) input.value = userText;
      autosize();
      if (failure && failure !== "stopped") showError(failure);
      announce(failure && failure !== "stopped" ? failure : "Stopped.");
    } else {
      announce("Claude replied.");
    }
    renderLog();
    updateComposer();
    if (isOpen() && document.activeElement === document.body) input.focus();
  }

  /** One event of the reply. Answers "saved", an error message, "stopped", or nothing. */
  function handleEvent(event) {
    const pending = state.pending;
    if (!pending || !event || typeof event !== "object") return null;
    if (event.type === "text" && typeof event.text === "string") {
      pending.text += event.text;
      scheduleRender();
    } else if (event.type === "step" && typeof event.step === "string") {
      pending.step = event.step;
      announce(event.step);
      scheduleRender();
    } else if (event.type === "tool" && event.tool) {
      pending.tools.push(event.tool);
      scheduleRender();
    } else if (event.type === "done" && event.conversation && Array.isArray(event.messages)) {
      state.conversationId = event.conversation.id;
      view.writeConversation(storage, event.conversation.id);
      subtitleEl.textContent = event.conversation.title;
      state.messages = state.messages.concat(event.messages);
      upsertConversation(event.conversation);
      return "saved";
    } else if (event.type === "error" && event.error) {
      return event.error.kind === "stopped" ? "stopped" : event.error.message || "The reply failed.";
    }
    return null;
  }

  stopBtn.addEventListener("click", async () => {
    if (!state.requestId || state.stopping) return;
    state.stopping = true;
    updateComposer();
    renderLog();
    try {
      await fetch(`/api/chat/replies/${encodeURIComponent(state.requestId)}/stop`, { method: "POST" });
    } catch (_) {
      // The reply's own stream reports how it ended either way.
    }
    input.focus();
  });

  // ---- saved conversations -----------------------------------------------

  function upsertConversation(conversation) {
    if (!state.conversations) return;
    state.conversations = [conversation].concat(state.conversations.filter((c) => c.id !== conversation.id));
  }

  function showHistory(show) {
    historyEl.hidden = !show;
    mainEl.hidden = show;
    historyToggle.setAttribute("aria-expanded", String(show));
    historyToggle.setAttribute("aria-label", show ? "Back to the conversation" : "Show conversations");
    state.confirmingDelete = null;
    if (show) {
      renderHistory();
      void loadConversations();
    }
  }

  historyToggle.addEventListener("click", () => {
    const show = historyEl.hidden;
    showHistory(show);
    if (show) {
      const first = conversationsEl.querySelector("button");
      (first || historyToggle).focus();
    } else {
      input.focus();
    }
  });

  async function loadConversations() {
    try {
      const res = await fetch("/api/chat/conversations");
      if (!res.ok) throw new Error(String(res.status));
      state.conversations = (await res.json()).conversations;
      renderHistory();
    } catch (_) {
      historyState.replaceChildren(el("p", "chat-state chat-state-error", "Could not load your conversations. Try again."));
    }
  }

  function renderHistory() {
    const conversations = state.conversations;
    if (!conversations) {
      const loading = el("div", "chat-state chat-state-loading");
      loading.setAttribute("role", "status");
      const spinner = el("span", "list-spinner");
      spinner.setAttribute("aria-hidden", "true");
      loading.append(spinner, el("span", null, "Loading conversations…"));
      historyState.replaceChildren(loading);
      conversationsEl.replaceChildren();
      return;
    }
    historyState.replaceChildren();
    if (conversations.length === 0) {
      historyState.append(el("p", "chat-state", "No conversations yet. Ask Claude something to start one."));
    }
    const now = Date.now();
    const lists = window.XBOAssistantLists;
    conversationsEl.replaceChildren(
      ...conversations.map((c) => {
        const li = el("li", "chat-conv");
        if (c.id === state.conversationId) li.classList.add("is-current");
        if (state.confirmingDelete === c.id) {
          li.classList.add("is-confirming");
          li.append(el("span", "chat-conv-confirm", `Delete “${c.title}”?`));
          const yes = el("button", "btn btn-ghost chat-conv-delete-yes", "Delete");
          yes.type = "button";
          yes.addEventListener("click", () => void deleteConversation(c.id));
          const no = el("button", "btn btn-ghost", "Cancel");
          no.type = "button";
          no.addEventListener("click", () => {
            state.confirmingDelete = null;
            renderHistory();
            const row = conversationsEl.querySelector(`[data-conversation="${c.id}"] .chat-conv-delete`);
            if (row) row.focus();
          });
          li.append(yes, no);
          return li;
        }
        li.dataset.conversation = String(c.id);
        const open = el("button", "chat-conv-open");
        open.type = "button";
        if (c.id === state.conversationId) open.setAttribute("aria-current", "true");
        open.append(
          el("span", "chat-conv-title", c.title),
          el("span", "chat-conv-when", lists ? lists.relativeTime(c.updatedAt, now) : ""),
        );
        open.addEventListener("click", () => {
          if (state.pending) return;
          hideError();
          showHistory(false);
          view.writeConversation(storage, c.id);
          void loadConversation(c.id);
          input.focus();
        });
        open.disabled = !!state.pending;
        const del = el("button", "icon-btn chat-conv-delete");
        del.type = "button";
        del.setAttribute("aria-label", `Delete conversation “${c.title}”`);
        del.title = "Delete";
        del.append(svgIcon(["M4 6h12", "M8 6V4h4v2", "M6 6l1 11h6l1-11"]));
        del.disabled = !!state.pending && c.id === state.conversationId;
        del.addEventListener("click", () => {
          state.confirmingDelete = c.id;
          renderHistory();
          const yes = conversationsEl.querySelector(".chat-conv-delete-yes");
          if (yes) yes.focus();
        });
        li.append(open, del);
        return li;
      }),
    );
  }

  async function deleteConversation(id) {
    try {
      const res = await fetch(`/api/chat/conversations/${id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) throw new Error(String(res.status));
    } catch (_) {
      historyState.replaceChildren(el("p", "chat-state chat-state-error", "That conversation could not be deleted. Try again."));
      return;
    }
    state.conversations = (state.conversations || []).filter((c) => c.id !== id);
    state.confirmingDelete = null;
    if (id === state.conversationId) startNewChat({ focus: false });
    showHistory(true);
    const first = conversationsEl.querySelector("button");
    (first || historyToggle).focus();
  }

  // A toast on a phone, over the full-screen drawer, must clear the composer
  // whatever it holds (a grown message, an error): the CSS reads its height.
  if (typeof window.ResizeObserver === "function") {
    new window.ResizeObserver(() => {
      if (form.offsetHeight > 0) {
        document.documentElement.style.setProperty("--chat-composer-height", `${form.offsetHeight}px`);
      }
    }).observe(form);
  }

  updateComposer();
})();
