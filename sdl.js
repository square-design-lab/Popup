/* =========================================================================
   sdl.js — SDL content-pulling library  (REFERENCE ONLY)
   =========================================================================

   This file documents, in clean and un-minified form, the "pull content from
   another page / section / block" library that is BUNDLED inside popup.js.

   popup.js ships its own copy of these utilities (so the plugin has no external
   dependency); this standalone file exists purely as a readable reference and
   a drop-in `window.sdl$` you can load on its own.

   It is the result of reverse-engineering how a production Squarespace lightbox
   plugin pulls content, then distilling the parts that matter:

     1. Fetch the source page with `?format=html` (Squarespace's lean,
        injection-friendly content endpoint).
     2. Parse it with DOMParser and extract the wanted region:
          - whole page      → #sections  (fallback: [data-content-field],#page,body)
          - a section by id → "/page#section-id"  or  "/page>section-id"
          - a single block  → "/page.fe-block-…"  or  "/page[data-section-id=…]"
     3. Carry the page-level section-theme CSS (#sectionThemesStyles on 7.0 /
        template sites) along with the markup so colours survive the move.
        (On 7.1 Fluid Engine sites the per-section <style id="container-styles">
        lives INSIDE each section and travels automatically.)
     4. Re-import the nodes into the live document, then re-initialize them so
        Squarespace blocks actually work:
          - re-execute <script> tags (DOMParser/innerHTML never runs scripts),
          - run Squarespace's per-block initializers (layout, video, summary…),
          - hydrate 7.1 React "website component" blocks (forms!) via
            Squarespace.initializeWebsiteComponent,
          - load lazy images via Squarespace's ImageLoader.

   KEY SQUARESPACE INTERNALS (verified on live sites):
     • window.Squarespace.initializeWebsiteComponent(Y)
         Hydrates 7.1 React components (forms, donation, scheduling). Scans the
         document for [data-website-component-id] / [data-definition-name].
         The legacy initializeFormBlocks explicitly SKIPS website-component
         forms, so this is mandatory for modern contact forms.
     • window.Squarespace.AFTER_BODY_LOADED = false;
       window.Squarespace.afterBodyLoad();
         Re-runs Squarespace's whole block lifecycle — the sledgehammer used by
         the reference lightbox. Comprehensive but global; prefer the targeted
         initializers below unless you need everything.
     • window.ImageLoader.load(img, { load: true })  — responsive image loader.
   ========================================================================= */

