import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";

/**
 * Drives the REAL app.js + index.html in jsdom to pin the ranking-rule
 * manage/select split: the "Edit ranking rules" dialog manages sets of rules
 * but no longer selects the active one; the ranking panel's own picker does;
 * and the score chip names the active set on hover. Offline end to end -
 * `fetch` is a fixture, so nothing here can reach `api.typesafe.ai` and
 * nothing can be billed.
 */

const dir = __dirname;
const read = (f: string) => readFileSync(join(dir, f), "utf8");

const dimension = (id: string, label: string) => ({
  id,
  label,
  instructions: `How ${label.toLowerCase()} is this?`,
  levels: ["Low.", "High."],
  weight: 1,
});

const SCORE = { value: 0.82, confidence: 0.7, dimensions: { learning_value: 0.8 } };

const BUILT_IN = {
  id: "default",
  name: "Learning value (built-in)",
  builtIn: true,
  dimensions: [dimension("learning_value", "Learning value")],
};
const CUSTOM = {
  id: "signal",
  name: "Signal only",
  builtIn: false,
  dimensions: [dimension("signal", "Signal"), dimension("depth", "Depth")],
};

interface Posted {
  method: string;
  url: string;
  body: any;
}

async function boot() {
  const posted: Posted[] = [];
  let rubric = {
    activeId: "default",
    presets: [
      { ...BUILT_IN, scored: 3 },
      { ...CUSTOM, scored: 0 },
    ],
    total: 3,
    limits: { maxDimensions: 12, minLevels: 2, maxLevels: 10 },
  };
  let ranking: any = {
    scored: 3,
    total: 3,
    available: true,
    blocker: null,
    pending: 0,
    status: null,
    preset: { id: "default", name: "Learning value (built-in)", builtIn: true, version: "v1" },
  };

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

  w.fetch = async (url: string, init?: { method?: string; body?: string }) => {
    const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
    const method = (init && init.method) || "GET";
    const body = init && init.body ? JSON.parse(init.body) : null;
    if (method !== "GET") posted.push({ method, url, body });

    if (method === "PUT" && url === "/api/rubric/active") {
      const preset = rubric.presets.find((p) => p.id === body.id);
      if (!preset) return json({ error: "Those ranking rules no longer exist." }, 404);
      rubric = { ...rubric, activeId: preset.id };
      // Under the custom set nothing has been scored yet - the realistic
      // "switching costs nothing, but a re-rank is now offered" case.
      ranking = {
        ...ranking,
        scored: preset.id === "default" ? 3 : 0,
        pending: preset.id === "default" ? 0 : 3,
        preset: { id: preset.id, name: preset.name, builtIn: !!preset.builtIn, version: preset.id === "default" ? "v1" : "v2" },
      };
      return json({ rubric, ranking });
    }
    if (method === "POST" && url === "/api/rubric/presets") {
      const created = { id: "new-" + rubric.presets.length, name: body.name, builtIn: false, dimensions: body.dimensions, scored: 0 };
      rubric = { ...rubric, presets: [...rubric.presets, created] };
      return json({ rubric, ranking }, 201);
    }
    if (url === "/api/rubric") return json(rubric);
    if (url.startsWith("/api/tree")) {
      return json({
        tree: [
          { id: 1, parentId: null, name: "Cat", path: ["Cat"], total: 1, unread: 1, directTotal: 1, children: [] },
        ],
      });
    }
    if (url.startsWith("/api/setup")) {
      return json({
        bookmarkCount: 3,
        configured: true,
        settings: { categorizer: "claude-cli", provider: "claude-cli" },
        catalog: { methods: [], providers: [] },
        credentials: {
          xClientId: { present: true },
          xClientSecret: { present: true },
          typesafeApiKey: { present: true },
        },
        x: { connected: true, canConnect: true, login: { state: "idle", error: null } },
        sync: { available: true, lastSyncedAt: null, status: null },
        ranking,
      });
    }
    const m = url.match(/^\/api\/categories\/1\/bookmarks/);
    if (m) {
      return json({
        bookmarks: [
          {
            id: 1,
            postId: "p1",
            text: "post 1",
            read: false,
            readAt: null,
            favorite: false,
            categoryIds: [1],
            url: "https://x.com/i/status/1",
            authorName: "a",
            authorUsername: "a",
            createdAt: "2024-01-01T00:00:00Z",
            hasSummary: false,
            score: SCORE,
          },
        ],
        offset: 0,
        hasMore: false,
        counts: { total: 1, unread: 1, favorite: 0 },
      });
    }
    return json({});
  };

  for (const f of [
    "tree-counts.js",
    "read-toggle.js",
    "filter-cache.js",
    "theme.js",
    "embed-theme.js",
    "post-scale.js",
    "sidebar-state.js",
    "tree-color.js",
    "sort-order.js",
    "categorization.js",
    "ranking.js",
    "rubric-editor.js",
  ]) {
    w.eval(read(f));
  }
  w.eval(read("app.js"));
  await tick();
  const doc = w.document as Document;
  (doc.querySelector(".tree-node") as HTMLElement).click();
  await tick();

  return {
    w,
    doc,
    posted,
    $: <T extends HTMLElement = HTMLElement>(id: string) => doc.getElementById(id) as T,
    card: (id: number) => doc.querySelector(`.bookmark-card[data-bookmark-id="${id}"]`) as HTMLElement,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 120));

