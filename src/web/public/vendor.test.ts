import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `vendor/` holds plain `<script>` copies of `marked` and `dompurify`, which
 * `npm audit` cannot see. Pinning each copy to the installed npm package keeps
 * a dependency bump (a security fix included) from leaving the browser on the
 * old build: re-vendor by copying the file below, minus its sourceMappingURL
 * line (the map is not shipped).
 */
const VENDORED = [
  { pkg: "marked", file: "marked.min.js", source: "lib/marked.umd.js" },
  { pkg: "dompurify", file: "dompurify.min.js", source: "dist/purify.min.js" },
];

function withoutSourceMap(text: string): string {
  return text.replace(/^\/\/# sourceMappingURL=.*\n?/m, "");
}

describe("vendored browser libraries", () => {
  for (const { pkg, file, source } of VENDORED) {
    it(`vendor/${file} is the installed ${pkg} build`, () => {
      const pkgDir = join(__dirname, "..", "..", "..", "node_modules", pkg);
      const expected = withoutSourceMap(readFileSync(join(pkgDir, source), "utf8"));
      const vendored = readFileSync(join(__dirname, "vendor", file), "utf8");
      expect(vendored === expected, `re-vendor ${pkg}: copy node_modules/${pkg}/${source} to vendor/${file}`).toBe(true);
    });
  }
});
