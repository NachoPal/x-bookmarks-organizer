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

## Category tree coloring (issue #15)

Each root category gets a distinct, stable soft color (hashed from its id via
`tree-color.js`); depth alternates between two shades of that color so root, child,
and grandchild bands read at a glance. Same seeded dataset (4 roots, 3-4 levels deep),
never real bookmarks.

| File | What it shows |
| --- | --- |
| `tree-colors-light.png` | **Light mode.** Four roots, each a distinct soft hue; each child row a lighter tint of its root's hue, an expanded grandchild returning to the root's own shade. |
| `tree-colors-dark.png` | **Dark mode.** Muted dark tints per root; selected-category highlight and count badges stay legible on top. |
| `tree-colors-search-match.png` | **Category search active.** The matched-substring highlight (`<mark>`) still pops over the colored rows. |

## Article reader (issue #4)

A card whose post links to an external article gets a "Read" affordance that opens the
extracted article (title + sanitized body, server-fetched via readability) in an in-app
modal, with a graceful message + link-out for anything that can't be read. Seeded with
`npm run seed:dev`'s "Reader View Demo" category: one bookmark links to a fixture article
page served locally (`src/web/public/fixtures/sample-article.html`, fetched fully
offline), the other to a domain reserved by RFC 2606 to never resolve - never real data.

| File | What it shows |
| --- | --- |
| `reader-light.png` | **Light mode.** The reader modal showing the extracted title, site chrome (nav/ads/scripts) stripped, and comfortable reading measure/line-height; "View original" link in the header. |
| `reader-dark.png` | **Dark mode.** Same article, dark surfaces and text via the token layer. |
| `reader-fallback.png` | **Graceful failure.** An unreachable link (`.invalid` domain) shows a clear message and a link to the original - never a blank or stuck panel. |
| `reader-mobile.png` | **~390px.** The reader becomes a full-screen panel; header wraps the title above the actions; reading measure and line-height hold. |

## Card + sidebar polish (issues #21, #22)

