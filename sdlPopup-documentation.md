# sdlPopup — Squarespace Popup Plugin Documentation

A Squarespace popup plugin that fetches and displays content from other pages on your site — supporting full pages, individual sections, or single blocks — inside a styled modal overlay.

---

## Table of Contents

1. [Overview](#overview)
2. [Installation](#installation)
3. [How It Works](#how-it-works)
4. [Trigger Link Syntax](#trigger-link-syntax)
5. [Selector Targeting](#selector-targeting)
6. [Default Settings](#default-settings)
7. [Custom Settings](#custom-settings)
8. [CSS Custom Properties](#css-custom-properties)
9. [Lifecycle Hooks](#lifecycle-hooks)
10. [Custom Events](#custom-events)
11. [Preload & SEO Mode](#preload--seo-mode)
12. [Content Initialization](#content-initialization)
13. [Animation](#animation)
14. [Video Auto-Play](#video-auto-play)
15. [Error Handling](#error-handling)
16. [Scroll Freeze & Scrollbar Compensation](#scroll-freeze--scrollbar-compensation)
17. [DOM Structure](#dom-structure)
18. [CSS Classes Reference](#css-classes-reference)
19. [Dependencies](#dependencies)
20. [Notes & Constraints](#notes--constraints)

---

## Overview

`sdlPopup` is a class-based JavaScript plugin for Squarespace. It intercepts specially formatted anchor links (`#sdl-popup=...`) and opens the target content in a fixed-position modal overlay, fetching and rendering content from other pages on demand. Content is cached after the first fetch so repeat opens are instant.

---

## Installation

1. Add `plugin.css` to your Squarespace site via **Design → Custom CSS** or a Code Block.
2. Add `plugin.js` to your site via **Settings → Advanced → Code Injection → Footer**, or a Code Block set to display site-wide.
3. The plugin self-initializes on load: `window.sdlPopup = new sdlPopup()` — no manual call needed.
4. The plugin guard (`if (typeof sdlPopup === "undefined")`) prevents duplicate initialization if the script is loaded more than once.

---

## How It Works

1. The plugin listens for all `click` events on `document.body`.
2. When a click is detected on a qualifying anchor link (matching the `#sdl-popup=` prefix formats), it prevents the default navigation.
3. It parses the link href to extract a **URL** and optional **selector**.
4. It fetches the `#sections` fragment of the target URL (via `sdl$.getFragment`).
5. Fetched content is initialized (Squarespace lifecycle, images, embed blocks, third-party plugins, code blocks) inside a hidden temporary container appended to the last section on the page.
6. The initialized content is cached in a `Map` keyed by URL, so subsequent opens skip the fetch.
7. If a selector is provided, only the matching element is shown; otherwise the full page content is shown.
8. The overlay and container are displayed with an optional fade animation.
9. Closing restores the DOM exactly as it was before (content moved back to its original parent/position).

---

## Trigger Link Syntax

Links must use one of four supported href prefixes. Everything after the prefix is treated as the **path + optional selector**.

| Prefix | Example |
|---|---|
| `#sdl-popup=` | `#sdl-popup=/about` |
| `#sdlpopup=` | `#sdlpopup=/about` |
| `/#sdl-popup=` | `/#sdl-popup=/about` |
| `/#sdlpopup=` | `/#sdlpopup=/about` |

The `/#` variants are useful in Squarespace editors where a bare `#` prefix may be stripped or cause issues.

### Examples

| Link href | Behavior |
|---|---|
| `#sdl-popup=/about` | Opens the full `/about` page content |
| `#sdl-popup=/about#team-section` | Opens `/about`, displays only the `#team-section` element |
| `#sdl-popup=/shop/product-page.fe-block-abc123` | Opens `/shop/product-page`, displays only the `.fe-block-abc123` element |
| `#sdl-popup=/contact[data-section-id="abc123"]` | Opens `/contact`, displays only the section with that data attribute |
| `#sdl-popup=https://youtu.be/VIDEO_ID` | Opens a YouTube / Vimeo / Loom / Wistia video as an auto-playing embed |
| `#sdl-popup=https://cdn.example.com/photo.jpg` | Opens an image full-size (requested at `?format=2500w` for Squarespace images) |
| `#sdl-popup=https://example.com` | Opens any external page inside an iframe |

### Content types

The target is auto-classified:

- **Internal page / section / block** — fetched via `?format=html`, initialized (forms, galleries, code/embed blocks, website components) and displayed.
- **Image** (`.jpg/.jpeg/.png/.gif/.webp/.svg`) — shown full-size in the popup.
- **Video embed** (YouTube, Vimeo, Loom, Wistia) — shown in a responsive 16:9 iframe and auto-played.
- **Any other external URL** — shown in an iframe.

### Video lifecycle

Any video in a popup — Squarespace native `<video>` blocks **and** embedded players (YouTube/Vimeo/Loom/Wistia) — is **paused and rewound when the popup closes**, and **starts again from the beginning** the next time it opens. Embedded players are stopped by blanking the iframe `src` (the only reliable way to halt YouTube/Vimeo audio) and reloaded fresh on reopen.

---

## Selector Targeting

After the URL, three targeting formats are supported:

### 1. ID Selector (`#`)
Splits on `#` — the fragment becomes `#id-name`.

```
/page-url#my-section-id
```

### 2. Fluid Engine Block (`.fe-`)
Splits at the first `.fe-` occurrence.

```
/page-url.fe-block-xxxxxxxxxxxxxxxxxxxxxxxx
```

### 3. Data Section ID (`[data-section-id=`)
Splits at the first `[data-section-id=` occurrence.

```
/page-url[data-section-id="xxxxxxxxxxxxxxxxxxxxxxxx"]
```

### No Selector
If none of the above patterns are found, the full URL is used and the entire fetched `#sections` content is displayed in the popup.

**Color Theme Inheritance:** When displaying a single block/section, the plugin reads the `data-section-theme` from the block's closest parent `<section>` and applies it to the block itself, preserving theme colors.

---

## Default Settings

```js
window.sdlPopupSettings = {
  openAnimation: "fade",          // "fade" | null/any other value = instant
  openAnimationDuration: 300,     // ms — duration of fade in/out
  closeOnOverlayClick: true,      // click outside container closes popup
  closeOnEscape: true,            // Escape key closes popup
  closePlacement: "content",      // "content" = close button inside container
                                  // any other value = close button inside overlay
  maxWidth: "800px",              // CSS value; sets --sdl-popup-width
  maxHeight: "80vh",              // CSS value; sets --sdl-popup-max-height
  zIndex: 9999,                   // z-index of overlay
  debugLoading: false,            // if true, stops after showing overlay/loader — no fetch
  preloadContent: false,          // if true, fetches all popup URLs on init
  loadingEl: `<div class="loading"></div>`,  // inner HTML of the loading indicator
  hooks: {
    beforeInit: [],
    afterInit: [],
    beforeOpenPopup: [],
    afterOpenPopup: [],
    beforeClosePopup: [],
    afterClosePopup: [],
  },
};
```

> **Note:** `maxWidth` and `maxHeight` in `defaultSettings` are reference values. The actual popup dimensions are controlled by the CSS custom properties `--sdl-popup-width` and `--sdl-popup-max-height` defined in `:root`.

---

## Custom Settings

Override any default by declaring a global settings object **before** the plugin script loads:

```html
<script>
  window.sdlPopupSettings = {
    openAnimation: "fade",
    openAnimationDuration: 400,
    closeOnOverlayClick: false,
    closeOnEscape: true,
    closePlacement: "overlay",
    preloadContent: true,
    loadingEl: `<div class="my-custom-spinner"></div>`,
    hooks: {
      afterOpenPopup: [
        function() {
          console.log("Popup opened:", this.activePopup);
        }
      ]
    }
  };
</script>
```

Settings are deep-merged with defaults, so you only need to specify keys you want to override.

---

## CSS Custom Properties

All visual aspects of the popup are controlled via CSS custom properties defined in `:root`. Override any of these in your site's Custom CSS.

### Layout

| Property | Default | Description |
|---|---|---|
| `--sdl-popup-width` | `800px` | Max width of the popup container |
| `--sdl-popup-max-height` | `80vh` | Max height of the popup container |

### Overlay

| Property | Default | Description |
|---|---|---|
| `--sdl-popup-overlay-opacity` | `0.5` | Opacity of the dark overlay background |
| `--sdl-popup-overlay-color` | `hsla(0, 0%, 0%, 1)` | Color of the overlay background |
| `--sdl-popup-overlay-blur` | `5px` | Backdrop blur amount behind the overlay |

### Container

| Property | Default | Description |
|---|---|---|
| `--sdl-popup-border` | `initial` | Border of the popup container |
| `--sdl-popup-shadow` | `0 0 10px rgba(0,0,0,0.3)` | Box shadow of the popup container |
| `--sdl-popup-border-radius` | `5px` | Border radius of the popup container |

### Close Button

| Property | Default | Description |
|---|---|---|
| `--sdl-popup-close-color` | `white` | SVG stroke color of the × icon |
| `--sdl-popup-close-bg` | `hsla(0,0%,0%,.5)` | Background color of the close button |
| `--sdl-popup-close-blur` | `15px` | Backdrop blur of the close button |
| `--sdl-popup-close-thickness` | `2px` | Stroke width of the × icon |
| `--sdl-popup-close-border` | `none` | Border of the close button |
| `--sdl-popup-close-offset` | `10px` | Distance from top-right corner of container |
| `--sdl-popup-close-size` | `30px` | Width and height of the close button |
| `--sdl-popup-close-padding` | `6px` | Padding inside the close button |

### Loading Indicator

| Property | Default | Description |
|---|---|---|
| `--sdl-popup-loading-color` | `var(--accent-hsl)` | Spinner color (uses Squarespace accent color by default) |

### Single Block Padding

| Property | Default | Description |
|---|---|---|
| `--sdl-popup-single-padding` | `17px` | Padding applied to single non-image/video blocks in popup |

---

## Lifecycle Hooks

Hooks are arrays of callback functions that fire at specific points in the popup lifecycle. They are called with `this` bound to the plugin instance.

### Available Hooks

| Hook | When it fires | Args passed |
|---|---|---|
| `beforeInit` | Before the plugin initializes | none |
| `afterInit` | After init completes (including preload if enabled) | none |
| `beforeOpenPopup` | Before a popup begins opening | `url` |
| `afterOpenPopup` | After popup content is displayed | `url` |
| `beforeClosePopup` | Before popup begins closing | active popup URL |
| `afterClosePopup` | After popup is fully closed | none |

### Usage

```js
window.sdlPopupSettings = {
  hooks: {
    beforeOpenPopup: [
      function(url) {
        console.log("Opening popup for:", url);
      }
    ],
    afterClosePopup: [
      function() {
        console.log("Popup closed");
      }
    ]
  }
};
```

Multiple callbacks per hook are supported — add them as additional array items.

---

## Custom Events

The plugin also dispatches `CustomEvent`s on `document` at the same lifecycle points, with additional context in `event.detail`.

| Event Name | Detail payload |
|---|---|
| `sdlPopup:beforeInit` | `{}` |
| `sdlPopup:afterInit` | `{}` |
| `sdlPopup:beforeOpenPopup` | `{ url, selector, el }` |
| `sdlPopup:afterOpenPopup` | `{ url, selector, el }` |

### Usage

```js
document.addEventListener("sdlPopup:afterOpenPopup", function(e) {
  console.log("Popup opened:", e.detail.url);
  console.log("Selector:", e.detail.selector);
  console.log("Overlay element:", e.detail.el);
});
```

---

## Preload & SEO Mode

When `preloadContent: true` is set, the plugin:

1. On `init`, scans the page for all qualifying popup links.
2. Fetches and initializes each unique popup URL in the background.
3. Caches results so the first open is instant.
4. Creates an **SEO container** — a visually hidden `div.sdl-popup-seo-container` appended to `#siteWrapper` — where preloaded content lives in the DOM (`aria-hidden="true"`, clipped to 1×1px). This keeps content accessible to crawlers while hidden from users.

> If `preloadContent` is `false` (default), content is only fetched on first open. The SEO container is not created.

---

## Content Initialization

Before displaying fetched content, the plugin runs a full initialization sequence inside a temporary hidden container (`div.temp-popup-container`) appended to the last page section:

1. `sdl$.initializeAllPlugins()` — initializes all registered SDL plugins
2. `sdl$.reloadSquarespaceLifecycle(tempContainer)` — triggers Squarespace's block lifecycle
3. `sdl$.initializeCodeBlocks(tempContainer)` — initializes code blocks (if available)
4. `sdl$.initializeEmbedBlocks(tempContainer)` — initializes embed blocks (if available)
5. `sdl$.initializeThirdPartyPlugins(tempContainer)` — initializes third-party plugins (if available)

After initialization, the temp container is removed from the DOM and the initialized content is cached and ready for display.

**Last section detection** is adaptive and tries four fallback strategies:
- `#sections > section:last-of-type .content-wrapper`
- `#page-regions > section:last-of-type .content-wrapper`
- Last `.page-section` in `#sections`
- `#page .system-page` (for system pages like 404)

The CSS rule `.temp-popup-container` inside the last section gets `z-index: -1; position: absolute` to keep it hidden during initialization.

After content is shown, the plugin also calls:
- `this.loadAllImages(content)` — triggers Squarespace's `ImageLoader` for lazy images
- `this.queueLayoutRefresh()` — calls `Squarespace.initializeLayoutBlocks` for gallery/layout blocks
- `Squarespace.initializeSummaryV2Block(Y, Y.one(this.overlay))` — initializes Summary V2 blocks

---

## Animation

The `openAnimation` setting controls how the popup appears and disappears.

### `"fade"` (default)

- **Open:** container fades in from `opacity: 0` to `opacity: 1` over `openAnimationDuration` ms.
- **Close:** container and overlay both fade out over `openAnimationDuration` ms, then the popup is torn down.
- Layout refresh is called twice: once immediately and once after animation completes (`duration + 20ms`), ensuring gallery blocks render correctly.

### No animation (any other value or `null`)

- **Open:** container appears instantly (`opacity: 1`).
- **Close:** popup tears down immediately.

---

## Video Auto-Play

When the popup content consists of a **single video block** (`.sqs-block-video` or `.fe-block .sqs-block-video` as the direct child), the plugin auto-plays it after open:

1. Attempts to play with sound.
2. If auto-play with sound is blocked by the browser, falls back to muted auto-play.
3. If the `<video>` element isn't available yet, retries up to 10 times at 100ms intervals.
4. Uses the `canplay` event to play as soon as the video is ready.

This behavior fires from `afterOpenPopup()` automatically.

---

## Error Handling

If content fetch fails or the specified selector is not found in the fetched content:

1. An error element (`div.sdl-popup-error`) is rendered inside the popup with:
   - An "Error Loading Content" heading
   - The problematic URL
   - The selector (if one was specified)
2. The error content is cached in the popup map (preventing repeated failed fetches for the same URL).
3. The popup still opens and displays the error message.

### Error CSS

```css
.sdl-popup-error {
  padding: 20px;
}
.sdl-popup-error > *:first-child { margin-top: 0; }
.sdl-popup-error > *:last-child  { margin-bottom: 0; }
```

---

## Scroll Freeze & Scrollbar Compensation

When a popup opens, the plugin:

1. Measures the scrollbar width: `window.innerWidth - document.documentElement.clientWidth`.
2. Saves the current `window.scrollY` position.
3. Disables `scroll-behavior: smooth` on `<html>` to prevent animation conflicts.
4. Adds `sdl-popup-open` class to `<body>`, which applies:
   - `overflow: hidden`
   - `position: fixed`
   - `width: calc(100% - var(--sdl-popup-freeze-scroll-padding-right))`
   - `top: var(--sdl-popup-freeze-scroll-top)` (negative scroll offset to maintain visual position)
   - `margin-right: var(--sdl-popup-freeze-scroll-padding-right)` (compensates for scrollbar disappearance)

When the popup closes:

1. `sdl-popup-open` is removed from `<body>`.
2. `window.scrollTo(0, savedScrollPosition)` restores the scroll position.
3. CSS custom properties are cleaned up in a `requestAnimationFrame` to prevent layout flicker.
4. `scroll-behavior` is restored to its original value after a 50ms delay.
5. The container's `scrollTop` and `scrollLeft` are reset to `0` for the next open.

---

## DOM Structure

The plugin appends the following structure to `#siteWrapper` on init:

```html
<div class="sdl-popup-overlay">        <!-- Fixed full-screen overlay (display:none until open) -->
  <!-- ::before pseudo-element = semi-transparent bg color -->

  <div class="sdl-popup-container">    <!-- Centered modal box -->
    <button class="sdl-popup-close">   <!-- Close button (SVG ×) — inside container by default -->
      <svg>...</svg>
    </button>
    <div class="sdl-popup-content">    <!-- Fetched page content goes here -->
      <!-- Page sections / blocks rendered here -->
    </div>
  </div>

  <div class="sdl-popup-loading">      <!-- Centered loading indicator -->
    <div class="loading"></div>        <!-- Default spinner (customizable via loadingEl setting) -->
  </div>

</div>
```

> If `closePlacement` is not `"content"`, the close button is appended to the overlay directly (outside the container).

When `preloadContent: true`, an additional hidden element is appended to `#siteWrapper`:

```html
<div class="sdl-popup-seo-container" aria-hidden="true">
  <!-- Preloaded popup content (visually hidden, accessible to crawlers) -->
</div>
```

---

## CSS Classes Reference

| Class | Element | Purpose |
|---|---|---|
| `.sdl-popup-overlay` | `div` | Full-screen fixed overlay |
| `.sdl-popup-container` | `div` | Centered modal content box |
| `.sdl-popup-close` | `button` | Close button (×) |
| `.sdl-popup-content` | `div` | Wrapper for the fetched page content |
| `.sdl-popup-loading` | `div` | Centered loading indicator wrapper |
| `.sdl-popup-error` | `div` | Error message shown on fetch failure |
| `.sdl-popup-fade-in` | any | Utility fade-in class (opacity transition) |
| `.sdl-popup-fade-in.sdl-popup-active` | any | Active state — `opacity: 1` |
| `.sdl-popup-seo-container` | `div` | Hidden SEO container for preloaded content |
| `.sdl-popup-open` | `body` | Applied to body when popup is open (freezes scroll) |
| `.temp-popup-container` | `div` | Temporary hidden container used during content init |

### `data-active-popup` Attribute

`document.body.dataset.activePopup` is set to the `url + selector` string while a popup is open, and cleared (`null`) on close. Useful for CSS targeting or external JS.

---

## Dependencies

**No external dependency.** The `sdl$` utility library is now **bundled inside `popup.js`** — there is nothing extra to load. (If a real `sdl$` is already present on the page from another SDL plugin, its methods are reused; anything missing falls back to the bundled implementations.) The bundled methods are:

| Method | Purpose |
|---|---|
| `sdl$.deepMerge(target, ...sources)` | Deep-merges settings objects |
| `sdl$.getFragment(url, selector)` | `fetch` + `DOMParser` + `document.importNode` of the matched fragment |
| `sdl$.initializeAllPlugins()` | Runs any functions in the optional `sdl$.registeredPlugins` array |
| `sdl$.reloadSquarespaceLifecycle(el)` | Runs Squarespace block lifecycle on a container (guarded; resolves a Promise) |
| `sdl$.initializeCodeBlocks(el)` | Re-executes scripts inside `.sqs-block-code` / `.code-block` |
| `sdl$.initializeEmbedBlocks(el)` | Re-executes embed scripts + nudges Instagram / Twitter / Facebook SDKs |
| `sdl$.initializeThirdPartyPlugins(el)` | Re-executes remaining inline scripts + emits `sdl:contentReady` |

> Script re-execution is idempotent (each `<script>` is flagged once re-run) and only fires when the content is connected to the live DOM — which is why fetched content is temporarily mounted into the last page section during initialization.

It still relies on standard Squarespace runtime globals that exist on every live site (all calls are existence-guarded):
- `Squarespace.initializeSummaryV2Block(Y, node)`
- `Squarespace.initializeLayoutBlocks(Y, node)`
- `window.ImageLoader` or `window.Squarespace.ImageLoader`
- YUI (`Y`) for Squarespace initialization calls

---

## Notes & Constraints

- **Single instance:** Only one `sdlPopup` instance is created (`window.sdlPopup`). The guard at the top of the file prevents re-initialization.
- **Content caching:** Popup content is cached per URL (not per URL+selector). If two links target the same URL with different selectors, the page is only fetched once.
- **DOM ownership:** When a popup opens with a selector, the matching DOM node is physically moved into `.sdl-popup-content` and moved back on close — it is not cloned. This means Squarespace event listeners attached to that node are preserved.
- **Full-page mode:** When no selector is used, all children of the fetched `#sections` element are moved into `.sdl-popup-content` and returned to the cached container on close.
- **Nested scrolling:** The `.sdl-popup-container` has `overflow-y: auto`, allowing tall content to scroll within the popup.
- **Video in popups:** The padding-bottom override (`padding-bottom: unset !important`) on native video embed wrappers inside the overlay ensures video blocks render at their natural aspect ratio.
- **Content-fit images:** Images using the `.content-fit` class inside the popup are capped to `--sdl-popup-max-height` and rendered with `position: relative` to prevent overflow issues.
- **First section padding:** The first `.page-section` inside `.sdl-popup-content` has its `padding-top` removed to prevent unwanted top spacing.
- **`debugLoading`:** Setting `debugLoading: true` is useful during development — it shows the overlay and spinner but never fetches content, letting you style the loading state.
