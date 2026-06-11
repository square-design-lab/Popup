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
          while (popupContent.firstChild) {
            content.appendChild(popupContent.firstChild);
          }
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
      Squarespace.initializeSummaryV2Block(Y, Y.one(overlay));
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
      const refresh = () => Squarespace.initializeLayoutBlocks(Y, Y.one(content));
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
