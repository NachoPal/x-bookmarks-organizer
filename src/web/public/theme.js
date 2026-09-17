"use strict";

/**
 * Persisted light/dark theme preference. Shared between the browser (app.js,
 * loaded via <script>) and Vitest (required directly from theme.test.ts).
 */
(function (root) {
  const THEME_KEY = "xbo:theme";

  /**
   * The explicitly stored theme ("light" or "dark"), or null when nothing is
   * stored (or storage is unavailable/throws), meaning: follow the system
   * theme.
   */
  function readStoredTheme(storage) {
    try {
      const raw = storage.getItem(THEME_KEY);
      return raw === "light" || raw === "dark" ? raw : null;
    } catch (_) {
      return null;
    }
  }

  /** Persist the theme preference; silently ignored if storage throws. */
  function writeTheme(storage, theme) {
    try {
      storage.setItem(THEME_KEY, theme);
    } catch (_) {
      /* private mode / blocked storage: ignore */
    }
  }

  /**
   * The theme actually in effect: the stored explicit preference if there is
   * one, otherwise whatever the system prefers.
   */
  function effectiveTheme(storage, systemPrefersDark) {
    const stored = readStoredTheme(storage);
    if (stored) return stored;
    return systemPrefersDark ? "dark" : "light";
  }

  const api = { THEME_KEY, readStoredTheme, writeTheme, effectiveTheme };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.XBOTheme = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
