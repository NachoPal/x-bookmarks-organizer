import { describe, expect, it } from "vitest";

// Plain browser JS, required directly (not compiled by tsc).
const { missingCredentials, missingCredentialsAlert, dotenvExposureNotice } = require("./missing-credentials.js");

const PRESENT = { present: true, source: "env" };
const ABSENT = { present: false };

describe("missingCredentials", () => {
  it("splits all three missing into the required X pair and the optional TypeSafe key", () => {
    const result = missingCredentials({ xClientId: ABSENT, xClientSecret: ABSENT, typesafeApiKey: ABSENT });
    expect(result).not.toBeNull();
    expect(result!.required.map((c) => c.id)).toEqual(["xClientId", "xClientSecret"]);
    expect(result!.optional.map((c) => c.id)).toEqual(["typesafeApiKey"]);
  });

  it("lists only TypeSafe when the X pair is present", () => {
    const result = missingCredentials({ xClientId: PRESENT, xClientSecret: PRESENT, typesafeApiKey: ABSENT });
    expect(result!.required).toEqual([]);
    expect(result!.optional.map((c) => c.id)).toEqual(["typesafeApiKey"]);
  });

  it("returns null when nothing is missing", () => {
    expect(missingCredentials({ xClientId: PRESENT, xClientSecret: PRESENT, typesafeApiKey: PRESENT })).toBeNull();
  });

  it("treats an absent credentials object as everything missing", () => {
    const result = missingCredentials(undefined);
    expect(result!.required.map((c) => c.id)).toEqual(["xClientId", "xClientSecret"]);
    expect(result!.optional.map((c) => c.id)).toEqual(["typesafeApiKey"]);
  });

  it("only lists a credential the server actually reports as missing (never a fabricated item)", () => {
    const result = missingCredentials({ xClientId: ABSENT, xClientSecret: PRESENT, typesafeApiKey: PRESENT });
    expect(result!.required.map((c) => c.id)).toEqual(["xClientId"]);
    expect(result!.optional).toEqual([]);
  });
});

describe("missingCredentialsAlert", () => {
  it("is blocking when both X keys and TypeSafe are missing on an empty library", () => {
    const alert = missingCredentialsAlert(0, { xClientId: ABSENT, xClientSecret: ABSENT, typesafeApiKey: ABSENT });
    expect(alert).toEqual({
      kind: "blocking",
      required: expect.arrayContaining([
        expect.objectContaining({ id: "xClientId" }),
        expect.objectContaining({ id: "xClientSecret" }),
      ]),
      optional: [expect.objectContaining({ id: "typesafeApiKey" })],
    });
    expect(alert!.required).toHaveLength(2);
  });

  it("is optional-only, never blocking, when just TypeSafe is missing", () => {
    const alert = missingCredentialsAlert(0, { xClientId: PRESENT, xClientSecret: PRESENT, typesafeApiKey: ABSENT });
    expect(alert!.kind).toBe("optional");
    expect(alert!.required).toEqual([]);
    expect(alert!.optional.map((c) => c.id)).toEqual(["typesafeApiKey"]);
  });

  it("stays blocking when one required X key is missing even though TypeSafe is present", () => {
    const alert = missingCredentialsAlert(0, { xClientId: ABSENT, xClientSecret: PRESENT, typesafeApiKey: PRESENT });
    expect(alert!.kind).toBe("blocking");
    expect(alert!.required.map((c) => c.id)).toEqual(["xClientId"]);
    expect(alert!.optional).toEqual([]);
  });

  it("shows no missing-credentials list when nothing is missing, even on an empty library", () => {
    expect(missingCredentialsAlert(0, { xClientId: PRESENT, xClientSecret: PRESENT, typesafeApiKey: PRESENT })).toBeNull();
  });

  it("never renders once the library has been synced, regardless of what is missing", () => {
    expect(
      missingCredentialsAlert(1, { xClientId: ABSENT, xClientSecret: ABSENT, typesafeApiKey: ABSENT }),
    ).toBeNull();
    expect(missingCredentialsAlert(42, undefined)).toBeNull();
  });
});

describe("dotenvExposureNotice (security finding #8)", () => {
  it("states the mode and hands over the exact fix command", () => {
    const notice = dotenvExposureNotice({ dotenvExposure: { file: "/x/.env", mode: "644" } });
    expect(notice.title).toBe("Your .env file is readable by other users");
    expect(notice.detail).toContain("mode is 644");
    expect(notice.fix).toBe("chmod 600 /x/.env");
  });

  it("is null when the server reports no exposure, or nothing usable at all", () => {
    expect(dotenvExposureNotice({ dotenvExposure: null })).toBeNull();
    expect(dotenvExposureNotice({ dotenvExposure: { file: "" } })).toBeNull();
    expect(dotenvExposureNotice({})).toBeNull();
    expect(dotenvExposureNotice(undefined)).toBeNull();
  });
});
