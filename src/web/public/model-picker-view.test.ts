import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { buildSettingsCatalog } from "../../settings/catalog";

/**
 * Drives the REAL app.js + index.html in jsdom to pin the searchable model
 * picker: choosing the pi-ai provider for a pass loads the chosen source's
 * catalog from `GET /api/models`, typing filters it, the keyboard picks from
 * it, and Save persists `<source>/<model>` for THAT pass.
 *
 * The catalog is the server's REAL settings catalog (so the sources are the
 * ones pi-ai actually registers); `fetch` is a fixture, so nothing here can
 * reach a model API or spend anything.
 */

const dir = __dirname;
const read = (f: string) => readFileSync(join(dir, f), "utf8");

const model = (source: string, id: string, label: string, input = 1, output = 5) => ({
  id: `${source}/${id}`,
  label,
  suggestedFor: [],
  description: `PAID: $${input} in / $${output} out per 1M tokens, 200k context.`,
  contextWindow: 200_000,
  maxOutputTokens: 32_000,
  price: { input, output },
});

const MODELS: Record<string, unknown[]> = {
  anthropic: [
    model("anthropic", "claude-haiku-4-5", "Claude Haiku 4.5"),
    model("anthropic", "claude-opus-4-8", "Claude Opus 4.8", 5, 25),
  ],
  opencode: [
    model("opencode", "big-pickle", "Big Pickle", 0, 0),
    model("opencode", "claude-fable-5", "Claude Fable 5", 10, 50),
    model("opencode", "kimi-k2", "Kimi K2"),
    // Enough filler that the list is clearly a catalog, not a shortlist.
    ...Array.from({ length: 60 }, (_, i) => model("opencode", `filler-${i}`, `Filler ${i}`)),
  ],
};

interface Sent {
  method: string;
  url: string;
  body: any;
}