function type(el: HTMLInputElement | HTMLTextAreaElement, text: string) {
  el.value = text;
  el.dispatchEvent(new (el.ownerDocument.defaultView as any).Event("input", { bubbles: true }));
}

describe("the ranking panel's active-rules picker", () => {
  it("lists every saved set, badges the active one, and is a combobox, not a native <select>", async () => {
    const { doc, $ } = await boot();
    $("rank-toggle").click();
    await tick();
    expect($("rank-panel").hidden).toBe(false);

    const input = $<HTMLInputElement>("rank-rules-input");
    expect(input.tagName).toBe("INPUT");
    expect(input.getAttribute("role")).toBe("combobox");
    expect(input.value).toBe("Learning value (built-in)");

    input.click();
    await tick();
    const options = [...doc.querySelectorAll("#rank-rules-list [role=option]")];
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining("Learning value (built-in)"),
      expect.stringContaining("Signal only"),
    ]);
    expect(options[0]!.querySelector(".model-picker-badge")!.textContent).toBe("Active");
    expect(options[1]!.querySelector(".model-picker-badge")).toBeNull();
  });

  it("selecting a different set activates it and refreshes ranking state, spending nothing", async () => {
    const { doc, $, posted } = await boot();
    $("rank-toggle").click();
    await tick();
    const input = $<HTMLInputElement>("rank-rules-input");
    input.click();
    await tick();

    const signalOption = [...doc.querySelectorAll("#rank-rules-list [role=option]")].find((o) =>
      (o.textContent || "").includes("Signal only"),
    ) as HTMLElement;
    signalOption.click();
    await tick();

    expect(posted).toContainEqual({ method: "PUT", url: "/api/rubric/active", body: { id: "signal" } });
    // Selecting never spends - it never reaches a paid endpoint.
    expect(posted.some((p) => /\/rank\b/.test(p.url))).toBe(false);

    expect(input.value).toBe("Signal only");
    // Re-resolved for the newly active rule, the same as a finished run does.
    expect(($("rank-coverage") as HTMLElement).textContent).toBe("3 of 3 bookmarks unranked.");
    expect(($("rank-dot") as HTMLElement).hidden).toBe(false);
  });
});

describe("the ranking rules editor is manage-only", () => {
  it("has no active-selector - no radio, nothing clickable to switch rules", async () => {
    const { doc, $ } = await boot();
    $("rubric-open").click();
    await tick();
    expect($("rubric-modal").hidden).toBe(false);

    expect(doc.querySelectorAll("#rubric-list input[type=radio]").length).toBe(0);
    expect(doc.querySelectorAll("#rubric-list .rubric-radio").length).toBe(0);

    const items = [...doc.querySelectorAll("#rubric-list .rubric-item")];
    expect(items).toHaveLength(2);
    const activeItem = items.find((i) => (i as HTMLElement).dataset.presetId === "default")!;
    expect(activeItem.querySelector(".rubric-item-active-badge")!.textContent).toBe("Active");
    // The built-in set is clone-to-edit only.
    expect(activeItem.querySelector(".rubric-link:not(.is-danger)")!.textContent).toBe("Duplicate");

    const customItem = items.find((i) => (i as HTMLElement).dataset.presetId === "signal")!;
    expect([...customItem.querySelectorAll(".rubric-link")].map((b) => b.textContent)).toEqual([
      "Duplicate",
      "Edit",
      "Delete",
    ]);
  });

  it("still creates rules, and spends nothing doing it", async () => {
    const { doc, $, posted } = await boot();
    $("rubric-open").click();
    await tick();
    $("rubric-new").click();
    await tick();

    type($<HTMLInputElement>("rubric-name"), "Depth only");
    type(doc.getElementById("rubric-dim-0-name") as HTMLInputElement, "Depth");
    type(doc.getElementById("rubric-dim-0-question") as HTMLTextAreaElement, "How deep is this?");
    const levels = doc.querySelectorAll(".rubric-level-input");
    type(levels[0] as HTMLTextAreaElement, "Shallow.");
    type(levels[1] as HTMLTextAreaElement, "Deep.");

    $("rubric-save").click();
    await tick();

    const create = posted.find((p) => p.url === "/api/rubric/presets");
    expect(create).toBeTruthy();
    expect(create!.body.name).toBe("Depth only");
    // Authoring is free: never a paid call, in this flow or any other in this test.
    expect(posted.some((p) => /\/rank\b/.test(p.url))).toBe(false);
  });
});

describe("the score chip names the ranking rules it was scored under", () => {
  it("carries the active preset's name in its accessible label and hover detail", async () => {
    const { doc, card } = await boot();
    const chip = card(1).querySelector(".score-chip") as HTMLElement;
    expect(chip.getAttribute("aria-label")).toContain('ranked with "Learning value (built-in)"');

    chip.click();
    await tick();
    const detail = doc.getElementById("score-detail") as HTMLElement;
    expect(detail.hidden).toBe(false);
    expect(detail.textContent).toContain('Ranked with "Learning value (built-in)"');
  });
});
