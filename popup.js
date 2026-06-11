/* =========================================================================
   sdlPopup — Squarespace Popup Plugin
   Fetches & displays page / section / block content inside a modal overlay.

   No class / no constructor — single self-initializing IIFE.
   Configure via  window.sdlPopupSettings  (deep-merged with defaults).
   Depends on the sdl$ utility library (deepMerge, getFragment, lifecycle init).
   ========================================================================= */

if (!window.sdlPopup) {
  window.sdlPopup = (function () {
    "use strict";

    /* ====================================================================
       sdl$ — bundled utility library (no external dependency required).
       Everything the plugin needs to run on Squarespace lives in this file.

       If a real sdl$ is already on the page (e.g. another SDL plugin loaded
       it first), its methods are reused; anything missing falls back to the
       implementations below.
    ==================================================================== */
    const sdl$ = (function () {
      const existing = window.sdl$ || {};

      const safe = fn => {
        try { return fn(); }
        catch (e) { console.warn("[sdlPopup] util error:", e); }
      };

      const isPlainObject = v =>
        v && typeof v === "object" && !Array.isArray(v) &&
        (v.constructor === Object || Object.getPrototypeOf(v) === null);

      /* Recursive deep-merge of plain objects (arrays / primitives overwrite). */
      function deepMerge(target, ...sources) {
        sources.forEach(source => {
          if (!isPlainObject(source)) return;
          Object.keys(source).forEach(key => {
            const value = source[key];
            if (isPlainObject(value)) {
              if (!isPlainObject(target[key])) target[key] = {};
              deepMerge(target[key], value);
            } else {
              target[key] = value;
            }
          });
        });
        return target;
      }

      /* Fetch a page and return a deep-imported copy of the matched fragment.

         - Uses Squarespace's lean `?format=html` content endpoint.
         - Also carries the page's `#sectionThemesStyles` <style> (which lives
           outside #sections, in the page head) along with the fragment so that
           sections fetched from a *different* page keep their correct
           background/colour theming. Tagged `.sdl-popup-section-themes` and
           injected into <head> while the popup is open (see openPopup). */
      async function getFragment(url, selector) {
        const fetchUrl = url + (url.includes("?") ? "&" : "?") + "format=html";
        const response = await fetch(fetchUrl, { credentials: "same-origin" });
        if (!response.ok) throw new Error(`Fetch failed for "${url}" (${response.status})`);
        const html = await response.text();
        const doc = new DOMParser().parseFromString(html, "text/html");
        const found = selector ? doc.querySelector(selector) : doc.body;
        if (!found) throw new Error(`Selector "${selector}" not found at "${url}"`);
        const node = document.importNode(found, true);

        const themeStyles = doc.querySelector("#sectionThemesStyles");
        if (themeStyles) {
          const clone = document.importNode(themeStyles, true);
          clone.removeAttribute("id");
          clone.className = "sdl-popup-section-themes";
          node.appendChild(clone);
        }
        return node;
      }

      /* Re-execute <script> tags — parsed/imported markup never runs scripts.

         Runs SEQUENTIALLY (waits for each external script's onload before the
         next) so dependent embeds load in order, rewrites `document.write` so a
         block can't blow away the page, skips non-JS (JSON/template) scripts,
         and is idempotent (each <script> is flagged once it has been re-run).
         Returns a Promise that resolves when all scripts have run. */
      function executeScripts(container) {
        if (!container) return Promise.resolve();
        const scripts = Array.from(
          container.querySelectorAll("script:not([data-sdl-ran])")
        ).filter(s => {
          const t = s.getAttribute("type");
          return !t || t === "text/javascript" || t === "application/javascript";
        });

        return scripts.reduce(
          (chain, old) =>
            chain.then(
              () =>
                new Promise(resolve => {
                  const script = document.createElement("script");
                  Array.from(old.attributes).forEach(a =>
                    script.setAttribute(a.name, a.value)
                  );
                  script.setAttribute("data-sdl-ran", "");
                  if (old.src) {
                    // Resolve on load/error, with a timeout guard so a blocked
                    // or never-firing external script can't stall the chain.
                    let done = false;
                    const finish = () => { if (!done) { done = true; resolve(); } };
                    script.onload = script.onerror = finish;
                    setTimeout(finish, 5000);
                    script.src = old.src;
                    old.parentNode.replaceChild(script, old);
                  } else {
                    let code = old.textContent || "";
                    if (code.indexOf("document.write") !== -1) {
                      const id = "sdl-w-" + Math.random().toString(36).slice(2);
                      script.setAttribute("data-sdl-write", id);
                      code = code.replace(
                        /document\.write\s*\(/g,
                        `document.querySelector('[data-sdl-write="${id}"]').insertAdjacentHTML('beforebegin',`
                      );
                    }
                    script.textContent = code;
                    old.parentNode.replaceChild(script, old);
                    resolve();
                  }
                })
            ),
          Promise.resolve()
        );
      }

      /* Trigger Squarespace's responsive ImageLoader on lazy images
         (both data-src lazy images and images that have no src yet). */
      function loadImages(el) {
        const imageLoader = window.ImageLoader || window.Squarespace?.ImageLoader;
        if (!imageLoader || typeof imageLoader.load !== "function") return;
        (el || document).querySelectorAll("img[data-src], img:not([src])").forEach(img => {
          safe(() => imageLoader.load(img, { load: true }));
          img.classList.add("loaded");
        });
      }

      /* Run Squarespace's block lifecycle on a freshly inserted container. */
      function reloadSquarespaceLifecycle(el) {
        return new Promise(resolve => {
          const Sqs = window.Squarespace;
          const Y = window.Y;
          const node = Sqs && Y && Y.one ? Y.one(el) : null;
          if (Sqs && node) {
            safe(() => Sqs.initializeLayoutBlocks && Sqs.initializeLayoutBlocks(Y, node));
            safe(() => Sqs.initializeNativeVideo && Sqs.initializeNativeVideo(Y, node));
            safe(() => Sqs.initializeSummaryV2Block && Sqs.initializeSummaryV2Block(Y, node));
            safe(() => Sqs.initializeCommentLink && Sqs.initializeCommentLink(Y, node));
            safe(() => Sqs.initializeParallax && Sqs.initializeParallax(Y, node));
          }
          // NOTE: form blocks are intentionally NOT initialized here. This runs
          // on the detached/temp container; React form components must be
          // hydrated in their final location (see reinitializeForms call after
          // the popup opens) or they break when the DOM is moved.
          loadImages(el);
          safe(() => window.dispatchEvent(new Event("resize")));
          requestAnimationFrame(() => resolve());
        });
      }

      /* (Re)initialize Squarespace form blocks inside a container.

         Needed because the page's form controller only runs once on load and
         never sees AJAX-injected forms.

         Squarespace 7.1 forms are React "website components" — they are
         hydrated by `Squarespace.initializeWebsiteComponent`, NOT the legacy
         `initializeFormBlocks` (whose own source explicitly skips
         website-component forms). We call both so modern *and* classic forms
         render. Both are existence-guarded. */
      function reinitializeForms(scope) {
        if (!scope) return;
        const Y = window.Y;
        const Sqs = window.Squarespace;
        if (!Y || !Sqs) return;

        const hasComponentForm = scope.querySelector(
          '[data-definition-name="website.components.form"], .sqs-block-website-component'
        );
        const hasLegacyForm = scope.querySelector(
          ".sqs-block-form, .form-block, .sqs-block-newsletter, .newsletter-block"
        );
        if (!hasComponentForm && !hasLegacyForm) return;

        // 7.1 website-component (React) forms. Scans the document and hydrates
        // any unrendered form components — including freshly injected ones.
        if (typeof Sqs.initializeWebsiteComponent === "function") {
          safe(() => Sqs.initializeWebsiteComponent(Y));
        }
        // Legacy YUI form blocks (older sites). 2nd arg is the YUI app global.
        if (typeof Sqs.initializeFormBlocks === "function") {
          safe(() => Sqs.initializeFormBlocks(Y, Y));
        }
      }

      /* Re-init any registered SDL plugins (optional global registry). */
      function initializeAllPlugins() {
        const registry = (window.sdl$ && window.sdl$.registeredPlugins) || [];
        registry.forEach(fn => safe(() => typeof fn === "function" && fn()));
      }

      /* Code blocks: re-execute their embedded scripts (in order). */
      async function initializeCodeBlocks(el) {
        await executeScripts(el);
      }

      /* Embed blocks: re-execute scripts + nudge common social SDKs. */
      async function initializeEmbedBlocks(el) {
        await executeScripts(el);
        safe(() => window.instgrm && window.instgrm.Embeds.process());
        safe(() => window.twttr && window.twttr.widgets && window.twttr.widgets.load(el));
        safe(() => window.FB && window.FB.XFBML && window.FB.XFBML.parse(el));
      }

      /* Any remaining inline scripts + a hook for third-party integrations. */
      async function initializeThirdPartyPlugins(el) {
        await executeScripts(el);
        safe(() => el.dispatchEvent(new CustomEvent("sdl:contentReady", { bubbles: true })));
      }

      return {
        deepMerge: existing.deepMerge || deepMerge,
        getFragment: existing.getFragment || getFragment,
        reloadSquarespaceLifecycle: existing.reloadSquarespaceLifecycle || reloadSquarespaceLifecycle,
        reinitializeForms: existing.reinitializeForms || reinitializeForms,
        initializeAllPlugins: existing.initializeAllPlugins || initializeAllPlugins,
        initializeCodeBlocks: existing.initializeCodeBlocks || initializeCodeBlocks,
        initializeEmbedBlocks: existing.initializeEmbedBlocks || initializeEmbedBlocks,
        initializeThirdPartyPlugins: existing.initializeThirdPartyPlugins || initializeThirdPartyPlugins,
        registeredPlugins: existing.registeredPlugins || [],
      };
    })();

    // Share the utilities with any other SDL plugins that load later.
    if (!window.sdl$) window.sdl$ = sdl$;

    /* --------------------------------------------------------------------
       Default settings
    -------------------------------------------------------------------- */
    const DEFAULT_SETTINGS = {
      displayDirection: "fade",       // fade | slide-top | slide-bottom | slide-left | slide-right
      openAnimation: "fade",          // "fade" = animated, anything else = instant
      openAnimationDuration: 300,     // ms
      closeOnOverlayClick: true,
      closeOnEscape: true,
      closePlacement: "content",      // "content" = close button inside container, else inside overlay
      maxWidth: "800px",
      maxHeight: "80vh",
      zIndex: 9999,
      debugLoading: false,
      preloadContent: false,
      loadingEl: `<div class="loading"></div>`,

      /* Visual styling — applied as CSS custom properties on :root.
         Leave a value null/undefined to keep the stylesheet default. */
      styles: {
        width: null,                  // e.g. "800px"
        maxHeight: null,              // e.g. "80vh"

        overlayColor: null,           // hex / css color
        overlayOpacity: null,         // 0–1
        overlayBlur: null,            // px (number)

        popupBorderWidth: null,       // px (number) — 0 disables the border
        popupBorderColor: null,       // hex / css color
        popupBorderRadius: null,      // px (number)

        closeBgColor: null,           // hex / css color
        closeBgOpacity: null,         // 0–1
        closeColor: null,             // hex / css color
        closeBorderWidth: null,       // px (number) — 0 disables the border
        closeBorderColor: null,       // hex / css color
        closeRadius: null,            // % (number) — 50 = circle
      },

      hooks: {
        beforeInit: [],
        afterInit: [],
        beforeOpenPopup: [],
        afterOpenPopup: [],
        beforeClosePopup: [],
        afterClosePopup: [],
      },
    };

    /* --------------------------------------------------------------------
       Instance state
    -------------------------------------------------------------------- */
    const userSettings = window.sdlPopupSettings || {};
    const settings = sdl$.deepMerge({}, DEFAULT_SETTINGS, userSettings);

    const state = {
      popups: new Map(),
      activePopup: null,
      currentSelector: null,
      originalParent: null,
      originalNextSibling: null,
      scrollPosition: 0,
      originalScrollBehavior: "",
      themeStyleEl: null,        // live section-theme <style> in <head> while open
    };

    // DOM references (assigned in buildStructure)
    let overlay, container, content, closeButton, loadingElem, seoContainer;

    const VALID_DIRECTIONS = ["fade", "slide-top", "slide-bottom", "slide-left", "slide-right"];
    const isAnimated = () => settings.openAnimation === "fade";
    const duration = () => settings.openAnimationDuration;

    /* --------------------------------------------------------------------
       Small helpers
    -------------------------------------------------------------------- */
    function emitEvent(type, detail = {}, elem = document) {
      if (!type) return;
      return elem.dispatchEvent(
        new CustomEvent(type, { bubbles: true, cancelable: true, detail })
      );
    }

    function runHooks(hookName, ...args) {
      const hooks = settings.hooks[hookName] || [];
      hooks.forEach(cb => {
        if (typeof cb === "function") cb.apply(window.sdlPopup, args);
      });
    }

    // "#fff" / "#ffffff" -> "r, g, b"
    function hexToRgbTriplet(hex) {
      if (typeof hex !== "string") return null;
      let h = hex.trim().replace("#", "");
      if (h.length === 3) h = h.split("").map(c => c + c).join("");
      if (h.length !== 6) return null;
      const num = parseInt(h, 16);
      return `${(num >> 16) & 255}, ${(num >> 8) & 255}, ${num & 255}`;
    }

    function colorWithOpacity(color, opacity) {
      const triplet = hexToRgbTriplet(color);
      if (triplet && opacity != null) return `rgba(${triplet}, ${opacity})`;
      return color;
    }

    /* --------------------------------------------------------------------
       Apply user style overrides as CSS custom properties
    -------------------------------------------------------------------- */
    function applyStyles() {
      const s = settings.styles || {};
      const root = document.documentElement;
      const setVar = (name, val) => {
        if (val !== null && val !== undefined && val !== "") {
          root.style.setProperty(name, val);
        }
      };

      // Layout
      setVar("--sdl-popup-width", s.width || settings.maxWidth);
      setVar("--sdl-popup-max-height", s.maxHeight || settings.maxHeight);

      // Animation duration
      setVar("--sdl-popup-anim-duration", `${duration()}ms`);

      // Overlay
      setVar("--sdl-popup-overlay-color", s.overlayColor);
      setVar("--sdl-popup-overlay-opacity", s.overlayOpacity);
      if (s.overlayBlur != null) setVar("--sdl-popup-overlay-blur", `${s.overlayBlur}px`);

      // Container border / radius
      if (s.popupBorderWidth != null) {
        setVar(
          "--sdl-popup-border",
          s.popupBorderWidth > 0
            ? `${s.popupBorderWidth}px solid ${s.popupBorderColor || "#000000"}`
            : "initial"
        );
      }
      if (s.popupBorderRadius != null) {
        setVar("--sdl-popup-border-radius", `${s.popupBorderRadius}px`);
      }

      // Close button
      setVar("--sdl-popup-close-bg", colorWithOpacity(s.closeBgColor, s.closeBgOpacity));
      setVar("--sdl-popup-close-color", s.closeColor);
      if (s.closeBorderWidth != null) {
        setVar(
          "--sdl-popup-close-border",
          s.closeBorderWidth > 0
            ? `${s.closeBorderWidth}px solid ${s.closeBorderColor || "#000000"}`
            : "none"
        );
      }
      if (s.closeRadius != null) setVar("--sdl-popup-close-radius", `${s.closeRadius}%`);
    }

    /* --------------------------------------------------------------------
       Build the overlay DOM structure
    -------------------------------------------------------------------- */
    function buildStructure() {
      overlay = document.createElement("div");
      overlay.className = "sdl-popup-overlay";

      // Display direction class (drives CSS animation/positioning)
      const dir = VALID_DIRECTIONS.includes(settings.displayDirection)
        ? settings.displayDirection
        : "fade";
      overlay.classList.add(`sdl-popup-dir-${dir}`);
      if (!isAnimated()) overlay.classList.add("sdl-popup-no-anim");
      overlay.style.zIndex = settings.zIndex;

      container = document.createElement("div");
      container.className = "sdl-popup-container";

      closeButton = document.createElement("button");
      closeButton.className = "sdl-popup-close";
      closeButton.setAttribute("aria-label", "Close");
      closeButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="size-6">
      <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
    </svg>`;

      content = document.createElement("div");
      content.className = "sdl-popup-content";

      loadingElem = document.createElement("div");
      loadingElem.className = "sdl-popup-loading";
      loadingElem.innerHTML = settings.loadingEl;

      // Close button placement
      settings.closePlacement === "content"
        ? container.appendChild(closeButton)
        : overlay.appendChild(closeButton);

      container.appendChild(content);
      overlay.appendChild(container);
      overlay.appendChild(loadingElem);

      overlay.style.display = "none";
      document.querySelector("#siteWrapper").appendChild(overlay);
    }

    /* --------------------------------------------------------------------
       Event binding
    -------------------------------------------------------------------- */
    function bindEvents() {
      document.body.addEventListener("click", handleLinkClick);
      closeButton.addEventListener("click", closePopup);

      if (settings.closeOnOverlayClick) {
        overlay.addEventListener("click", e => {
          if (e.target === overlay) closePopup();
        });
      }
      if (settings.closeOnEscape) {
        document.addEventListener("keydown", e => {
          if (e.key === "Escape") closePopup();
        });
      }
    }

    /* --------------------------------------------------------------------
       Parse a popup trigger href into { url, selector }
    -------------------------------------------------------------------- */
    function parseHref(href) {
      const prefixLength = href.startsWith("/#sdl-popup=")
        ? "/#sdl-popup=".length
        : href.startsWith("/#sdlpopup=")
        ? "/#sdlpopup=".length
        : href.startsWith("#sdl-popup=")
        ? "#sdl-popup=".length
        : "#sdlpopup=".length;

      const fullPath = href.substring(prefixLength);
      let url, selector;

      if (fullPath.includes("#")) {
        [url, selector] = fullPath.split("#");
        selector = `#${selector}`;
      } else if (fullPath.includes(".fe-")) {
        const i = fullPath.indexOf(".fe-");
        url = fullPath.substring(0, i);
        selector = fullPath.substring(i);
      } else if (fullPath.includes("[data-section-id=")) {
        const i = fullPath.indexOf("[data-section-id=");
        url = fullPath.substring(0, i);
        selector = fullPath.substring(i);
      } else {
        url = fullPath;
        selector = null;
      }
      return { url, selector };
    }

    async function handleLinkClick(e) {
      const link = e.target.closest(
        'a[href^="#sdl-popup="], a[href^="#sdlpopup="], a[href^="/#sdl-popup="], a[href^="/#sdlpopup="]'
      );
      if (!link) return;

      e.preventDefault();
      const { url, selector } = parseHref(link.getAttribute("href"));
      await openPopup(url, selector);
    }

    /* --------------------------------------------------------------------
       Open
    -------------------------------------------------------------------- */
    async function openPopup(url, selector = null) {
      runHooks("beforeOpenPopup", url);
      emitEvent("sdlPopup:beforeOpenPopup", { url, selector, el: overlay });

      // Scrollbar compensation + scroll freeze
      const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
      state.scrollPosition = window.scrollY;
      state.originalScrollBehavior = getComputedStyle(document.documentElement).scrollBehavior;
      document.documentElement.style.scrollBehavior = "auto";

      document.body.classList.add("sdl-popup-open");
      document.body.style.setProperty("--sdl-popup-freeze-scroll-padding-right", `${scrollbarWidth}px`);
      document.body.style.setProperty("--sdl-popup-freeze-scroll-top", `-${state.scrollPosition}px`);

      overlay.style.display = "block";
      container.style.display = "none";
      loadingElem.style.display = "block";
      content.style.display = "none";
      document.body.dataset.activePopup = `${url}${selector ? selector : ""}`;

      // Reveal overlay (triggers the CSS opacity/transform transition)
      requestAnimationFrame(() => overlay.classList.add("sdl-popup-active"));

      if (settings.debugLoading) return;

      try {
        if (!state.popups.has(url)) {
          const fragment = await sdl$.getFragment(url, "#sections");
          const initialized = await initializeContent(fragment);
          state.popups.set(url, initialized);
        }

        const popupContent = state.popups.get(url);
        content.innerHTML = "";

        // Clone the section-theme CSS into <head> so themed sections render
        // with their correct colours while the popup is open.
        injectThemeStyles(popupContent);

        if (selector) {
          const block = popupContent.querySelector(selector);
          if (block) {
            const colorTheme = block.closest("section")?.dataset.sectionTheme;
            block.dataset.sectionTheme = colorTheme;
            state.currentSelector = selector;
            state.originalParent = block.parentNode;
            state.originalNextSibling = block.nextSibling;
            content.appendChild(block);
          } else {
            throw new Error(`Selector "${selector}" not found in the content.`);
          }
        } else {
          // Move every child EXCEPT the section-theme <style> (kept in the cache
          // so it survives reopen; it is injected into <head> separately above).
          Array.from(popupContent.childNodes).forEach(child => {
            if (
              child.nodeType === 1 &&
              child.classList.contains("sdl-popup-section-themes")
            ) {
              return;
            }
            content.appendChild(child);
          });
          state.currentSelector = null;
          state.originalParent = popupContent;
          state.originalNextSibling = null;
        }
      } catch (error) {
        console.error("Error fetching or displaying popup content:", error);
        document.body.dataset.activePopup = null;
        const errorContent = createErrorContent(url, selector);
        state.popups.set(url, errorContent);
        content.appendChild(errorContent);
        state.currentSelector = null;
      }

      showPopupContent();
      state.activePopup = url;
      if (typeof Squarespace !== "undefined" && typeof Y !== "undefined" && Squarespace.initializeSummaryV2Block) {
        Squarespace.initializeSummaryV2Block(Y, Y.one(overlay));
      }
      // Re-wire form blocks now that the content lives in its final location
      // in the popup (forms initialized in the temp container don't survive
      // being moved — especially reCAPTCHA).
      sdl$.reinitializeForms(content);
      playSingleVideo();

      emitEvent("sdlPopup:afterOpenPopup", { url, selector, el: overlay });
      runHooks("afterOpenPopup", url);
    }

    function createErrorContent(url, selector) {
      const el = document.createElement("div");
      el.className = "sdl-popup-error";
      el.innerHTML = `
      <h2>Error Loading Content</h2>
      <p>There was an error fetching the content. Doublecheck the URL${selector ? ` and target.` : `.`}</p>
      <p>URL: ${url}</p>
      ${selector ? `<p>Target: ${selector}</p>` : ``}
    `;
      return el;
    }

    function showPopupContent() {
      loadingElem.style.display = "none";
      content.style.display = "block";
      container.style.display = "block";
      loadAllImages(content);
      queueLayoutRefresh();
    }

    /* Clone the fetched page's section-theme <style> into <head> while open. */
    function injectThemeStyles(popupContent) {
      removeThemeStyles();
      const styleEl = popupContent.querySelector(".sdl-popup-section-themes");
      if (styleEl) {
        state.themeStyleEl = styleEl.cloneNode(true);
        document.head.appendChild(state.themeStyleEl);
      }
    }

    function removeThemeStyles() {
      if (state.themeStyleEl) {
        state.themeStyleEl.remove();
        state.themeStyleEl = null;
      }
    }

    /* --------------------------------------------------------------------
       Content initialization (Squarespace lifecycle inside a temp container)
    -------------------------------------------------------------------- */
    async function initializeContent(fragment) {
      const tempContainer = document.createElement("div");
      tempContainer.classList.add("temp-popup-container");
      tempContainer.appendChild(fragment);

      let lastSection = null;
      if (document.querySelector("#sections > section:last-of-type .content-wrapper, #page-regions > section:last-of-type .content-wrapper")) {
        lastSection = document.querySelector(
          "#sections > section:last-of-type .content-wrapper, #page-regions > section:last-of-type .content-wrapper"
        );
      } else if (document.querySelectorAll("#sections .page-section").length > 0) {
        const pageSections = document.querySelectorAll("#sections .page-section");
        lastSection = pageSections[pageSections.length - 1];
      } else if (document.querySelector("#page .system-page")) {
        lastSection = document.querySelector("#page .system-page");
      } else {
        console.error("No last section found");
      }

      if (lastSection) {
        lastSection.appendChild(tempContainer);
      } else {
        console.error("No last section found");
      }

      sdl$.initializeAllPlugins();
      await sdl$.reloadSquarespaceLifecycle(tempContainer);

      try {
        if (typeof sdl$.initializeCodeBlocks === "function") {
          await sdl$.initializeCodeBlocks(tempContainer);
        }
        if (typeof sdl$.initializeEmbedBlocks === "function") {
          await sdl$.initializeEmbedBlocks(tempContainer);
        }
        if (typeof sdl$.initializeThirdPartyPlugins === "function") {
          await sdl$.initializeThirdPartyPlugins(tempContainer);
        }
      } catch (error) {
        console.error("Error during initialization:", error);
      }

      if (lastSection) lastSection.removeChild(tempContainer);
      return tempContainer.firstChild;
    }

    /* --------------------------------------------------------------------
       Close
    -------------------------------------------------------------------- */
    function closePopup() {
      if (!state.activePopup) return;

      runHooks("beforeClosePopup", state.activePopup);

      const teardown = () => {
        if (state.originalParent) {
          while (content.firstChild) {
            if (state.originalNextSibling) {
              state.originalParent.insertBefore(content.firstChild, state.originalNextSibling);
            } else {
              state.originalParent.appendChild(content.firstChild);
            }
          }
        }

        document.body.classList.remove("sdl-popup-open");
        document.documentElement.style.scrollBehavior = "unset";
        window.scrollTo(0, state.scrollPosition);

        requestAnimationFrame(() => {
          document.body.style.removeProperty("--sdl-popup-freeze-scroll-padding-right");
          document.body.style.removeProperty("--sdl-popup-freeze-scroll-top");
          setTimeout(() => {
            document.documentElement.style.scrollBehavior = state.originalScrollBehavior || "";
          }, 50);
        });

        container.scrollTop = 0;
        container.scrollLeft = 0;

        removeThemeStyles();
        overlay.style.display = "none";
        state.activePopup = null;
        state.currentSelector = null;
        state.originalParent = null;
        state.originalNextSibling = null;
        document.body.dataset.activePopup = null;

        runHooks("afterClosePopup");
      };

      // Trigger the close transition (overlay loses .sdl-popup-active)
      overlay.classList.remove("sdl-popup-active");

      if (isAnimated()) {
        setTimeout(teardown, duration());
      } else {
        teardown();
      }
    }

    /* --------------------------------------------------------------------
       Post-open helpers
    -------------------------------------------------------------------- */
    function loadAllImages(el = document) {
      const imageLoader = window.ImageLoader || window.Squarespace?.ImageLoader;
      if (!imageLoader || typeof imageLoader.load !== "function") return;
      el.querySelectorAll("img[data-src]").forEach(img => imageLoader.load(img, { load: true }));
    }

    function queueLayoutRefresh() {
      const refresh = () => {
        if (typeof Squarespace !== "undefined" && typeof Y !== "undefined" && Squarespace.initializeLayoutBlocks) {
          Squarespace.initializeLayoutBlocks(Y, Y.one(content));
        }
      };
      requestAnimationFrame(refresh);
      if (isAnimated()) setTimeout(refresh, duration() + 20);
    }

    function playSingleVideo() {
      const hasOnlyVideo = content.querySelector(
        ":scope > .sqs-block-video[data-block-json], :scope > .fe-block .sqs-block-video[data-block-json]"
      );
      if (!hasOnlyVideo) return;

      const json = JSON.parse(hasOnlyVideo.dataset.blockJson);
      let video = hasOnlyVideo.querySelector("video");
      if (!json || !json.settings) return;

      const playVideo = () => {
        video.play().then(() => {
          video.muted = false;
        }).catch(error => {
          console.log("Autoplay with sound failed:", error);
          video.muted = true;
          video.play();
        });
      };

      const checkVideoLoaded = (attempts = 0) => {
        video = hasOnlyVideo.querySelector("video");
        if (video) {
          video.addEventListener("canplay", playVideo, { once: true });
          if (video.readyState >= 4) playVideo();
        } else if (attempts < 10) {
          setTimeout(() => checkVideoLoaded(attempts + 1), 100);
        }
      };

      checkVideoLoaded();
    }

    /* --------------------------------------------------------------------
       Preload + SEO container
    -------------------------------------------------------------------- */
    async function preloadPopupContent() {
      const links = document.querySelectorAll(
        'a[href^="#sdl-popup="], a[href^="#sdlpopup="], a[href^="/#sdl-popup="], a[href^="/#sdlpopup="]'
      );

      for (const link of links) {
        const { url } = parseHref(link.getAttribute("href"));
        if (state.popups.has(url)) continue;

        try {
          const fragment = await sdl$.getFragment(url, "#sections");
          const wrapper = document.createElement("div");
          wrapper.dataset.popupUrl = url;
          wrapper.dataset.popupContent = "true";
          wrapper.appendChild(fragment);
          const result = await initializeContent(wrapper);
          seoContainer.appendChild(wrapper);
          state.popups.set(url, result);
        } catch (error) {
          console.error(`Error preloading popup content for ${url}:`, error);
          state.popups.set(url, createErrorContent(url));
        }
      }
    }

    function createSEOContainer() {
      seoContainer = document.createElement("div");
      seoContainer.className = "sdl-popup-seo-container";
      seoContainer.setAttribute("aria-hidden", "true");
      seoContainer.style.cssText = `
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
      `;
      document.querySelector("#siteWrapper").appendChild(seoContainer);
    }

    /* --------------------------------------------------------------------
       Init
    -------------------------------------------------------------------- */
    async function init() {
      runHooks("beforeInit");
      emitEvent("sdlPopup:beforeInit");

      applyStyles();
      buildStructure();
      bindEvents();

      if (settings.preloadContent) {
        createSEOContainer();
        await preloadPopupContent();
      }

      sdl$?.initializeAllPlugins();
      emitEvent("sdlPopup:afterInit");
      runHooks("afterInit");
    }

    // Public API
    const api = {
      settings,
      state,
      open: openPopup,
      close: closePopup,
    };

    init();
    return api;
  })();
}
