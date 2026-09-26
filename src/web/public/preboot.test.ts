import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The pre-paint state block (issue #104) is INLINE in index.html on purpose:
// every state module is `defer`red, so a closed sidebar rendered open for a
// frame and a stored theme that disagreed with the system one flashed the
// wrong way. Being inline means it is the one place these storage keys and
// defaults are duplicated - so rather than eyeballing them, these tests pull
// the script out of the page and RUN it against the modules that own them.
// A key typo, a flipped default or a dropped guard fails here.
// Plain browser JS, required directly (not compiled by tsc).
const { readCollapsed, SIDEBAR_KEY } = require("./sidebar-state.js");
const { readStoredTheme, THEME_KEY } = require("./theme.js");
const { readColorEnabled, COLOR_PREF_KEY } = require("./tree-color.js");
const {
  readWidth,
  SIDEBAR_WIDTH_KEY,
  MIN_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
} = require("./sidebar-width.js");
const { readPage, PAGE_KEY, PAGES } = require("./sidebar-nav.js");
const { readSelection, SELECTION_KEY } = require("./view-persist.js");
const { readOpenList } = require("./assistant-lists.js");
const OPEN_LIST_KEY = "xbo:assistant-list";

/** The inline script's source, straight out of the shipped page. */
function prebootSource(): string {
  const html = readFileSync(join(__dirname, "index.html"), "utf8");
  const match = html.match(/<script id="xbo-preboot">([\s\S]*?)<\/script>/);
  if (!match) throw new Error("index.html no longer carries the #xbo-preboot inline script");
  return match[1];
}

/** What the script did to the document, as plain data. */
interface Applied {
  htmlAttrs: Record<string, string>;
  bodyAttrs: Record<string, string>;
  cssProps: Record<string, string>;
}

/**
 * Run the real inline script with `window`/`document` shadowed by stand-ins.
 * The script only ever touches those two identifiers, which is what makes it
 * executable outside a browser without jsdom.
 */
function runPreboot(stored: Record<string, string>, opts?: { throwing?: boolean }): Applied {
  const applied: Applied = { htmlAttrs: {}, bodyAttrs: {}, cssProps: {} };
  const windowStub = {
    localStorage: {
      getItem(key: string) {
        if (opts?.throwing) throw new Error("blocked");
        return key in stored ? stored[key] : null;
      },
    },
  };
  const documentStub = {
    documentElement: {
      setAttribute(name: string, value: string) {
        applied.htmlAttrs[name] = value;
      },
      style: {
        setProperty(name: string, value: string) {
          applied.cssProps[name] = value;
        },
      },
    },
    body: {
      setAttribute(name: string, value: string) {
        applied.bodyAttrs[name] = value;
      },
    },
  };
  new Function("window", "document", prebootSource())(windowStub, documentStub);
  return applied;
}

/** A Storage stand-in over the same backing record the script reads. */
function storageOver(stored: Record<string, string>): Storage {
  return {
    getItem: (key: string) => (key in stored ? stored[key] : null),
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

describe("pre-paint state application (issue #104)", () => {
  it("collapses the sidebar before the first paint when the module says it is closed", () => {
    const stored = { [SIDEBAR_KEY]: "1" };
    expect(readCollapsed(storageOver(stored))).toBe(true);
    expect(runPreboot(stored).bodyAttrs["data-sidebar"]).toBe("collapsed");
  });

  it("collapses it when nothing is stored, matching the module's closed default", () => {
    expect(readCollapsed(storageOver({}))).toBe(true);
    expect(runPreboot({}).bodyAttrs["data-sidebar"]).toBe("collapsed");
  });

  it("leaves an OPEN sidebar alone - the attribute's absence is what opens it", () => {
    const stored = { [SIDEBAR_KEY]: "0" };
    expect(readCollapsed(storageOver(stored))).toBe(false);
    expect(runPreboot(stored).bodyAttrs["data-sidebar"]).toBeUndefined();
  });

  it("collapses on a value neither module recognizes, exactly as the module does", () => {
    const stored = { [SIDEBAR_KEY]: "maybe" };
    expect(readCollapsed(storageOver(stored))).toBe(true);
    expect(runPreboot(stored).bodyAttrs["data-sidebar"]).toBe("collapsed");
  });

  it("suppresses motion for the first frame, so the saved state appears rather than animating", () => {
    // The regression this guards: #104 made the sidebar state land before the
    // paint, but the `.viewer` grid transition still played once on load, so
    // every refresh showed the drawer sliding into place. The attribute is
    // what `styles.css` keys that suppression off; `app.js` drops it after
    // the first frame.
    for (const stored of [{}, { [SIDEBAR_KEY]: "0" }]) {
      expect(runPreboot(stored).htmlAttrs["data-preboot"]).toBe("1");
    }
    // Even with storage blocked: the suppression must not depend on a read.
    expect(runPreboot({}, { throwing: true }).htmlAttrs["data-preboot"]).toBe("1");
  });

  it("applies a stored theme to <html> so it never paints the other one first", () => {
    for (const theme of ["light", "dark"]) {
      const stored = { [THEME_KEY]: theme };
      expect(readStoredTheme(storageOver(stored))).toBe(theme);
      expect(runPreboot(stored).htmlAttrs["data-theme"]).toBe(theme);
    }
  });

  it("leaves the system theme in charge when nothing (or nothing valid) is stored", () => {
    for (const stored of [{}, { [THEME_KEY]: "sepia" }]) {
      expect(readStoredTheme(storageOver(stored))).toBeNull();
      expect(runPreboot(stored).htmlAttrs["data-theme"]).toBeUndefined();
    }
  });

  it("turns the tree tint on up front only when the module would", () => {
    const on = { [COLOR_PREF_KEY]: "1" };
    expect(readColorEnabled(storageOver(on))).toBe(true);
    expect(runPreboot(on).bodyAttrs["data-tree-colors"]).toBe("on");

    for (const off of [{}, { [COLOR_PREF_KEY]: "0" }]) {
      expect(readColorEnabled(storageOver(off))).toBe(false);
      expect(runPreboot(off).bodyAttrs["data-tree-colors"]).toBeUndefined();
    }
  });

  it("applies the stored sidebar width, so a resized column never jumps", () => {
    const stored = { [SIDEBAR_WIDTH_KEY]: "340" };
    expect(readWidth(storageOver(stored))).toBe(340);
    expect(runPreboot(stored).cssProps["--sidebar-width"]).toBe("340px");
  });

  it("clamps a stored width to the module's own bounds", () => {
    const tooWide = { [SIDEBAR_WIDTH_KEY]: String(MAX_SIDEBAR_WIDTH + 500) };
    expect(runPreboot(tooWide).cssProps["--sidebar-width"]).toBe(`${MAX_SIDEBAR_WIDTH}px`);
    const tooNarrow = { [SIDEBAR_WIDTH_KEY]: String(MIN_SIDEBAR_WIDTH - 500) };
    expect(runPreboot(tooNarrow).cssProps["--sidebar-width"]).toBe(`${MIN_SIDEBAR_WIDTH}px`);
  });

  it("leaves the stylesheet's default width in place when none is stored or it is garbage", () => {
    for (const stored of [{}, { [SIDEBAR_WIDTH_KEY]: "wide" }]) {
      expect(readWidth(storageOver(stored))).toBeNull();
      expect(runPreboot(stored).cssProps["--sidebar-width"]).toBeUndefined();
    }
  });

  it("opens the sidebar on the stored drill-down page, exactly as the module reads it", () => {
    for (const stored of [...PAGES.map((p: string) => ({ [PAGE_KEY]: p })), {}, { [PAGE_KEY]: "settings" }]) {
      expect(runPreboot(stored).bodyAttrs["data-sidebar-page"]).toBe(readPage(storageOver(stored)));
    }
    expect(runPreboot({}, { throwing: true }).bodyAttrs["data-sidebar-page"]).toBe("root");
  });

  it("puts up the loading state exactly when app.js will reopen a saved view", () => {
    // The regression: a reload painted the "Nothing selected yet" landing and
    // its tabs before `restoreLastView` brought the saved view back. The
    // attribute swaps the landing for a spinner; it must agree with what the
    // owning modules read, or a first visit would sit on a spinner forever
    // (until app.js cleared it) and a restore would still flash the landing.
    const cases: Record<string, string>[] = [
      {},
      { [SELECTION_KEY]: JSON.stringify({ categoryId: 7, filter: "favorite" }) },
      { [SELECTION_KEY]: JSON.stringify({ categoryId: null, filter: "all" }) },
      { [SELECTION_KEY]: JSON.stringify({ categoryId: "7" }) },
      { [SELECTION_KEY]: "not json" },
      { [SELECTION_KEY]: "null" },
      { [OPEN_LIST_KEY]: "3" },
      { [OPEN_LIST_KEY]: "0" },
      { [OPEN_LIST_KEY]: "-2" },
      { [OPEN_LIST_KEY]: "1.5" },
      { [OPEN_LIST_KEY]: "abc" },
      { [SELECTION_KEY]: JSON.stringify({ categoryId: null }), [OPEN_LIST_KEY]: "4" },
    ];
    for (const stored of cases) {
      const storage = storageOver(stored);
      const selection = readSelection(storage);
      const reopens = (selection != null && selection.categoryId != null) || readOpenList(storage) != null;
      expect(runPreboot(stored).bodyAttrs["data-restoring"], JSON.stringify(stored)).toBe(
        reopens ? "view" : undefined,
      );
    }
    // Blocked storage restores nothing, so it shows the landing straight away.
    expect(
      runPreboot({ [OPEN_LIST_KEY]: "3" }, { throwing: true }).bodyAttrs["data-restoring"],
    ).toBeUndefined();
  });

  it("falls back to the defaults, without throwing, when storage is blocked", () => {
    const applied = runPreboot({ [SIDEBAR_KEY]: "0", [THEME_KEY]: "dark" }, { throwing: true });
    expect(applied.bodyAttrs["data-sidebar"]).toBe("collapsed");
    expect(applied.htmlAttrs["data-theme"]).toBeUndefined();
    expect(applied.cssProps["--sidebar-width"]).toBeUndefined();
  });

  it("runs before anything can paint: it is the FIRST element inside <body>", () => {
    const html = readFileSync(join(__dirname, "index.html"), "utf8");
    const afterBody = html.slice(html.indexOf("<body>") + "<body>".length);
    expect(afterBody.replace(/<!--[\s\S]*?-->/g, "").trimStart()).toMatch(
      /^<script id="xbo-preboot">/,
    );
  });
});
