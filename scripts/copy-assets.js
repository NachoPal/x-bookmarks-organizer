// Copy the static web viewer assets into dist/ after the TypeScript build,
// since `tsc` only emits .js files.
const fs = require('node:fs');
const path = require('node:path');

const src = path.join(__dirname, '..', 'src', 'web', 'public');
const dest = path.join(__dirname, '..', 'dist', 'web', 'public');

// Recursive so nested asset directories (e.g. public/fixtures/) are copied too.
fs.cpSync(src, dest, { recursive: true });
console.log(`Copied web assets -> ${path.relative(process.cwd(), dest)}`);
