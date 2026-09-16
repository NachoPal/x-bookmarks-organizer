# Viewer UI redesign — before / after

Visual evidence for the local web viewer redesign (collapsible sidebar + contained
content). Captured against a seeded sample dataset (`npm run seed:dev`), never real
bookmarks.

| File | What it shows |
| --- | --- |
| `01-before-wide-overflow.png` | **Before.** Category labels and count/unread badges render outside the sidebar box (`14 · 9`, `3 · 2`, `5 · 4` float past the right border). |
| `02-after-wide-selected.png` | **After, desktop.** Full-height app shell, sidebar with wrapping labels fully contained, selected category highlighted, bookmark cards contained with read/unread states. |
| `03-after-wide-collapsed.png` | **After, sidebar collapsed** via the header toggle; content centers on a readable measure. |
| `04-after-narrow-content.png` | **After, ~390px.** Sidebar is an off-canvas drawer (closed by default); content is fully contained. |
| `05-after-narrow-drawer.png` | **After, drawer open** with backdrop scrim and close button. |
| `06-after-dark.png` | **After, dark mode.** |
