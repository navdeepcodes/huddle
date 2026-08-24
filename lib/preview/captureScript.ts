import { HTML2CANVAS_VENDORED_SOURCE } from "@/lib/preview/vendor/html2canvas";

/**
 * Injected into the previewed page itself via WebContainer's
 * setPreviewScript (a literal <script> tag in every HTML response),
 * so it runs same-origin with the preview - the only way to rasterize
 * a cross-origin WebContainer preview iframe from the parent tab.
 * Ported from apostle's webRuntimeSession.ts (proven live: an SVG
 * <foreignObject> approach taints the canvas even with zero external
 * resources; html2canvas's own DOM-walking Canvas2D drawing doesn't).
 * The result crosses back out via postMessage, the one channel
 * available regardless of origin.
 */
export const PREVIEW_CAPTURE_MESSAGE_MARKER = "__huddlePreviewCapture";

export function buildPreviewCaptureScript(): string {
  return `${HTML2CANVAS_VENDORED_SOURCE}
;(function() {
  function post(msg) {
    try {
      window.parent.postMessage(Object.assign({ marker: "${PREVIEW_CAPTURE_MESSAGE_MARKER}" }, msg), "*");
    } catch (e) {}
  }

  function patchGradientClampOnce() {
    if (window.__huddleGradientPatched) return;
    window.__huddleGradientPatched = true;
    var originalAddColorStop = CanvasGradient.prototype.addColorStop;
    CanvasGradient.prototype.addColorStop = function(offset, color) {
      return originalAddColorStop.call(this, isFinite(offset) ? offset : 0, color);
    };
  }

  /**
   * html2canvas's bundled CSS color parser predates CSS Color 4/5 - it
   * throws on oklch()/oklab()/lab()/lch()/color()/color-mix(), all of
   * which real browsers (and Tailwind v4's default palette) use freely.
   * Rather than teach the vendored parser new syntax, or force every
   * generated site to avoid modern CSS, this resolves any such value to
   * the browser's own canonical rgb()/rgba() serialization right before
   * capture - the browser already implements every CSS color space
   * correctly, so this asks it to do the conversion instead of
   * reimplementing color science here. Applies to arbitrary sites: it
   * walks computed styles, not anything specific to this project's
   * palette. Overrides are inline "!important" styles, recorded and
   * restored immediately after the capture settles, so the live preview
   * a person is looking at is never visibly altered.
   */
  var MODERN_COLOR_FN_RE = /\\b(oklch|oklab|lab|lch|color-mix|color)\\(/i;
  var MODERN_COLOR_FN_RE_G = /\\b(oklch|oklab|lab|lch|color-mix|color)\\(/gi;

  /**
   * Reading ctx.fillStyle back after setting it does NOT downconvert
   * oklch()/oklab() to rgb() in current browsers - confirmed live, it
   * just re-serializes the same wide-gamut color space (e.g.
   * "oklch(70% .15 145)" comes back as "oklch(0.7 0.15 145)", still an
   * oklch string). The only reliable way to force an actual sRGB
   * conversion is to rasterize a pixel and read its bytes back - Canvas
   * getImageData always returns 8-bit RGBA regardless of the color
   * space the fill was specified in.
   */
  function makeColorResolver() {
    var canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    var ctx = canvas.getContext("2d");
    var cache = {};
    return function resolveColor(value) {
      if (Object.prototype.hasOwnProperty.call(cache, value)) return cache[value];
      var resolved = value;
      try {
        ctx.fillStyle = "#000000";
        var before = ctx.fillStyle;
        ctx.fillStyle = value;
        if (ctx.fillStyle !== before) {
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = value;
          ctx.fillRect(0, 0, 1, 1);
          var d = ctx.getImageData(0, 0, 1, 1).data;
          resolved = "rgba(" + d[0] + "," + d[1] + "," + d[2] + "," + (d[3] / 255) + ")";
        }
      } catch (e) {}
      cache[value] = resolved;
      return resolved;
    };
  }

  function replaceModernColorFns(value, resolveColor) {
    MODERN_COLOR_FN_RE_G.lastIndex = 0;
    var out = "";
    var i = 0;
    var m;
    while ((m = MODERN_COLOR_FN_RE_G.exec(value))) {
      var start = m.index;
      out += value.slice(i, start);
      var depth = 0;
      var j = start + m[0].length - 1;
      for (; j < value.length; j++) {
        if (value[j] === "(") depth++;
        else if (value[j] === ")") {
          depth--;
          if (depth === 0) break;
        }
      }
      out += resolveColor(value.slice(start, j + 1));
      i = j + 1;
      MODERN_COLOR_FN_RE_G.lastIndex = i;
    }
    out += value.slice(i);
    return out;
  }

  /**
   * Walks every computed CSS property (not a curated list) - Tailwind v4's
   * default palette is oklch end to end, so a modern color function can
   * show up on essentially any property (fill/stroke on inline SVG icons,
   * text-shadow, outline-color, ...), not just the handful of common ones.
   * A fixed property list is exactly the kind of thing that quietly rots
   * as new generated sites use different Tailwind utilities.
   */
  function collectModernColorProps(computed) {
    var found = [];
    for (var i = 0; i < computed.length; i++) {
      var prop = computed[i];
      var value = computed.getPropertyValue(prop);
      if (value && MODERN_COLOR_FN_RE.test(value)) found.push([prop, value]);
    }
    return found;
  }

  var PSEUDO_OVERRIDE_STYLE_ID = "__huddleCapturePseudoOverrides";
  var PSEUDO_ID_ATTR = "data-huddle-capture-id";

  function normalizeModernColors() {
    var resolveColor = makeColorResolver();
    var inlineOverrides = [];
    var pseudoRules = [];
    var pseudoIdElements = [];
    var nextPseudoId = 0;

    function overrideInline(el, computed) {
      var props = collectModernColorProps(computed);
      for (var i = 0; i < props.length; i++) {
        var prop = props[i][0];
        var value = props[i][1];
        var replaced = replaceModernColorFns(value, resolveColor);
        if (!replaced || replaced === value) continue;
        inlineOverrides.push({
          el: el,
          prop: prop,
          original: el.style.getPropertyValue(prop) || null,
          priority: el.style.getPropertyPriority(prop)
        });
        try {
          el.style.setProperty(prop, replaced, "important");
        } catch (e) {}
      }
    }

    // ::before/::after aren't real nodes - there's no el.style to override,
    // so an actually-rendered pseudo-element (content !== "none") instead
    // gets a temporary id attribute and a matching rule in one injected
    // <style> tag, restored by removing both afterward.
    function overridePseudo(el, pseudo) {
      var computed;
      try {
        computed = getComputedStyle(el, pseudo);
      } catch (e) {
        return;
      }
      if (!computed || computed.content === "none") return;

      var props = collectModernColorProps(computed);
      if (!props.length) return;

      var decls = [];
      for (var i = 0; i < props.length; i++) {
        var prop = props[i][0];
        var value = props[i][1];
        var replaced = replaceModernColorFns(value, resolveColor);
        if (!replaced || replaced === value) continue;
        decls.push(prop + ": " + replaced + " !important;");
      }
      if (!decls.length) return;

      var id = el.getAttribute(PSEUDO_ID_ATTR);
      if (id === null) {
        id = String(nextPseudoId++);
        el.setAttribute(PSEUDO_ID_ATTR, id);
        pseudoIdElements.push(el);
      }
      pseudoRules.push("[" + PSEUDO_ID_ATTR + '="' + id + '"]' + pseudo + " {" + decls.join(" ") + "}");
    }

    function visit(el) {
      var computed;
      try {
        computed = getComputedStyle(el);
      } catch (e) {
        return;
      }
      overrideInline(el, computed);
      overridePseudo(el, "::before");
      overridePseudo(el, "::after");
    }

    try {
      visit(document.body);
      var all = document.body.getElementsByTagName("*");
      for (var k = 0; k < all.length; k++) visit(all[k]);
    } catch (e) {}

    var styleEl = null;
    if (pseudoRules.length) {
      try {
        styleEl = document.createElement("style");
        styleEl.id = PSEUDO_OVERRIDE_STYLE_ID;
        styleEl.textContent = pseudoRules.join("\\n");
        document.head.appendChild(styleEl);
      } catch (e) {}
    }

    return function restore() {
      for (var i = inlineOverrides.length - 1; i >= 0; i--) {
        var o = inlineOverrides[i];
        try {
          if (o.original) o.el.style.setProperty(o.prop, o.original, o.priority);
          else o.el.style.removeProperty(o.prop);
        } catch (e) {}
      }
      try {
        if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
      } catch (e) {}
      for (var j = 0; j < pseudoIdElements.length; j++) {
        try {
          pseudoIdElements[j].removeAttribute(PSEUDO_ID_ATTR);
        } catch (e) {}
      }
    };
  }

  var DEFAULT_VIEWPORT = { width: 1440, height: 900 };

  /**
   * html2canvas renders from a cloned copy of the DOM, not the live
   * page - confirmed live this is why a page that's fully, correctly
   * rendered on screen (checked directly) still came back as a nearly
   * blank capture: real generated sites commonly use native
   * loading="lazy" on below-the-fold <img> elements (this KIGU project
   * among them), and the clone never satisfies the browser's normal
   * "is this near the viewport" condition for lazy images to start
   * loading, so they stay unloaded in the clone - collapsing any
   * layout that sizes itself off an image's intrinsic dimensions,
   * which is exactly what a product grid does. onclone runs against
   * the CLONE specifically (the live page's own lazy images are left
   * alone), forces eager loading, and waits for every image to
   * actually finish before html2canvas paints - bounded by a timeout
   * so one slow/broken image can't hang the whole capture.
   */
  function eagerLoadClonedImages(clonedDoc) {
    var imgs = clonedDoc.querySelectorAll("img");
    var waits = [];
    for (var i = 0; i < imgs.length; i++) {
      var img = imgs[i];
      img.loading = "eager";
      img.removeAttribute("loading");
      if (img.complete && img.naturalWidth > 0) continue;
      waits.push(
        new Promise(function(resolve) {
          var done = function() {
            img.removeEventListener("load", done);
            img.removeEventListener("error", done);
            resolve();
          };
          img.addEventListener("load", done);
          img.addEventListener("error", done);
        })
      );
    }
    if (!waits.length) return Promise.resolve();
    var timeout = new Promise(function(resolve) { setTimeout(resolve, 4000); });
    return Promise.race([Promise.all(waits), timeout]);
  }

  /**
   * Confirmed live on a generated site (Home.tsx's hero: eyebrow,
   * headline, body copy, and CTAs all start at opacity:0 and fade/slide
   * in via a CSS keyframe animation with a staggered animation-delay)
   * that the hero text was completely absent from the capture while
   * being fully visible on screen at the same moment - a real browser
   * screenshot showed it, html2canvas's did not. Same root cause class
   * as the lazy-image bug: html2canvas paints from a freshly-inserted
   * clone, so a delayed/timed CSS animation hasn't reached its
   * "forwards" end state there the way it has on a page that's been
   * live for a second or more. This is not KIGU-specific - staggered
   * entrance animations (fade/slide-up) are a common pattern in
   * generated sites generally, so any of them could hit this. Forcing
   * every animation/transition in the clone to zero duration/delay
   * makes each one jump straight to its end state instead of being
   * caught mid-flight or pre-start.
   */
  function neutralizeClonedAnimations(clonedDoc) {
    var style = clonedDoc.createElement("style");
    style.textContent =
      "*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition-duration: 0s !important; transition-delay: 0s !important; }";
    (clonedDoc.head || clonedDoc.documentElement).appendChild(style);
  }

  function onCloneCapture(clonedDoc) {
    neutralizeClonedAnimations(clonedDoc);
    return eagerLoadClonedImages(clonedDoc);
  }

  function runCapture(width, height) {
    // useCORS: generated sites routinely reference real external image
    // CDNs (stock photo hosts, etc.) - the CORS-safe fetch mode is what
    // lets html2canvas read those pixels back for rasterization at all.
    // scale: 1 - confirmed live that html2canvas's default scale
    // (window.devicePixelRatio, 2 in this environment) doubled a
    // 1440x900 capture to a 2880x1800 canvas; combined with PNG
    // encoding of a page that's now actually fully rendered (not the
    // earlier blank corner), that produced a ~7.8MB dataUrl - which
    // blew past Firestore's 1 MiB per-document limit and made the
    // result-reporting write throw (surfaced as an opaque 500 on
    // /api/runtime-commands/[id]/complete, which in turn made the
    // dispatch side time out with no useful error). A screenshot meant
    // for vision-model critique doesn't need retina-level pixels.
    var opts = { logging: false, useCORS: true, scale: 1, onclone: onCloneCapture };
    if (typeof width === "number" && typeof height === "number") {
      opts.width = width;
      opts.height = height;
      opts.windowWidth = width;
      opts.windowHeight = height;
    }
    patchGradientClampOnce();

    var restore = function() {};
    try {
      restore = normalizeModernColors();
    } catch (e) {}

    return html2canvas(document.body, opts).then(
      function(canvas) {
        restore();
        return canvas;
      },
      function(err) {
        restore();
        throw err;
      }
    );
  }

  function finishCapture(requestId, canvas) {
    var dataUrl;
    try {
      // JPEG, not PNG: this result has to round-trip through a single
      // Firestore document (1 MiB hard limit) on its way back to the
      // agent - PNG's lossless encoding of a real, fully-painted page
      // blew past that. This is a vision-model input, not an archival
      // asset, so lossy compression is the right tradeoff.
      dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    } catch (e) {
      post({ kind: "result", requestId: requestId, ok: false, error: "toDataURL failed: " + (e && e.message) });
      return;
    }
    post({ kind: "result", requestId: requestId, ok: true, dataUrl: dataUrl, width: canvas.width, height: canvas.height });
  }

  function doCapture(requestId, viewport) {
    if (typeof html2canvas === "undefined") {
      post({ kind: "result", requestId: requestId, ok: false, error: "html2canvas failed to load in the previewed page." });
      return;
    }
    var hasExplicitViewport = viewport && typeof viewport.width === "number" && typeof viewport.height === "number";
    var width = hasExplicitViewport ? viewport.width : DEFAULT_VIEWPORT.width;
    var height = hasExplicitViewport ? viewport.height : DEFAULT_VIEWPORT.height;

    runCapture(width, height).then(function(canvas) {
      if (canvas.width === 0 || canvas.height === 0) {
        if (hasExplicitViewport) {
          post({ kind: "result", requestId: requestId, ok: false, error: "Capture came back 0x0 even with an explicit viewport." });
          return;
        }
        runCapture(DEFAULT_VIEWPORT.width, DEFAULT_VIEWPORT.height).then(function(retryCanvas) {
          finishCapture(requestId, retryCanvas);
        }).catch(function(e) {
          post({ kind: "result", requestId: requestId, ok: false, error: "capture failed on retry: " + (e && e.message) });
        });
        return;
      }
      finishCapture(requestId, canvas);
    }).catch(function(e) {
      post({ kind: "result", requestId: requestId, ok: false, error: "capture failed: " + (e && e.message) });
    });
  }

  window.addEventListener("message", function(evt) {
    var data = evt.data;
    if (!data || data.marker !== "${PREVIEW_CAPTURE_MESSAGE_MARKER}" || data.kind !== "request") return;
    doCapture(data.requestId, data.viewport);
  });

  post({ kind: "ready" });
})();
`;
}