Read/unread chips are a colored dot + short label with no date, in distinct colors; the
delete/Summarize/Read/Open-on-X actions sit in a single row above the post; the author
line is gone (the embed, or the fallback's own byline, carries it); the post is centered
and the card is sized to its natural width instead of stretching full-width. The sidebar
now starts with every root category collapsed, a read-state toggle updates only the
affected counters in place (no whole-tree re-render/flicker, scroll and expand state
preserved), and a persisted toggle switches the per-root category coloring on/off. The
reader and summary modals are now near-full-screen with a comfortable responsive margin.
Same seeded dataset (`npm run seed:dev`), never real bookmarks.

| File | What it shows |
| --- | --- |
| `sidebar-collapsed-light.png` | **Initial load, light.** Every root category collapsed; the Colors toggle in the sidebar header. |
| `cards-light.png` | **Light.** Action row (chip, Summarize, Read, Open on X, delete) above each post; no author line; posts centered and sized to their own width. |
| `cards-dark.png` | **Dark.** Same cards; Read (green dot) vs. Unread (blue dot) chips stay distinct and legible. |
| `sidebar-colors-off-dark.png` | **Category-color toggle off, dark.** Tree falls back to plain indentation + guide lines; selection highlight still reads clearly. |
| `reader-modal-fullscreen.png` | **Reader modal.** Near-full-screen with a comfortable margin on all sides; content scrolls inside. |
| `narrow-collapsed.png` | **~390px, initial load.** Sidebar drawer closed by default. |
| `narrow-drawer-sidebar.png` | **~390px, drawer open.** Roots collapsed; Colors toggle and close button fit the header row. |
| `narrow-card.png` | **~390px, card layout.** Action row wraps into two lines (chip/Summarize/Read, then Open on X/delete); fallback cards show their own author byline. |

## Viewer tweaks: uniform cards, no chip shift, colors off, theme toggle (issue #30)

Every bookmark card now renders at the same fixed-width column regardless of its post's
length; the read/unread chip reserves the wider "Unread" label's width so toggling it
causes zero reflow of the row's other controls; the category-color toggle now defaults
off (a plain tree) instead of on; and a new sun/moon control in the top menu bar sets an
explicit light/dark preference (persisted), overriding the system default. Same seeded
dataset (`npm run seed:dev`, posts of very different lengths), never real bookmarks.

| File | What it shows |
| --- | --- |
| `uniform-cards.png` | **Light, colors off (new default).** Cards of very different post lengths (a one-line note next to multi-line posts) all render at the same fixed width. |
| `colors-on.png` | **Colors toggled on.** The per-root tree tint from issue #15, still available via the sidebar toggle. |
| `theme-light.png` | **Light theme, explicit.** The header toggle shows a sun icon (click switches to dark). |
| `theme-dark.png` | **Dark theme, explicit.** The header toggle shows a moon icon (click switches to light); preference persists across reloads. |

## Article previews + gated "Read article" affordance (issue #26)

A bookmark whose post links a confirmed article now shows a compact link-preview card
(thumbnail + title/description/domain, X-style) below the embed; clicking it opens the
same in-app reader as the "Read article" button. Both the preview card and the "Read
article" control are gated to posts whose link actually resolved to an article - a plain
post, or one whose link failed to resolve as an article, shows neither. Seeded via
`npm run seed:dev`'s "Reader View Demo" category, which now covers all three states
(confirmed article w/ full metadata, confirmed article w/ only a title, and a dead link),
entirely offline - never real bookmarks.

| File | What it shows |
| --- | --- |
| `link-preview-light.png` | **Light.** Full preview card (thumbnail, title, description, domain via `og:site_name`) for a bookmark with a confirmed article link; "Read article" in the action row. |
| `link-preview-dark.png` | **Dark.** Same three demo cards (sparse-metadata fallback, gated dead link, full preview) in dark theme. |
| `non-article-post.png` | **Plain posts, light.** Cards with no link in the post text show no preview and no "Read article" control. |
| `gating-and-fallback.png` | **Gating + graceful fallback, light.** A dead-link post (no preview, no control) next to a confirmed article with only a title cached (title-only preview, no image/description). |

## Top bar, settings gear + text size, sidebar overlay (issues #53, #37, #42)

The header is now a single sticky top bar in three regions - the animated
categories-menu toggle (left), the selected category's title + counts on one line
(center), and the controls (right: read-state filter, search, category colors,
light/dark, settings gear). The explanatory blurb is gone. The categories sidebar is
an overlay drawer at *every* width, so the content column stays centered and never
shifts when it opens or closes. The gear opens a settings popover holding a persisted
post-size control (Small / Medium / Large) plus the theme and category-color switches.
Same seeded dataset (`npm run seed:dev`), never real bookmarks.

| File | What it shows |
| --- | --- |
| `topbar-light-desktop.png` | **Desktop, light.** The three-region bar: hamburger + last-sync, centered `… › Agentic Workflows & Tool Use · 46 bookmarks · 30 unread` on one line, filter/search/colors/theme/gear on the right. Sidebar collapsed, content column centered. |
| `topbar-dark-desktop.png` | **Desktop, dark.** Same bar on dark surfaces; the theme icon is the moon. |
| `sidebar-open-overlay-light.png` | **Drawer open, light.** The toggle icon has animated to an X; the drawer overlays the content and the card column has **not** moved (compare against the collapsed shot). |
| `sidebar-open-overlay-dark.png` | **Drawer open, dark.** Same, dark theme. |
| `settings-panel-light.png` | **Settings popover, light.** Post size (Small/Medium/Large), Dark theme and Category colors switches; the gear shows its open state. |
| `settings-panel-dark.png` | **Settings popover, dark.** Dark theme switch on; both bar and panel controls stay in sync. |
| `topbar-narrow-400-light.png` | **~400px, light.** The bar sheds last-sync, the counts and the ancestor crumb; toggle + truncated title + filter + search + gear still fit one line with no overflow. |
| `topbar-narrow-400-dark.png` | **~400px, dark.** Same, dark theme. |
| `sidebar-overlay-narrow-400-dark.png` | **~400px, drawer open.** Full-height overlay drawer with its scrim; the content behind it has not reflowed. |

## Post size — resizing the post, not the app chrome (issue #37, follow-up)

The settings control was reworked: scaling the viewer's own text is what the browser's zoom
already does, so the setting now resizes the **post card**, the embedded X post included. It
drives `--post-scale`, which is applied as `zoom` on `.bookmark-card` — `zoom` rather than
`transform: scale` because it scales the layout box as well as the rendering (so scaled cards
leave no gap and never overlap), it re-renders instead of re-rasterizing (so text stays crisp),
and Chrome carries it into the cross-origin X embed, which is the only way to reach inside a
widget X owns. In the same pass the sidebar's redundant close button was removed — the top bar's
animated menu toggle is the single close control. Captured against the seeded dataset, on the
category that contains a real public post id so a live X embed is in frame.

| File | What it shows |
| --- | --- |
| `post-size-small.png` | **Small (0.875), light.** Cards and the live X embed render smaller; the top bar and sidebar are untouched — only the posts scale. |
| `post-size-medium.png` | **Medium (1), light.** The unscaled baseline. |
| `post-size-large.png` | **Large (1.15), light.** The same embedded tweet renders larger — avatar, text and the reply row all scale, and stay crisp. |
| `post-size-small-dark.png` | **Small, dark.** Same behavior on dark surfaces. |
| `post-size-large-dark.png` | **Large, dark.** |
| `post-size-large-narrow-400.png` | **Large at ~400px.** The card cannot grow wider than the column, so the post content scales inside the same footprint — no horizontal overflow at any step. |
