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

## Viewer filters — category search + read-state bar

Visual evidence for the two filtering controls: a category search box in the sidebar
and a read-state segmented bar (Unread / Read / All) above the bookmark cards. Same
seeded dataset, never real bookmarks.

| File | What it shows |
| --- | --- |
| `wide-01-category-selected.png` | **Desktop.** Search box atop the sidebar; read-state bar (default **All**) above the cards; count `20 bookmarks · 13 unread`. |
| `wide-02-unread-filter.png` | **Unread filter active.** Only unread cards shown; count reads `13 unread · 20 total`. |
| `wide-03-category-search.png` | **Category search `invest`.** Tree pruned to matches plus their ancestor path; matched substring highlighted; clear (×) button visible. |
| `narrow-01-filter-bar.png` | **~390px.** Read-state bar fits the narrow content column above stacked cards. |
| `narrow-02-category-search-drawer.png` | **~390px, drawer open.** Search filters the tree inside the off-canvas drawer; a 3-level-deep match (`Agentic Workflows & Tool Use`) keeps its full ancestor path. |
| `wide-04-dark-read-filter-search.png` | **Dark mode.** Both filters active together (search `engine` + **Read**); highlight and segmented control render correctly on dark surfaces. |

## Embed loading spinner (issue #2)

Visual evidence that each X post embed slot shows a skeleton + spinner immediately and
reveals only the finished result - the rendered embed once widgets.js reports it done, or
the text+link fallback for a deleted/protected post - instead of flashing raw text first.
Same seeded dataset, never real bookmarks (one card uses the public, long-lived post id
`20` so a live embed renders; the rest fall back).

| File | What it shows |
| --- | --- |
| `embed-spinner-loading-light.png` | **Desktop, loading.** Every embed slot shows the shimmering skeleton with a centered spinner - no raw-text flash. |
| `embed-spinner-resolved-light.png` | **Desktop, resolved.** The embeddable post reveals the official X embed; non-embeddable posts resolve to the text+link fallback (never a stuck spinner). |
| `embed-spinner-loading-dark.png` | **Dark mode, loading.** Skeleton + spinner render on dark surfaces via the token layer. |
| `embed-spinner-resolved-dark.png` | **Dark mode, resolved.** Embed + fallbacks in dark mode. |
| `embed-spinner-loading-mobile.png` | **~390px, loading.** Spinner treatment holds in the narrow single-column layout after the drawer closes on category select. |
