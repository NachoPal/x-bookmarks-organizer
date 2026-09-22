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
