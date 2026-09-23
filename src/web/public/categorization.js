"use strict";

/**
 * Pure helpers behind the categorization selector (issue #71).
 *
 * The dropdowns are built from the server's catalog (`GET /api/setup`), so the
 * rules about what a choice MEANS - which fields a method uses, what
 * "Recommended" resolves to, whether a method is blocked by a missing key -
 * live here, DOM-free and unit-tested, exactly like `tree-counts.js` and
 * `read-toggle.js`. `app.js` owns only the markup that renders them.
 *
 * Browser global (no modules in this viewer) + CommonJS export for the test.
 */
(function (root) {
  /** Fallback label when a provider declares no model for a role. */
  var NO_MODEL = "(none available)";

  /**
   * Which fields a categorization method actually uses.
   *
   * The taxonomy pass is ALWAYS a language model - Jev invents no labels, so
   * it structurally cannot design the tree - which is why pass 1's provider,
   * model and effort stay live for both methods. Pass 2's provider and model
   * belong to the model method alone: Jev files bookmarks without a prompt.
   */
  function fieldsFor(methodId) {
    var usesModel = methodId !== "typesafe";
    return {
      taxonomyProvider: true,
      taxonomyModel: true,
      effort: true,
      assignmentProvider: usesModel,
      assignmentModel: usesModel,
    };
  }

  /**
   * A pass's provider id from saved settings. A document saved before each
   * pass had its own provider (issue #70) carries one `provider` for both.
   */
  function passProvider(settings, pass) {
    if (!settings) return "";
    return settings[pass + "Provider"] || settings.provider || "";
  }

  function findProvider(catalog, providerId) {
    var providers = (catalog && catalog.providers) || [];
    for (var i = 0; i < providers.length; i++) {
      if (providers[i].id === providerId) return providers[i];
    }
    return providers[0] || null;
  }

  function findMethod(catalog, methodId) {
    var methods = (catalog && catalog.methods) || [];
    for (var i = 0; i < methods.length; i++) {
      if (methods[i].id === methodId) return methods[i];
    }
    return methods[0] || null;
  }

  function labelFor(provider, modelId) {
    var models = (provider && provider.models) || [];
    for (var i = 0; i < models.length; i++) {
      if (models[i].id === modelId) return models[i].label;
    }
    return modelId;
  }

  /**
   * Options for one role's model dropdown, led by a "Recommended" entry whose
   * value is the empty string. Storing "" rather than the suggested id is what
   * keeps an unopinionated owner following the provider's own per-role
   * suggestion instead of pinning today's answer forever - so the label spells
   * out what Recommended currently resolves to.
   */
  function modelOptions(provider, role) {
    var suggested = provider && provider.suggested ? provider.suggested[role] : undefined;
    var options = [
      {
        value: "",
        label: suggested ? "Recommended (" + labelFor(provider, suggested) + ")" : "Recommended",
        hint: "Follows the provider's own choice for this pass.",
      },
    ];
    var models = (provider && provider.models) || [];
    for (var i = 0; i < models.length; i++) {
      options.push({ value: models[i].id, label: models[i].label, hint: models[i].description || "" });
    }
    if (models.length === 0) options.push({ value: "", label: NO_MODEL, hint: "" });
    return options;
  }

  // ---- providers with a full model catalog (pi's upstreams) -------------
  //
  // A provider that declares `sources` reaches far more models than its short
  // `models` list: each source (Anthropic, OpenRouter, OpenCode...) has its own
  // catalog, fetched on demand from `GET /api/models` and searched in the
  // picker. A model id there is `<source>/<model>`, so the prefix names the
  // source - and with it the key the model needs and who bills it.

  function sourcesOf(provider) {
    return (provider && provider.sources) || [];
  }

  function findSource(provider, sourceId) {
    var sources = sourcesOf(provider);
    for (var i = 0; i < sources.length; i++) {
      if (sources[i].id === sourceId) return sources[i];
    }
    return null;
  }

  /** The source a `<source>/<model>` id belongs to, or null (mirrors the server's shape check). */
  function sourceOfModel(provider, modelId) {
    if (!modelId) return null;
    var slash = modelId.indexOf("/");
    if (slash <= 0 || !modelId.slice(slash + 1).trim()) return null;
    return findSource(provider, modelId.slice(0, slash));
  }

  /**
   * Which source a pass's picker opens on: the chosen model's own, else the
   * one hosting the provider's suggestion for the pass (what "Recommended"
   * resolves to), else the first.
   */
  function passSource(provider, pass, modelId) {
    var own = sourceOfModel(provider, modelId);
    if (own) return own.id;
    var suggested = provider && provider.suggested ? provider.suggested[pass] : undefined;
    var host = sourceOfModel(provider, suggested);
    if (host) return host.id;
    var sources = sourcesOf(provider);
    return sources[0] ? sources[0].id : "";
  }

  function compactTokens(n) {
    if (!n) return "";
    if (n >= 1000000) return Number((n / 1000000).toFixed(2)) + "M";
    return Math.round(n / 1000) + "k";
  }

  function formatPrice(usd) {
    if (usd === 0) return "$0";
    return Number.isInteger(usd) ? "$" + usd : "$" + usd.toFixed(2);
  }

  /**
   * The picker's second line for a model: context window and price per
   * million tokens (the unit is stated once, in the picker's status line).
   */
  function modelMeta(model) {
    var parts = [];
    if (model.contextWindow) parts.push(compactTokens(model.contextWindow) + " context");
    if (model.price) {
      parts.push(
        model.price.input === 0 && model.price.output === 0
          ? "listed at $0 per token"
          : formatPrice(model.price.input) + "\u00a0in · " + formatPrice(model.price.output) + "\u00a0out",
      );
    }
    return parts.join(" · ");
  }

  /** Every whitespace-separated term of the query appears in the model's name or id. */
  function matchesQuery(model, query) {
    var q = String(query || "").trim().toLowerCase();
    if (!q) return true;
    var haystack = (model.label + " " + model.id).toLowerCase();
    var terms = q.split(/\s+/);
    for (var i = 0; i < terms.length; i++) {
      if (haystack.indexOf(terms[i]) === -1) return false;
    }
    return true;
  }

  var PASS_WORD = { taxonomy: "tree design", assignment: "filing" };

  /**
   * The picker's options for one source, in order: "Recommended" (only on the
   * source that hosts the provider's suggestion - elsewhere it would silently
   * mean a model from ANOTHER source), then the provider's recommended picks
   * on this source, then the rest of the catalog alphabetically. Each carries
   * a `meta` line and, for a pick suggested for this pass, a `badge`.
   */
  function pickerEntries(provider, sourceId, models, pass, query) {
    var entries = [];
    var suggested = provider && provider.suggested ? provider.suggested[pass] : undefined;
    var suggestedSource = sourceOfModel(provider, suggested);
    var recommended = (provider && provider.models) || [];
    var picks = {};
    for (var r = 0; r < recommended.length; r++) {
      var src = sourceOfModel(provider, recommended[r].id);
      if (src && src.id === sourceId) picks[recommended[r].id] = recommended[r];
    }
    if (suggestedSource && suggestedSource.id === sourceId) {
      var rec = {
        value: "",
        label: "Recommended: " + labelFor(provider, suggested),
        meta: "Follows the provider's own choice for this pass.",
        id: "",
      };
      if (matchesQuery({ label: rec.label + " recommended", id: suggested }, query)) entries.push(rec);
    }
    var list = models || [];
    var rest = [];
    var head = [];
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (!matchesQuery(m, query)) continue;
      var entry = {
        value: m.id,
        label: m.label,
        id: m.id,
        meta: modelMeta(m),
        hint: m.description || "",
        badge: m.suggestedFor && m.suggestedFor.indexOf(pass) !== -1 ? "Suggested for " + PASS_WORD[pass] : "",
      };
      if (picks[m.id]) head.push(entry);
      else rest.push(entry);
    }
    return entries.concat(head, rest);
  }

  /**
   * Whether a source's key is in place, as the one line under the source
   * select. The catalog lists a source's models whether or not the key is
   * there - browsing is free - so this is what says a choice cannot RUN yet,
   * in words, never by color alone.
   */
  function sourceNotice(source, providerKeys) {
    if (!source) return { text: "", state: "none" };
    if (source.freeform) {
      return {
        text:
          "Runs on your own OpenAI-compatible server (set XBOOKMARKS_PIAI_BASE_URL) - no per-call charge.",
        state: "none",
      };
    }
    var paid = source.billing === "per-token" ? "PAID per token, billed to your " + source.label + " key." : "";
    if (!source.requiresKey) return { text: paid, state: "none" };
    var status = providerKeys && providerKeys[source.requiresKey];
    if (status && status.present) {
      return {
        text: source.requiresKey + " found" + (status.source ? " (" + status.source + ")" : "") + ". " + paid,
        state: "present",
      };
    }
    return {
      text: "Needs " + source.requiresKey + " - not found. " + paid + " You can still browse and pick a model.",
      state: "missing",
    };
  }

  var CHAIN =
    "an environment variable, a .env file in the project root, your OS keychain, or " +
    "~/.config/x-bookmarks-organizer/credentials.json";

  /** The fields a save actually persists, in the order compared. */
  var SAVED_FIELDS = ["categorizer", "taxonomyProvider", "assignmentProvider", "taxonomyModel", "assignmentModel", "effort"];

  /**
   * Whether the current selection is identical to the saved configuration
   * (issue #122), compared through `toPayload` on BOTH sides - the exact
   * normalization (an empty/"Recommended" field dropped, a filing model
   * ignored for Jev) the server itself applies - so this can never disagree
   * with what a save would actually do. `savedSettings` is the document the
   * form's own `setValues()` consumes (`/api/setup`'s `settings`, or a save's
   * own response), read through `passProvider` so a legacy single-`provider`
   * document compares correctly too. No saved settings at all (nothing has
   * ever been saved) means there is nothing to be unchanged FROM.
   */
  function isUnchanged(values, savedSettings) {
    if (!savedSettings) return false;
    var saved = toPayload({
      categorizer: savedSettings.categorizer,
      taxonomyProvider: passProvider(savedSettings, "taxonomy"),
      taxonomyModel: savedSettings.taxonomyModel,
      assignmentProvider: passProvider(savedSettings, "assignment"),
      assignmentModel: savedSettings.assignmentModel,
      effort: savedSettings.effort,
    });
    var current = toPayload(values);
    for (var i = 0; i < SAVED_FIELDS.length; i++) {
      var key = SAVED_FIELDS[i];
      if ((current[key] || "") !== (saved[key] || "")) return false;
    }
    return true;
  }

  /**
   * What a pass's model choice needs before it can run, one sentence each,
   * for the form's note: a provider that cannot run at all right now (its
   * own `check()`, e.g. `claude-cli` when the CLI isn't installed or logged
   * in), a catalog source picked with no model in it yet, a local model with
   * no name, or a source whose key the server cannot find - all `blocksSave`,
   * since the owner reversed #120's "missing key never blocks Save" after
   * using it: a selection that cannot actually run is no more saveable than
   * one with no model chosen. `values` carries each pass's `<pass>Source`
   * beside its model. `providerAvailability` covers a provider with no
   * credential-chain key of its own (only `claude-cli` today, issue #35) -
   * a keyed provider/source is covered by `providerKeys` instead. `savedSettings`,
   * when given, adds a selection identical to it (issue #122) as one more
   * `blocksSave` reason - a save that would change nothing is no more useful
   * than one the server would reject.
   */
  function passProblems(values, catalog, providerKeys, providerAvailability, savedSettings) {
    var problems = [];
    var fields = fieldsFor(values.categorizer);
    var passes = [
      { pass: "taxonomy", name: "Phase 1", used: true },
      { pass: "assignment", name: "Phase 2", used: fields.assignmentModel },
    ];
    for (var i = 0; i < passes.length; i++) {
      var p = passes[i];
      if (!p.used) continue;
      var provider = findProvider(catalog, values[p.pass + "Provider"]);
      var availability = provider && providerAvailability ? providerAvailability[provider.id] : null;
      if (availability && availability.available === false) {
        problems.push({
          text:
            p.name +
            " runs on " +
            (provider.label || provider.id) +
            ", which is not available right now" +
            (availability.reason ? ": " + availability.reason : ".") +
            (availability.reason && !/[.!?]$/.test(availability.reason) ? "." : ""),
          blocksSave: true,
        });
        continue;
      }
      if (sourcesOf(provider).length === 0) continue;
      var model = values[p.pass + "Model"] || "";
      var suggested = provider.suggested ? provider.suggested[p.pass] : undefined;
      var source = sourceOfModel(provider, model || suggested);
      var chosen = findSource(provider, values[p.pass + "Source"]) || source;
      if (!model && chosen && (!source || source.id !== chosen.id)) {
        problems.push({
          text: chosen.freeform
            ? p.name + ": type the model name your local server serves."
            : p.name + ": choose a model from " + chosen.label + ".",
          blocksSave: true,
        });
        continue;
      }
      var notice = sourceNotice(source, providerKeys);
      if (notice.state === "missing") {
        problems.push({
          text:
            p.name +
            " runs on " +
            source.label +
            ", which needs " +
            source.requiresKey +
            ". Make it available to the server - " +
            CHAIN +
            " - then restart the viewer.",
          // Reversed from #120: a selection whose key is missing cannot run,
          // so it blocks Save just like an incomplete model choice does.
          blocksSave: true,
        });
      }
    }
    if (isUnchanged(values, savedSettings)) {
      problems.push({ text: "No changes to save.", blocksSave: true });
    }
    return problems;
  }

  /**
   * Whether the current selection would be REJECTED by `PUT /api/settings`,
   * needs a credential the server reports absent, names a provider that
   * cannot run right now, or is identical to what is already saved - the
   * same conditions `passProblems` flags with `blocksSave` (a catalog source
   * picked with no model in it yet, a local model with no typed name, a
   * chosen provider/source whose required key is missing, a keyless provider
   * like `claude-cli` whose own `check()` failed, or no actual change from
   * `savedSettings`, issue #122). Used to disable Save proactively, rather
   * than let the owner find out only after clicking it. `providerKeys`/
   * `providerAvailability` must be the real maps from `/api/setup` - passing
   * `{}` for either would read every source/provider they cover as unusable
   * regardless of its actual status. `savedSettings` is optional - omitting
   * it (an older caller, or a flow with no saved baseline) never blocks Save
   * for being unchanged.
   */
  function hasSaveBlocker(values, catalog, providerKeys, providerAvailability, savedSettings) {
    return passProblems(values, catalog, providerKeys, providerAvailability, savedSettings).some(function (p) {
      return p.blocksSave;
    });
  }

  /** How each billing model reads to the owner, in one line. */
  var BILLING_HINTS = {
    subscription: "Runs on your Claude subscription - no per-call charge.",
    "per-token": "PAID per token, billed to the API key of the model's own provider.",
    local: "Runs locally.",
  };

  /**
   * The line under a pass's provider select, and whether it wears the billing
   * emphasis. A provider that carries a risk warning (the Claude subscription
   * driven through pi, which Anthropic's terms prohibit) shows THAT instead of
   * its billing line - "no per-call charge" is true of it and would be the
   * wrong thing to reassure the owner with at the moment they choose it.
   */
  function providerNotice(provider) {
    if (!provider) return { text: "", emphasis: false };
    if (provider.warning) return { text: provider.warning, emphasis: true };
    return { text: BILLING_HINTS[provider.billing] || "", emphasis: provider.billing === "per-token" };
  }

  /** Effort options, led by the same empty-valued "Default" entry. */
  function effortOptions(provider) {
    var options = [{ value: "", label: "Default (high)", hint: "The app's own default for this pass." }];
    var efforts = (provider && provider.efforts) || [];
    for (var i = 0; i < efforts.length; i++) {
      options.push({ value: efforts[i], label: efforts[i], hint: "" });
    }
    return options;
  }

  /**
   * The body of `PUT /api/settings` from the raw field values. An empty string
   * is "not chosen", so it is dropped rather than sent - the server would
   * reject "" as an unknown model, and the whole point of Recommended is that
   * nothing is pinned.
   */
  function toPayload(values) {
    var fields = fieldsFor(values.categorizer);
    var payload = {
      categorizer: values.categorizer,
      taxonomyProvider: values.taxonomyProvider,
      assignmentProvider: values.assignmentProvider,
    };
    if (values.taxonomyModel) payload.taxonomyModel = values.taxonomyModel;
    if (fields.assignmentModel && values.assignmentModel) {
      payload.assignmentModel = values.assignmentModel;
    }
    if (values.effort) payload.effort = values.effort;
    return payload;
  }

  /**
   * Why the chosen method cannot run yet, or null when it can. A method that
   * names a required credential (Jev's `TYPESAFE_API_KEY`) is blocked until
   * the server reports that key as present - said BEFORE the owner starts a
   * sync, rather than as a mid-run failure.
   */
  function methodBlocker(catalog, methodId, credentials) {
    var method = findMethod(catalog, methodId);
    if (!method || !method.requiresKey) return null;
    var present = credentials && credentials.typesafeApiKey && credentials.typesafeApiKey.present;
    if (present) return null;
    return (
      method.label +
      " needs " +
      method.requiresKey +
      ". Make it available to the server - an environment variable, a .env file in the " +
      "project root, your OS keychain, or ~/.config/x-bookmarks-organizer/credentials.json - " +
      "then restart the viewer."
    );
  }

  /**
   * What is missing before a sync can run at all, as one actionable sentence
   * per problem. Empty means the owner is ready.
   */
  function syncBlockers(setup) {
    var problems = [];
    var creds = (setup && setup.credentials) || {};
    var missing = [];
    if (!(creds.xClientId && creds.xClientId.present)) missing.push("XBOOKMARKS_CLIENT_ID");
    if (!(creds.xClientSecret && creds.xClientSecret.present)) missing.push("XBOOKMARKS_CLIENT_SECRET");
    if (missing.length > 0) {
      problems.push(
        "The server cannot reach your X app credentials (" +
          missing.join(" and ") +
          "). Provide them through the environment, a .env file, your OS keychain, or " +
          "~/.config/x-bookmarks-organizer/credentials.json, then restart the viewer.",
      );
    } else if (!(setup && setup.x && setup.x.connected)) {
      problems.push("This app has not been authorized to read your X bookmarks yet.");
    }
    var blocker = methodBlocker(setup && setup.catalog, setup && setup.settings && setup.settings.categorizer, creds);
    if (blocker) problems.push(blocker);
    if (setup && setup.sync && setup.sync.available === false && setup.sync.reason) {
      problems.push(setup.sync.reason);
    }
    return problems;
  }

  /**
   * Whether the ONLY thing standing between the owner and a sync is the
   * one-time X authorization - the single blocker the guided flow can
   * actually resolve. A missing credential is fixed outside the app, so
   * reopening the flow over it would just repeat the strip's own message.
   */
  function needsAuthorizationOnly(setup) {
    var creds = (setup && setup.credentials) || {};
    var x = (setup && setup.x) || {};
    var haveCreds =
      creds.xClientId && creds.xClientId.present && creds.xClientSecret && creds.xClientSecret.present;
    return !!haveCreds && !x.connected && !!x.canConnect;
  }

  /** The one line the progress strip shows for a status, per sync state. */
  function progressLine(status) {
    if (!status) return "";
    if (status.state === "running") {
      var messages = status.messages || [];
      return messages.length > 0 ? messages[messages.length - 1] : "Starting sync…";
    }
    if (status.state === "error") return status.error || "The sync failed.";
    if (status.state === "done") {
      var s = status.summary;
      if (!s) return "Sync finished.";
      if (s.newBookmarks === 0) return "Up to date - no new bookmarks.";
      return (
        "Synced " +
        s.newBookmarks +
        (s.newBookmarks === 1 ? " new bookmark" : " new bookmarks") +
        (s.nodesCreated > 0
          ? " into " + s.nodesCreated + (s.nodesCreated === 1 ? " new category" : " new categories")
          : "") +
        "."
      );
    }
    return "";
  }

  /**
   * Which empty state the content pane shows. A library with NO bookmarks is
   * the guided first run (regardless of selection); one with bookmarks but no
   * category picked keeps the plain "select a category" prompt; otherwise the
   * pane belongs to the selected category's posts.
   */
  function emptyStateKind(bookmarkCount, selectedCategoryId) {
    if (bookmarkCount === 0) return "first-run";
    if (bookmarkCount > 0 && selectedCategoryId == null) return "select-category";
    return "none";
  }

  /**
   * Whether the filter tab bar (Unread / Read / All / Favorites) belongs on
   * screen at all.
   *
   * Those four are views OF one category, so with nothing selected - the
   * "Select a category" prompt, or the never-synced first run - the bar has
   * nothing to filter and is ABSENT rather than zeroed. That is also what
   * stops a Reset (which returns the app to the first run) from leaving the
   * previous category's count badges frozen on screen.
   *
   * An unknown count (the viewer could not reach its own server) still shows
   * the bar for an open category: the tabs are then correct for the posts
   * that are actually rendered, which is all the bar claims.
   */
  function showFilterTabs(bookmarkCount, selectedCategoryId) {
    return selectedCategoryId != null && bookmarkCount !== 0;
  }

  var api = {
    emptyStateKind: emptyStateKind,
    showFilterTabs: showFilterTabs,
    fieldsFor: fieldsFor,
    passProvider: passProvider,
    findProvider: findProvider,
    findMethod: findMethod,
    modelOptions: modelOptions,
    sourcesOf: sourcesOf,
    findSource: findSource,
    sourceOfModel: sourceOfModel,
    passSource: passSource,
    modelMeta: modelMeta,
    matchesQuery: matchesQuery,
    pickerEntries: pickerEntries,
    sourceNotice: sourceNotice,
    passProblems: passProblems,
    hasSaveBlocker: hasSaveBlocker,
    isUnchanged: isUnchanged,
    providerNotice: providerNotice,
    BILLING_HINTS: BILLING_HINTS,
    effortOptions: effortOptions,
    toPayload: toPayload,
    methodBlocker: methodBlocker,
    syncBlockers: syncBlockers,
    needsAuthorizationOnly: needsAuthorizationOnly,
    progressLine: progressLine,
  };

  root.XBOCategorization = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
