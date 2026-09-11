# Seen · X Browsing History

**Languages:** [简体中文](README.md) · [English](README.en.md) · [Français](README.fr.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

Seen is a desktop Chrome/Edge Manifest V3 extension that remembers the posts you actually viewed on X (formerly Twitter). It stores data locally and lets you search and filter it from a panel docked to X's right column or from a standalone history page.

It solves a simple problem: a fast-moving X timeline makes it hard to find a post you just read. Seen does not use the X API, require another account, or upload browsing data.

## Features

### Records posts you really viewed

- A post is saved only after at least 50% is visible for the configured dwell time.
- Dwell time can be 0.8, 1, 1.5, or 2 seconds (1 second by default).
- Collection pauses when the tab loses focus, goes to the background, is paused, or shows DMs, Grok, or settings.
- Supports regular posts, long posts, quoted posts, images, video/GIF, and X Articles.
- Handles virtual lists, expanded text, lazy media, and React node reuse without losing richer data already saved.

### Find history inside X

The history button stays in the same vertical group as X's floating buttons. The panel docks to the right column without covering the main timeline.

- Search post text, authors, usernames, quoted text, and Article titles/summaries.
- Filter by all content, text, images, video/GIF, or Articles.
- Filter by a custom viewed-time range, or use Today / Last 7 days / Last 30 days.
- Date changes are drafts until Confirm; Cancel, outside click, and Esc restore the previous range.
- Stable pagination with Load more.
- Author names open the author's X profile; the post link opens the original post.
- Articles keep their cover, title, and summary card. Saved images keep their original aspect ratio.
- Relative times remain compact; hover shows the full date and time.
- While open, the panel receives history-change events and performs a low-frequency fallback check, so new posts appear without repeated redraws when nothing changed.

### Standalone history page

- Combine keyword, author, content type, viewed date, and sort order filters.
- Expand long posts and quoted content.
- Image previews are off by default and can be enabled in preferences.
- Delete one item, delete in bulk, clear history, or pause collection.
- Export and validated JSON import with de-duplication.
- Light, dark, and system themes.
- `Alt+Shift+H` opens the history page (also on macOS).

## Tech stack

- TypeScript
- Chrome Extension Manifest V3
- Dexie 4 + IndexedDB for local persistence
- esbuild
- Node.js Test Runner, tsx, and fake-indexeddb
- IntersectionObserver, MutationObserver, requestIdleCallback, and Web Workers

## How it works

1. The content script scans `article[data-testid="tweet"]` on X pages.
2. It extracts the post ID, author, timestamp, text, quote, media, and Article card.
3. IntersectionObserver starts a dwell timer when a post reaches the visibility threshold.
4. A qualified view becomes an event with an `eventId` and is queued in memory.
5. The service worker batches events and serially writes them to IndexedDB.
6. Search uses normalized text, author indexes, n-grams, and stable `[lastViewedAt+id]` cursors.
7. The inline panel refreshes every three seconds only when the count or newest view changes; background `history-changed` events provide immediate updates.

## Privacy and security

- Data stays in the current browser profile's IndexedDB.
- No remote API, analytics, account system, or upload endpoint.
- Media URLs are limited to `https://pbs.twimg.com`.
- Imported data is validated and rendered as escaped text.
- Clearing history or uninstalling removes local data; export a JSON backup first if needed.

## Installation

Requirements: Node.js 18+, Chrome 116+, or a compatible Edge version.

```bash
git clone https://github.com/DescLee/x-you-have-seen.git
cd x-you-have-seen
npm install
npm run build
```

Open `chrome://extensions` (or `edge://extensions`), enable Developer mode, choose **Load unpacked**, and select `dist/`. Allow the extension to access `x.com` and `twitter.com`, then refresh X.

To create a distributable archive:

```bash
npm run package
```

This creates `release/seen-0.1.0.zip` and its SHA-256 file.

## Development and validation

```bash
npm run typecheck
npm test
npm run build
npm run check
npm run package
```

Core tests cover visibility and dwell rules, merging and visit counts, multilingual search, media and Article cards, date filters, stable pagination, import/export, cleanup, and security boundaries. Browser scripts are in `scripts/qa-*.js`.

## Project layout

```text
src/       content collector, service worker, database, extraction, UI, workers
public/    history page, styles, and MV3 manifest
scripts/   build, package, browser QA, and performance scripts
tests/     core tests
dist/      loadable extension build
release/   ZIP and checksum output
```

## Known boundaries

- Designed for desktop X pages; mobile X is outside the supported scope.
- X DOM changes may require selector updates in `src/extract.ts`.
- Images and Article covers depend on accessible `pbs.twimg.com` URLs.
- History is stored per browser profile and is not synced between devices.

## License

This project is licensed under the [Apache License 2.0](LICENSE). Copyright 2026 DescLee.

Use, modification, and redistribution, including commercial use, are permitted subject to the license terms. Redistribution requires retaining applicable notices, including a copy of the license, and identifying modified files. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Third-party dependencies retain their respective licenses.
