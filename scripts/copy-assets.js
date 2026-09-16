// Copy the static web viewer assets into dist/ after the TypeScript build,
// since `tsc` only emits .js files.
const fs = require('node:fs');
const path = require('node:path');

const src = path.join(__dirname, '..', 'src', 'web', 'public');
const dest = path.join(__dirname, '..', 'dist', 'web', 'public');

fs.mkdirSync(dest, { recursive: true });
for (const entry of fs.readdirSync(src)) {
  fs.copyFileSync(path.join(src, entry), path.join(dest, entry));
}
console.log(`Copied web assets -> ${path.relative(process.cwd(), dest)}`);