async function boot(
  opts: {
    failSources?: string[];
    providerKeys?: Record<string, { present: boolean; source?: string }>;
    providerAvailability?: Record<string, { available: boolean; reason?: string }>;
  } = {},
) {
  const sent: Sent[] = [];
  const failing = new Set(opts.failSources ?? []);
  const dom = new JSDOM(read("index.html").replace(/<script[^>]*><\/script>/g, ""), {
    runScripts: "outside-only",
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  const w = dom.window as any;
  w.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
  w.IntersectionObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  };
  w.HTMLElement.prototype.scrollIntoView = function () {};
  let settings: Record<string, unknown> = { categorizer: "claude-cli", taxonomyProvider: "claude-cli", assignmentProvider: "claude-cli" };
  w.fetch = async (url: string, init?: { method?: string; body?: string }) => {
    const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
    const method = (init && init.method) || "GET";
    sent.push({ method, url, body: init && init.body ? JSON.parse(init.body) : null });
    if (method === "PUT" && url === "/api/settings") {
      settings = JSON.parse(init!.body!);
      return json({ settings });
    }
    if (url.startsWith("/api/models")) {
      const source = new URL(url, "http://localhost").searchParams.get("source")!;
      if (failing.has(source)) return json({ error: "catalog unreadable" }, 500);
      return json({ provider: "pi-ai", source, models: MODELS[source] ?? [] });
    }
    if (url.startsWith("/api/tree")) return json({ tree: [] });
    if (url.startsWith("/api/setup")) {
      return json({
        bookmarkCount: 3,
        configured: true,
        settings,
        catalog: buildSettingsCatalog(),
        credentials: {
          xClientId: { present: true },
          xClientSecret: { present: true },
          typesafeApiKey: { present: false },
          providerKeys: {
            OPENCODE_API_KEY: { present: false },
            ANTHROPIC_API_KEY: { present: true, source: "env" },
            ...opts.providerKeys,
          },
          providerAvailability: { "claude-cli": { available: true }, ...opts.providerAvailability },
        },
        x: { connected: true, canConnect: true, login: { state: "idle", error: null } },
        sync: { available: true, lastSyncedAt: null, status: null },
        ranking: { scored: 0, total: 3, available: false, blocker: null, pending: 0, status: null },
      });
    }
    return json({});
  };

  for (const f of ["tree-counts.js", "filter-cache.js", "theme.js", "sort-order.js", "categorization.js", "ranking.js"]) {
    w.eval(read(f));
  }
  w.eval(read("app.js"));
  await tick();
  const doc = w.document as Document;
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => doc.getElementById(id) as T;

  function change(id: string, value: string) {
    const select = $<HTMLSelectElement>(id);
    select.value = value;
    select.dispatchEvent(new w.Event("change", { bubbles: true }));
  }
  function key(el: HTMLElement, k: string) {
    const event = new w.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    return event;
  }
  function type(el: HTMLInputElement, text: string) {
    el.value = text;
    el.dispatchEvent(new w.Event("input", { bubbles: true }));
  }
  const options = (pass: string) =>
    [...doc.querySelectorAll(`#settings-${pass}ModelSearch-list [role=option]`)].map((o) => o.textContent);

  return { w, doc, $, sent, change, key, type, options };
}

const tick = () => new Promise((r) => setTimeout(r, 120));

describe("the searchable model picker", () => {
  it("shows claude-cli's own dynamic Claude catalog by default, then swaps to pi-ai's own on switching provider", async () => {
    const { $, change, sent } = await boot();
    // claude-cli (the default provider) now has a catalog too, so the
    // searchable picker - not the old three-item dropdown - is what's on
    // screen from the start.
    expect($("settings-taxonomyModel").closest(".field")!.hasAttribute("hidden")).toBe(true);
    expect($("settings-taxonomySource").closest(".field")!.hasAttribute("hidden")).toBe(false);
    expect($<HTMLSelectElement>("settings-taxonomySource").value).toBe("anthropic");
    expect(sent.some((s) => s.url === "/api/models?provider=claude-cli&source=anthropic")).toBe(true);
    expect($<HTMLInputElement>("settings-taxonomyModelSearch").value).toMatch(/^Recommended: Claude Opus 4\.8/);

    change("settings-taxonomyProvider", "pi-ai");
    await tick();
    expect($("settings-taxonomyModel").closest(".field")!.hasAttribute("hidden")).toBe(true);
    // It opens on the source hosting pi-ai's own taxonomy suggestion.
    expect($<HTMLSelectElement>("settings-taxonomySource").value).toBe("anthropic");
    expect(sent.some((s) => s.url === "/api/models?provider=pi-ai&source=anthropic")).toBe(true);
    expect($<HTMLInputElement>("settings-taxonomyModelSearch").value).toMatch(/^Recommended: Claude Opus 4\.8/);

    // Every wired upstream is offered, OpenCode among the gateways.
    const groups = [...$("settings-taxonomySource").querySelectorAll("optgroup")].map((g) => g.label);
    expect(groups).toEqual(["Model makers", "Gateways - one key, many models", "Your own server"]);
    const gateways = [...$("settings-taxonomySource").querySelectorAll("optgroup")[1]!.querySelectorAll("option")];
    expect(gateways.map((o) => o.textContent)).toEqual(expect.arrayContaining(["OpenCode Zen", "OpenRouter"]));

    change("settings-taxonomySource", "opencode");
    await tick();
    expect($("settings-taxonomyModelSearch-status").textContent).toContain("63 OpenCode Zen models");
  });

  it("filters as the owner types, picks with the keyboard, and saves <source>/<model> for that pass", async () => {
    // OpenCode's key is present here so Save is not blocked by it - this
    // test is about the picker's typing/keyboard/save mechanics, not the
    // missing-key gate (covered separately below).
    const { $, change, key, type, options, sent } = await boot({
      providerKeys: { OPENCODE_API_KEY: { present: true, source: "env" } },
    });
    change("settings-taxonomyProvider", "pi-ai");
    change("settings-taxonomySource", "opencode");
    await tick();

    const input = $<HTMLInputElement>("settings-taxonomyModelSearch");
    input.focus();
    type(input, "fable");
    expect(options("taxonomy")).toHaveLength(1);
    expect(options("taxonomy")[0]).toContain("Claude Fable 5");
    expect(options("taxonomy")[0]).toContain("$10 in · $50 out");
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(input.getAttribute("aria-activedescendant")).toBe("settings-taxonomyModelSearch-opt-0");

    key(input, "Enter");
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(input.value).toBe("Claude Fable 5");

    // Pass 2 stays on its own provider and model.
    $("settings-save").click();
    await tick();
    const put = sent.filter((s) => s.method === "PUT").at(-1)!;
    expect(put.body).toMatchObject({
      taxonomyProvider: "pi-ai",
      taxonomyModel: "opencode/claude-fable-5",
      assignmentProvider: "claude-cli",
    });
    expect(put.body).not.toHaveProperty("assignmentModel");
    expect(put.body).not.toHaveProperty("taxonomySource");
  });

  it("says when nothing matches, and Escape closes the list without closing the panel", async () => {
    const { $, change, key, type } = await boot();
    change("settings-taxonomyProvider", "pi-ai");
    change("settings-taxonomySource", "opencode");
    await tick();
    const input = $<HTMLInputElement>("settings-taxonomyModelSearch");
    input.focus();
    type(input, "zzz-nothing");
    expect($("settings-taxonomyModelSearch-status").textContent).toBe('No OpenCode Zen model matches "zzz-nothing".');

    const escape = key(input, "Escape");
    expect(escape.defaultPrevented).toBe(true);
    expect(input.getAttribute("aria-expanded")).toBe("false");
    // The half-typed query is undone, back to the (empty) choice.
    expect(input.value).toBe("");
  });

  it("shows a source's missing key in words, and DISABLES Save while a source has no model picked", async () => {
    const { $, change, sent } = await boot();
    change("settings-taxonomyProvider", "pi-ai");
    change("settings-taxonomySource", "opencode");
    await tick();
    const hint = $("settings-taxonomySource-hint");
    expect(hint.dataset.key).toBe("missing");
    expect(hint.textContent).toContain("Needs OPENCODE_API_KEY - not found");
    expect(hint.textContent).toContain("PAID per token");

    const saveBtn = $<HTMLButtonElement>("settings-save");
    expect(saveBtn.disabled).toBe(true);
    expect($("settings-categorization-note").hidden).toBe(false);
    expect($("settings-categorization-note").textContent).toContain("Phase 1: choose a model from OpenCode Zen.");
    expect(saveBtn.getAttribute("aria-describedby")).toBe("settings-categorization-note");

    // A disabled button never dispatches click, so nothing is even attempted.
    saveBtn.click();
    await tick();
    expect(sent.some((s) => s.method === "PUT")).toBe(false);

    change("settings-taxonomySource", "anthropic");
    await tick();
    expect($("settings-taxonomySource-hint").dataset.key).toBe("present");
    expect($("settings-taxonomySource-hint").textContent).toContain("ANTHROPIC_API_KEY found (env)");
    // Recommended-on-its-own-source is a valid, saveable choice again.
    expect(saveBtn.disabled).toBe(false);
    expect(saveBtn.hasAttribute("aria-describedby")).toBe(false);
  });

  it("disables Save while a chosen model's key is missing, even once a real model is picked (reversed from #120)", async () => {
    const { $, change, key, type } = await boot();
    change("settings-taxonomyProvider", "pi-ai");
    change("settings-taxonomySource", "opencode");
    await tick();
    const input = $<HTMLInputElement>("settings-taxonomyModelSearch");
    input.focus();
    type(input, "kimi");
    key(input, "Enter");
    await tick();

    // A real model is chosen, but OPENCODE_API_KEY is still missing - the
    // owner's reversal of #120 means that alone keeps Save disabled, with
    // the same note explaining which key is needed.
    expect($("settings-taxonomySource-hint").dataset.key).toBe("missing");
    const saveBtn = $<HTMLButtonElement>("settings-save");
    expect(saveBtn.disabled).toBe(true);
    expect($("settings-categorization-note").textContent).toContain("Phase 1 runs on OpenCode Zen, which needs OPENCODE_API_KEY");
    expect(saveBtn.getAttribute("aria-describedby")).toBe("settings-categorization-note");

    // Once the key becomes available, the same selection is saveable.
    change("settings-taxonomySource", "anthropic");
    await tick();
    expect(saveBtn.disabled).toBe(false);
  });

  it("never blocks Save for claude-cli on a KEY - its source needs none - as long as its own check() is ok", async () => {
    const { $, change } = await boot();
    // claude-cli is the default for both passes; its Anthropic source needs
    // no key (it runs on the local CLI's own subscription). Picking an
    // effort also moves the selection off the saved baseline (issue #122),
    // so this proves Save is blocked by neither a missing key nor "no
    // changes to save".
    expect($<HTMLSelectElement>("settings-taxonomyProvider").value).toBe("claude-cli");
    expect($("settings-taxonomySource-hint").dataset.key).toBe("none");

    change("settings-effort", "high");
    await tick();
    expect($<HTMLButtonElement>("settings-save").disabled).toBe(false);

    change("settings-taxonomySource", "anthropic");
    await tick();
    expect($<HTMLButtonElement>("settings-save").disabled).toBe(false);
  });

  it("disables Save for claude-cli when its OWN check() reports unavailable (issue #35 generalization)", async () => {
    // claude-cli has no credential-chain key, so a missing key can never be
    // the signal here - it is the CLI's own availability probe instead.
    const { $, sent } = await boot({
      providerAvailability: { "claude-cli": { available: false, reason: "The `claude` CLI is not installed." } },
    });
    expect($<HTMLSelectElement>("settings-taxonomyProvider").value).toBe("claude-cli");
    const saveBtn = $<HTMLButtonElement>("settings-save");
    expect(saveBtn.disabled).toBe(true);
    expect($("settings-categorization-note").textContent).toContain(
      "Phase 1 runs on Claude Code subscription (local `claude` CLI), which is not available right now",
    );
    expect($("settings-categorization-note").textContent).toContain("The `claude` CLI is not installed.");

    saveBtn.click();
    await tick();
    expect(sent.some((s) => s.method === "PUT")).toBe(false);
  });

  it("shows the load error with a Retry, and never blocks choosing another source", async () => {
    const { $, change } = await boot({ failSources: ["groq"] });
    change("settings-taxonomyProvider", "pi-ai");
    change("settings-taxonomySource", "groq");
    await tick();
    expect($("settings-taxonomyModelSearch-status").textContent).toContain("Couldn't load the Groq model list: catalog unreadable");
    const retry = $("settings-taxonomyModelSearch").closest(".field")!.querySelector(".model-picker-retry") as HTMLElement;
    expect(retry.hidden).toBe(false);

    change("settings-taxonomySource", "opencode");
    await tick();
    expect(retry.hidden).toBe(true);
    expect($("settings-taxonomyModelSearch-status").textContent).toContain("OpenCode Zen models");
  });

  it("takes a typed model name for a local server", async () => {
    const { $, change, sent } = await boot();
    // The combined phase-2 selector ("settings-categorizer") is now the only
    // place the filing provider is chosen; picking a provider there sets the
    // (internal) assignment provider to it.
    change("settings-categorizer", "pi-ai");
    change("settings-assignmentSource", "local");
    await tick();
    const local = $<HTMLInputElement>("settings-assignmentLocalModel");
    expect(local.closest(".field")!.hasAttribute("hidden")).toBe(false);
    expect($("settings-assignmentModelSearch").closest(".field")!.hasAttribute("hidden")).toBe(true);
    local.value = "llama3.1:8b";
    local.dispatchEvent(new (local.ownerDocument.defaultView as any).Event("input", { bubbles: true }));
    $("settings-save").click();
    await tick();
    expect(sent.filter((s) => s.method === "PUT").at(-1)!.body).toMatchObject({
      assignmentProvider: "pi-ai",
      assignmentModel: "local/llama3.1:8b",
    });
  });
});