window.sdl$ = (function (existing) {
  "use strict";

  existing = existing || {};

  const safe = fn => {
    try { return fn(); }
    catch (e) { console.warn("[sdl$] util error:", e); }
  };

  const isPlainObject = v =>
    v && typeof v === "object" && !Array.isArray(v) &&
    (v.constructor === Object || Object.getPrototypeOf(v) === null);

  /* ----------------------------------------------------------------------
     deepMerge — recursive merge of plain objects (arrays/primitives overwrite)
  ---------------------------------------------------------------------- */
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

  /* ----------------------------------------------------------------------
     parseTarget — split a popup target into { url, selector }

     Supported forms (mirrors the trigger-link syntax of popup.js):
        /page                                  → whole page
        /page#section-id      /page>section-id → a section / element by id
        /page.fe-block-xxxx                    → a Fluid Engine block
        /page[data-section-id="xxxx"]          → a section by data attribute
  ---------------------------------------------------------------------- */
  function parseTarget(fullPath) {
    let url, selector;
    if (fullPath.includes(">")) {
      [url, selector] = fullPath.split(">");
      selector = "#" + selector.replace(/^#/, "");
    } else if (fullPath.includes("#")) {
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

  /* ----------------------------------------------------------------------
     getFragment — fetch a page and return a live-document copy of a region

     @param {string} url       page path, e.g. "/contact"
     @param {string} selector  region to return; default "#sections"
     @returns {Promise<HTMLElement>}

     - Uses ?format=html (lean content fragment).
     - Falls back through #sections → [data-content-field="main-content"] →
       #page → body when the requested selector is the default container.
     - Appends the page's #sectionThemesStyles (renamed .sdl-section-themes) so
       sections fetched from another page keep their theme colours.
  ---------------------------------------------------------------------- */
  async function getFragment(url, selector = "#sections") {
    const fetchUrl = url + (url.includes("?") ? "&" : "?") + "format=html";
    const response = await fetch(fetchUrl, {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`Fetch failed for "${url}" (${response.status})`);
    }
    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, "text/html");

    let found = doc.querySelector(selector);
    if (!found && selector === "#sections") {
      found =
        doc.querySelector('[data-content-field="main-content"]') ||
        doc.querySelector("#page") ||
        doc.body;
    }
    if (!found) throw new Error(`Selector "${selector}" not found at "${url}"`);

    const node = document.importNode(found, true);

    // Carry page-level section-theme CSS (7.0 / template sites).
    const themeStyles = doc.querySelector("#sectionThemesStyles");
    if (themeStyles) {
      const clone = document.importNode(themeStyles, true);
      clone.removeAttribute("id");
      clone.className = "sdl-section-themes";
      node.appendChild(clone);
    }
    return node;
  }

  /* ----------------------------------------------------------------------
     getPageContent — convenience wrapper around parseTarget + getFragment

     "/about"              → whole #sections of /about
     "/about#team"         → just the #team section
     "/shop/x.fe-block-ab" → just that Fluid Engine block
  ---------------------------------------------------------------------- */
  async function getPageContent(targetPath) {
    const { url, selector } = parseTarget(targetPath);
    const container = await getFragment(url, "#sections");
    if (!selector) return container;
    const el = container.querySelector(selector);
    if (!el) throw new Error(`Target "${selector}" not found in "${url}"`);
    // Preserve the section colour theme on a single extracted block.
    const theme = el.closest("section")?.dataset.sectionTheme;
    if (theme) el.dataset.sectionTheme = theme;
    return el;
  }

  /* ----------------------------------------------------------------------
     executeScripts — re-run <script> tags inside injected markup

     Parsed / imported / innerHTML'd markup NEVER executes its scripts. This
     re-creates them so they run. It:
       - runs SEQUENTIALLY, waiting for each external script's onload before the
         next (so dependent embeds load in order) — with a timeout guard so a
         blocked script can't stall the chain,
       - rewrites document.write(...) into insertAdjacentHTML so a block can't
         wipe the page,
       - skips non-JS (JSON / template) <script> tags,
       - is idempotent (each <script> is flagged data-sdl-ran once re-run).

     NOTE: scripts only execute when the container is CONNECTED to the live
     document — initialize fetched content while it is attached, not detached.
  ---------------------------------------------------------------------- */
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
                let done = false;
                const finish = () => { if (!done) { done = true; resolve(); } };
                script.onload = script.onerror = finish;
                setTimeout(finish, 5000); // guard: never stall on a blocked src
                script.src = old.src;
                old.parentNode.replaceChild(script, old);
              } else {
                let code = old.textContent || "";
                if (code.indexOf("document.write") !== -1) {
                  const id = "sdl-w-" + Math.random().toString(36).slice(2);
                  script.setAttribute("data-sdl-write", id);
                  code = code.replace(
                    /document\.write\s*\(/g,
                    `document.querySelector('[data-sdl-write="${id}"]')` +
                      `.insertAdjacentHTML('beforebegin',`
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

  /* ----------------------------------------------------------------------
     loadImages — trigger Squarespace's responsive ImageLoader
  ---------------------------------------------------------------------- */
  function loadImages(el) {
    const imageLoader = window.ImageLoader || window.Squarespace?.ImageLoader;
    if (!imageLoader || typeof imageLoader.load !== "function") return;
    (el || document)
      .querySelectorAll("img[data-src], img:not([src])")
      .forEach(img => {
        safe(() => imageLoader.load(img, { load: true }));
        img.classList.add("loaded");
      });
  }

  /* ----------------------------------------------------------------------
     reinitializeForms — make Squarespace form blocks work in injected content

     7.1 forms are React "website components" hydrated by
     initializeWebsiteComponent. The legacy initializeFormBlocks explicitly
     skips them — so BOTH are called to cover modern and classic forms.
     Run this on the LIVE content (after it is in its final position); React
     forms break if hydrated and then moved.
  ---------------------------------------------------------------------- */
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

    if (typeof Sqs.initializeWebsiteComponent === "function") {
      safe(() => Sqs.initializeWebsiteComponent(Y)); // 7.1 React components
    }
    if (typeof Sqs.initializeFormBlocks === "function") {
      safe(() => Sqs.initializeFormBlocks(Y, Y)); // legacy YUI forms
    }
  }

  /* ----------------------------------------------------------------------
     reloadSquarespaceLifecycle — targeted per-block initialization

     Runs Squarespace's individual block initializers on a container. Use this
     while the container is connected to the DOM. Existence-guarded so it is
     safe off-Squarespace. (Forms are handled separately by reinitializeForms.)
  ---------------------------------------------------------------------- */
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
      loadImages(el);
      safe(() => window.dispatchEvent(new Event("resize")));
      requestAnimationFrame(() => resolve());
    });
  }

  /* ----------------------------------------------------------------------
     reinitializeSquarespaceFull — the "sledgehammer" (optional)

     Re-runs Squarespace's ENTIRE block lifecycle, the way the reference
     lightbox does. More comprehensive than the targeted initializers (covers
     every block type) but global and heavier — use only if a block type isn't
     covered above. Handles both 7.0 (afterBodyLoad) and 7.1 (re-exec the site
     bundle so React controllers re-bind).
  ---------------------------------------------------------------------- */
  function reinitializeSquarespaceFull() {
    const Sqs = window.Squarespace;
    if (!Sqs) return;

    // 7.0 / classic: re-run afterBodyLoad.
    safe(() => {
      if (typeof Sqs.afterBodyLoad === "function") {
        Sqs.AFTER_BODY_LOADED = false;
        Sqs.afterBodyLoad();
      }
    });

    // 7.1: re-execute the site bundle so website-component controllers re-bind.
    safe(() => {
      const bundle = document.querySelector('script[src*="site-bundle"]');
      if (!bundle) return;
      const frozen = [
        ...document.querySelectorAll(
          "body, #header, #page [data-controller][data-props]"
        ),
      ];
      // Freeze existing controllers so they don't double-initialize.
      frozen.forEach(n => {
        n.setAttribute("data-freeze-controller", n.getAttribute("data-controller") || "");
        n.removeAttribute("data-controller");
      });
      const parent = bundle.parentNode;
      const fresh = document.createElement("script");
      fresh.src = bundle.getAttribute("src");
      parent.removeChild(bundle);
      setTimeout(() => {
        parent.appendChild(fresh); // re-runs 7.1 controllers on new markup
        setTimeout(() => {
          frozen.forEach(n => {
            n.setAttribute("data-controller", n.getAttribute("data-freeze-controller") || "");
            n.removeAttribute("data-freeze-controller");
          });
        }, 150);
      }, 150);
    });
  }

  /* ----------------------------------------------------------------------
     Block-type helpers (re-execute scripts + nudge SDKs)
  ---------------------------------------------------------------------- */
  async function initializeCodeBlocks(el) {
    await executeScripts(el);
  }

  async function initializeEmbedBlocks(el) {
    await executeScripts(el);
    safe(() => window.instgrm && window.instgrm.Embeds.process());
    safe(() => window.twttr && window.twttr.widgets && window.twttr.widgets.load(el));
    safe(() => window.FB && window.FB.XFBML && window.FB.XFBML.parse(el));
  }

  async function initializeThirdPartyPlugins(el) {
    await executeScripts(el);
    safe(() => el.dispatchEvent(new CustomEvent("sdl:contentReady", { bubbles: true })));
  }

  function initializeAllPlugins() {
    const registry = (window.sdl$ && window.sdl$.registeredPlugins) || [];
    registry.forEach(fn => safe(() => typeof fn === "function" && fn()));
  }

  /* ----------------------------------------------------------------------
     initializeContent — the full "make fetched content work" pipeline

     Pass a freshly-fetched node and a host element it can be temporarily
     attached to (Squarespace blocks must be CONNECTED to initialize). Returns
     the initialized node. Forms are intentionally left for reinitializeForms()
     to hydrate in their FINAL location.
  ---------------------------------------------------------------------- */
  async function initializeContent(node, host) {
    const temp = document.createElement("div");
    temp.className = "sdl-temp-container";
    temp.style.cssText = "position:absolute;z-index:-1;";
    temp.appendChild(node);
    (host || document.body).appendChild(temp);

    initializeAllPlugins();
    await reloadSquarespaceLifecycle(temp);
    await initializeCodeBlocks(temp);
    await initializeEmbedBlocks(temp);
    await initializeThirdPartyPlugins(temp);

    (host || document.body).removeChild(temp);
    return temp.firstChild;
  }

  /* ---------------------------------------------------------------------- */
  return {
    // merging
    deepMerge: existing.deepMerge || deepMerge,
    // pulling content
    parseTarget: existing.parseTarget || parseTarget,
    getFragment: existing.getFragment || getFragment,
    getPageContent: existing.getPageContent || getPageContent,
    // initializing pulled content
    executeScripts: existing.executeScripts || executeScripts,
    loadImages: existing.loadImages || loadImages,
    reloadSquarespaceLifecycle: existing.reloadSquarespaceLifecycle || reloadSquarespaceLifecycle,
    reinitializeSquarespaceFull: existing.reinitializeSquarespaceFull || reinitializeSquarespaceFull,
    reinitializeForms: existing.reinitializeForms || reinitializeForms,
    initializeCodeBlocks: existing.initializeCodeBlocks || initializeCodeBlocks,
    initializeEmbedBlocks: existing.initializeEmbedBlocks || initializeEmbedBlocks,
    initializeThirdPartyPlugins: existing.initializeThirdPartyPlugins || initializeThirdPartyPlugins,
    initializeAllPlugins: existing.initializeAllPlugins || initializeAllPlugins,
    initializeContent: existing.initializeContent || initializeContent,
    // optional plugin registry
    registeredPlugins: existing.registeredPlugins || [],
  };
})(window.sdl$);
