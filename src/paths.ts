import path from 'node:path';

/**
 * The package's own root - the directory holding `package.json`, `.env` and
 * `data/`. This file sits one level below it both as `src/paths.ts` (tests)
 * and as `dist/paths.js` (the built CLI), so the answer is the same either
 * way and never depends on the directory the app happens to be started from.
 *
 * Anything the app reads or writes "in the project" resolves from here, never
 * from `process.cwd()`: a `.env` in whatever directory `xbo` is launched from
 * is not the owner's file, and a cwd-relative default database silently
 * serves an empty library when started from the wrong place.
 */
export const PACKAGE_ROOT = path.resolve(__dirname, '..');
