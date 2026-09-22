"use strict";

/**
 * Pure helpers behind the Jev rules (rubric) editor (issue #102).
 *
 * The DOM-free half, in the same style as `ranking.js` and `tree-counts.js`:
 * every rule about what a draft MEANS - whether it is valid, what a preset's
 * coverage line says, what switching to it would cost, how a weight reads as a
 * share of the score - lives here and is unit-tested offline. `app.js` owns
 * only the markup.
 *
 * Two things worth stating out loud, because they are the feature's whole
 * safety story:
 *
 *  * **Nothing in here spends anything.** Authoring, validating and choosing
 *    rules are free. Only a rank run calls the paid API, behind the existing
 *    confirm-before-spend dialog - which is why {@link switchWarning} is a
 *    statement of fact ("nothing is ranked under these rules yet") and never a
 *    button that quietly starts a run.
 *  * **The server validates too, and it is authoritative.** These checks exist
 *    so a problem is visible before a round trip, not instead of one; the
 *    messages deliberately match `src/rank/presets.ts`, and a rule this file
 *    misses simply surfaces a moment later in the same error region.
 *
 * Browser global (no modules in this viewer) + CommonJS export for the test.
 */
(function (root) {
  /** Mirrors `src/rank/presets.ts`. The server re-states them in `/api/rubric`. */
  var LIMITS = { maxDimensions: 12, minLevels: 2, maxLevels: 10 };

  var BUILT_IN_ID = "default";

  function limits(state) {
    var l = state && state.limits ? state.limits : {};
    return {
      maxDimensions: l.maxDimensions || LIMITS.maxDimensions,
      minLevels: l.minLevels || LIMITS.minLevels,
      maxLevels: l.maxLevels || LIMITS.maxLevels,
    };
  }

  function text(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function plural(n, one, many) {
    return n + " " + (n === 1 ? one : many);
  }

  /**
   * A human label from a machine key: `learning_value` -> "Learning value".
   *
   * The built-in rubric's dimensions carry only their key, so without this a
   * clone of it opens showing `learning_value` in a field labelled "Dimension"
   * - the internal name leaking into the one place the owner is meant to read
   * plain language. The key itself is unchanged by the relabelling, so a
   * renamed dimension keeps the breakdown it was scored under.
   */
  function humanizeKey(key) {
    var words = String(key == null ? "" : key).replace(/[_-]+/g, " ").trim();
    return words ? words.charAt(0).toUpperCase() + words.slice(1) : "";
  }

  /** A stable machine key from a human label - the same slug the server derives. */
  function slugifyKey(label) {
    return String(label == null ? "" : label)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40);
  }

  /** A fresh dimension: two levels, because two is the fewest that says anything. */
  function blankDimension() {
    return { label: "", instructions: "", levels: ["", ""], weight: 1 };
  }

  /** A fresh preset draft. */
  function blankDraft() {
    return { name: "", dimensions: [blankDimension()] };
  }

  /**
   * An editable draft of an existing preset.
   *
   * The built-in preset is cloned rather than edited: it is the fallback every
   * other answer depends on, so it stays exactly as it shipped and the owner
   * gets a copy of its questions to start from instead of an empty form.
   */
  function draftFromPreset(preset, presets) {
    var p = preset || {};
    var clone = !!p.builtIn;
    return {
      id: clone ? undefined : p.id,
      name: clone ? copyName(p.name, presets) : p.name || "",
      dimensions: (p.dimensions || []).map(function (d) {
        return {
          label: d.label || humanizeKey(d.id),
          id: d.id || "",
          instructions: d.instructions || "",
          levels: (d.levels || []).slice(),
          weight: typeof d.weight === "number" ? d.weight : 1,
        };
      }),
    };
  }

  /** "Copy of X", stepped until no existing preset holds it. */
  function copyName(name, presets) {
    var taken = (presets || []).map(function (p) {
      return String(p.name || "").toLowerCase();
    });
    var base = "Copy of " + (name || "ranking rules");
    var candidate = base;
    var n = 1;
    while (taken.indexOf(candidate.toLowerCase()) !== -1) candidate = base + " " + ++n;
    return candidate.slice(0, 60);
  }

  /** Move one entry by `delta`, or return the list untouched at either end. */
  function moveItem(list, index, delta) {
    var next = (list || []).slice();
    var target = index + delta;
    if (index < 0 || index >= next.length || target < 0 || target >= next.length) return next;
    var moved = next.splice(index, 1)[0];
    next.splice(target, 0, moved);
    return next;
  }

  /**
   * What each weight contributes to the overall score, as a rounded percentage.
   *
   * Weights are RATIOS - "3" means nothing on its own - so the editor shows the
   * share instead of asking the owner to hold the arithmetic in their head.
   * Shares are derived, never stored: the rubric's version depends on the
   * weights, not on this.
   */
  function weightShares(dimensions) {
    var list = dimensions || [];
    var total = 0;
    for (var i = 0; i < list.length; i++) {
      var w = Number(list[i] && list[i].weight);
      if (isFinite(w) && w > 0) total += w;
    }
    return list.map(function (d) {
      var w = Number(d && d.weight);
      if (!isFinite(w) || w <= 0 || total <= 0) return 0;
      return Math.round((w / total) * 100);
    });
  }

  /**
   * Validate a draft, one actionable sentence per problem - the same rules and
   * wording as the server's `validatePreset`, so the two never contradict each
   * other in front of the owner.
   */
  function validate(draft, others, state) {
    var lim = limits(state);
    var errors = [];
    var d = draft || {};
    var name = text(d.name);

    if (!name) errors.push("Give these ranking rules a name.");
    else if (
      (others || []).some(function (p) {
        return String(p.name || "").toLowerCase() === name.toLowerCase();
      })
    ) {
      errors.push('Another set of ranking rules is already called "' + name + '". Pick a different name.');
    }

    var dimensions = d.dimensions || [];
    if (dimensions.length < 1) {
      errors.push("Add at least one dimension - a rubric with no questions cannot score anything.");
    } else if (dimensions.length > lim.maxDimensions) {
      errors.push(
        "There are " + dimensions.length + " dimensions; the limit is " + lim.maxDimensions +
          ". Each one is a question in the billed request for every bookmark.",
      );
    }

    var seen = {};
    dimensions.forEach(function (dim, index) {
      var where = "Dimension " + (index + 1);
      var key = slugifyKey(text(dim && dim.id) || text(dim && dim.label));
      if (!key) errors.push(where + " needs a name.");
      else if (seen[key]) {
        errors.push(
          where + ' has the same key ("' + key + '") as an earlier dimension. ' +
            "Two dimensions cannot share a key - rename one of them.",
        );
      }
      if (key) seen[key] = true;

      if (!text(dim && dim.instructions)) {
        errors.push(where + " needs a question for the model to answer.");
      }

      var levels = (dim && dim.levels ? dim.levels : []).filter(function (level) {
        return text(level).length > 0;
      });
      if (levels.length < lim.minLevels) {
        errors.push(
          where + " needs at least " + lim.minLevels + " levels - they are what tell the model " +
            "what each score means.",
        );
      } else if (levels.length > lim.maxLevels) {
        errors.push(where + " has " + levels.length + " levels; the limit is " + lim.maxLevels + ".");
      }

      var weight = Number(dim && dim.weight);
      if (!isFinite(weight) || weight <= 0) {
        errors.push(where + "'s weight must be a number greater than zero. Only ratios matter.");
      }
    });

    return errors;
  }

  /** The payload the API takes: empty levels dropped, the key derived from the label. */
  function toPayload(draft) {
    var d = draft || {};
    return {
      name: text(d.name),
      dimensions: (d.dimensions || []).map(function (dim) {
        return {
          id: slugifyKey(text(dim.id) || text(dim.label)),
          label: text(dim.label),
          instructions: text(dim.instructions),
          levels: (dim.levels || [])
            .map(function (level) {
              return text(level);
            })
            .filter(function (level) {
              return level.length > 0;
            }),
          weight: Number(dim.weight),
        };
      }),
    };
  }

  function isBuiltIn(preset) {
    return !!preset && (preset.builtIn === true || preset.id === BUILT_IN_ID);
  }

  /** The built-in preset is the fallback, so it is never editable or deletable. */
  function canEdit(preset) {
    return !!preset && !isBuiltIn(preset);
  }

  function canDelete(preset) {
    return canEdit(preset);
  }

  /** The name as the list shows it - the built-in one says what it is. */
  function presetLabel(preset) {
    var name = (preset && preset.name) || "Ranking rules";
    return isBuiltIn(preset) && !/built-in/i.test(name) ? name + " (built-in)" : name;
  }

  /**
   * How much of the library this preset has judged.
   *
   * Per PRESET, not per library: a bookmark scored under other rules has no
   * verdict under these, which is the honest thing to say before the owner
   * switches - and the reason the switch itself is free.
   */
  function coverageLine(preset, total) {
    var count = Math.max(0, (preset && preset.scored) || 0);
    var n = Math.max(0, total || 0);
    if (n === 0) return "No bookmarks to rank yet.";
    if (count === 0) return "Nothing ranked under these rules yet.";
    if (count >= n) return "All " + plural(n, "bookmark", "bookmarks") + " ranked under these rules.";
    return count + " of " + plural(n, "bookmark", "bookmarks") + " ranked under these rules.";
  }

  /**
   * What activating this preset would leave unranked, or null when it would
   * leave nothing unranked.
   *
   * Deliberately a STATEMENT and never an action: selecting a preset costs
   * nothing, and the re-rank it invites is a separate, confirmed, paid run.
   */
  function switchWarning(preset, total) {
    var n = Math.max(0, total || 0);
    if (n === 0) return null;
    var left = n - Math.max(0, (preset && preset.scored) || 0);
    if (left <= 0) return null;
    return (
      plural(left, "bookmark", "bookmarks") +
      " would read as unranked under these rules until you run a (paid) ranking pass. " +
      "Switching itself costs nothing."
    );
  }

  /** The active preset out of a `/api/rubric` state, or undefined. */
  function activePreset(state) {
    var s = state || {};
    return (s.presets || []).filter(function (p) {
      return p.id === s.activeId;
    })[0];
  }

  var api = {
    BUILT_IN_ID: BUILT_IN_ID,
    slugifyKey: slugifyKey,
    humanizeKey: humanizeKey,
    blankDimension: blankDimension,
    blankDraft: blankDraft,
    draftFromPreset: draftFromPreset,
    copyName: copyName,
    moveItem: moveItem,
    weightShares: weightShares,
    validate: validate,
    toPayload: toPayload,
    canEdit: canEdit,
    canDelete: canDelete,
    presetLabel: presetLabel,
    coverageLine: coverageLine,
    switchWarning: switchWarning,
    activePreset: activePreset,
  };

  root.XBORubricEditor = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
