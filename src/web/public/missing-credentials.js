"use strict";

/**
 * Pure derivation of the "missing credentials" alert on the never-synced
 * landing (issue: an owner testing with credentials removed saw an empty
 * library with no explanation of why a sync would do nothing). Scoped to
 * exactly the three credentials `GET /api/setup` reports under
 * `credentials.*.present` - the X client id/secret (REQUIRED: sync cannot
 * reach X without them) and the TypeSafe/Jev API key (OPTIONAL: only needed
 * for TypeSafe categorization and ranking, see AGENTS.md's ranking/eval
 * sections). The Claude provider check is deliberately NOT one of these
 * three - it is a separate availability check, not a `/api/setup` credential
 * row.
 */
(function (root) {
  var CREDENTIALS = [
    { id: "xClientId", label: "X API client ID", envVar: "XBOOKMARKS_CLIENT_ID", tier: "required" },
    { id: "xClientSecret", label: "X API client secret", envVar: "XBOOKMARKS_CLIENT_SECRET", tier: "required" },
    { id: "typesafeApiKey", label: "TypeSafe API key", envVar: "TYPESAFE_API_KEY", tier: "optional" },
  ];

  /**
   * Which of the three are actually missing, split by tier. Only a
   * credential the server reports as NOT present is ever listed - never a
   * fabricated "all set" item. Returns null when nothing is missing.
   */
  function missingCredentials(credentials) {
    var creds = credentials || {};
    var required = [];
    var optional = [];
    for (var i = 0; i < CREDENTIALS.length; i++) {
      var c = CREDENTIALS[i];
      var status = creds[c.id];
      if (status && status.present) continue;
      (c.tier === "required" ? required : optional).push(c);
    }
    if (required.length === 0 && optional.length === 0) return null;
    return { required: required, optional: optional };
  }

  /**
   * Whether the landing's missing-credentials alert belongs on screen, and
   * what it should say - or null when it should not render at all.
   *
   * Gated on `bookmarkCount === 0` (mirrors `XBOCategorization.emptyStateKind`'s
   * "first-run" condition): the alert exists to explain why a fresh sync will
   * do nothing, so it has no reason to exist once bookmarks exist.
   *
   * `kind` is 'blocking' the instant any REQUIRED credential (either X key)
   * is missing - that blocks sync regardless of whether TypeSafe is also
   * missing - and 'optional' only when both X keys are present and just the
   * TypeSafe key is absent, which must read as an enhancement, never an
   * error. Nothing missing at all yields null - never a "ready to sync" list
   * with fabricated content.
   */
  function missingCredentialsAlert(bookmarkCount, credentials) {
    if (bookmarkCount !== 0) return null;
    var missing = missingCredentials(credentials);
    if (!missing) return null;
    return {
      kind: missing.required.length > 0 ? "blocking" : "optional",
      required: missing.required,
      optional: missing.optional,
    };
  }

  /**
   * The server's report that the chain's `.env` is readable by other local
   * users (`/api/setup` `credentials.dotenvExposure`, security finding #8),
   * shaped for the notice - or null when there is nothing to say. Unlike the
   * missing-credentials alert it is NOT gated on an empty library: an exposed
   * `.env` matters just as much once bookmarks exist, so the Settings panel
   * shows it too. `fix` is the exact command, the same one the server logged
   * at startup.
   */
  function dotenvExposureNotice(credentials) {
    var exposure = credentials && credentials.dotenvExposure;
    if (!exposure || typeof exposure.file !== "string" || !exposure.file) return null;
    var mode = typeof exposure.mode === "string" && exposure.mode ? exposure.mode : null;
    return {
      title: "Your .env file is readable by other users",
      detail:
        (mode ? "Its mode is " + mode + ", so " : "So ") +
        "other accounts on this machine can read the X client secret and API keys it holds. Fix it with:",
      fix: "chmod 600 " + exposure.file,
    };
  }

  var api = {
    missingCredentials: missingCredentials,
    missingCredentialsAlert: missingCredentialsAlert,
    dotenvExposureNotice: dotenvExposureNotice,
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.XBOMissingCredentials = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
