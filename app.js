/**
 * Aşiyân — Premium flipbook / e-magazine controller
 * ---------------------------------------------------------------------------
 * Turn.js (blasten/turn.js, 3rd release) integration hardened against common
 * failure modes: duplicate peels, spam navigation, resize jitter, and zoom
 * conflicts. Single global Turn instance; display toggles use the official API
 * to avoid re-init (which would stack document-level listeners in this build).
 *
 * NOTE: upstream turn.js carries a personal/non-commercial redistribution clause.
 * Obtain a suitable license from the rights holder for commercial deployment,
 * or swap the engine while keeping this interaction shell.
 */

(function (window, document, $) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Configuration — edit `magazinePages` or load JSON into this array.
  // ---------------------------------------------------------------------------

  /**
   * Local pages under ./img/ — cover sheet first (kapak.jpg), then 1.jpg … 46.jpg.
   * To use an English-named file as the cover image, name it cover.jpg (or any path
   * containing "cover") and list it first in this array.
   * @type {Array<{ src: string, alt?: string }>}
   */
  const magazinePages = (function buildLocalMagazinePages() {
    const out = [{ src: 'img/kapak.jpg', alt: 'Kapak' }];
    out.push({ src: 'img/arka-kapak.jpg', alt: 'künye' });
out.push({ src: 'img/açıklama.jpg', alt: 'açıklama' });
    for (let n = 1; n <= 46; n++) {
      out.push({ src: 'img/' + n + '.jpg', alt: 'Sayfa ' + n });
    }
    out.push({ src: 'img/kapak2.jpg', alt: 'Arka Kapak' });
    return out;
    
  })();

  const CONFIG = {
    /** Logical page aspect ratio (width / height) of one sheet. */
    pageAspect: 1400 / 1900,
    /** Debounce window for resize-driven layout (ms). */
    resizeDebounceMs: 160,
    /** Preload radius (pages) ahead / behind current view. */
    preloadRadius: 3,
    /** Zoom scale when toggled on. */
    zoomScale: 1.85,
    /** Soft paper sound (replace with your asset). */
    paperSoundUrl: 'audio/ses.mp3',
    /** Geçiş sesi seviyesi (0–1). */
    paperSoundVolume: 0.52,
    /** Hafif oynatma hızı farkı (daha doğal dönüş hissi). */
    paperSoundPlaybackJitter: true,
    /** Aynı hareket için çift sesi önleme (ms). */
    paperSoundMinIntervalMs: 85,
    /** Breakpoint: below this width, prefer single-page mode. */
    singlePageMaxWidth: 820,
    /** When true, portrait + narrow height also forces single mode. */
    preferSingleInPortrait: true,
  };

  // Optional: hydrate from external JSON (same origin recommended).
  // fetch('magazine.json').then(r => r.json()).then(data => { ... });

  // ---------------------------------------------------------------------------
  // State — all interaction locks are centralized here.
  // ---------------------------------------------------------------------------

  const state = {
    $fb: null,
    initialized: false,
    lastDisplay: null,
    lastLayoutKey: '',
    /** True between flip `start` and matching `end` (corner peel lifecycle). */
    peelActive: false,
    zoomed: false,
    panning: false,
    muted: false,
    hashSyncSuspended: false,
    lastTouch: { x: 0, y: 0, t: 0 },
    pan: { x: 0, y: 0 },
    zoomPointerId: null,
    lastTap: { t: 0, x: 0, y: 0 },
    /** İlk layout / hash oturumu bitene kadar sayfa sesi çalınmasın. */
    turnSfxEligibleAt: 0,
    lastPaperSfxAt: 0,
  };

  let paperAudio = null;

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  function debounce(fn, ms) {
    let t = null;
    return function debounced() {
      const ctx = this;
      const args = arguments;
      clearTimeout(t);
      t = setTimeout(function () {
        fn.apply(ctx, args);
      }, ms);
    };
  }

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  function parseHashPage() {
    const raw = (location.hash || '').replace(/^#/, '');
    const m = /^page\/(\d+)$/i.exec(raw);
    if (!m) return null;
    const p = parseInt(m[1], 10);
    return Number.isFinite(p) ? p : null;
  }

  function writeHashForPage(page) {
    const target = '#page/' + page;
    if (location.hash === target) return;
    state.hashSyncSuspended = true;
    try {
      if (history.replaceState) {
        history.replaceState(null, '', location.pathname + location.search + target);
      } else {
        location.hash = target;
      }
    } finally {
      // Defer reset so `hashchange` handlers see the flag.
      setTimeout(function () {
        state.hashSyncSuspended = false;
      }, 0);
    }
  }

  function isSingleDisplayMode() {
    const narrow = window.innerWidth <= CONFIG.singlePageMaxWidth;
    const portrait =
      CONFIG.preferSingleInPortrait &&
      window.matchMedia('(orientation: portrait)').matches &&
      window.innerWidth < 1100;
    return narrow || portrait;
  }

  /**
   * Computes book dimensions to fit the viewport while preserving aspect.
   * Double mode book aspect = 2 * pageAspect : 1 (two sheets side by side).
   */
  function computeBookLayout() {
    const display = isSingleDisplayMode() ? 'single' : 'double';
    const header = document.querySelector('.app-header');
    const toolbar = document.querySelector('.toolbar');
    const headerH = header ? header.getBoundingClientRect().height : 52;
    const toolbarH = toolbar ? toolbar.getBoundingClientRect().height : 56;
    const pad = 24;
    const availW = window.innerWidth - pad * 2;
    const availH = window.innerHeight - headerH - toolbarH - pad * 2;

    const spreadAspect =
      display === 'double' ? CONFIG.pageAspect * 2 : CONFIG.pageAspect;

    let bookW = availW;
    let bookH = bookW / spreadAspect;
    if (bookH > availH) {
      bookH = availH;
      bookW = bookH * spreadAspect;
    }

    bookW = Math.floor(Math.max(220, bookW));
    bookH = Math.floor(Math.max(280, bookH));

    return { width: bookW, height: bookH, display: display };
  }

  function layoutKey(layout) {
    return layout.width + 'x' + layout.height + ':' + layout.display;
  }

  // ---------------------------------------------------------------------------
  // DOM builders
  // ---------------------------------------------------------------------------

  function isKapakName(src) {
    return /kapak|cover/i.test(String(src || ''));
  }

  function buildFlipbookPages() {
    const $fb = $('#flipbook');
    $fb.empty();

    magazinePages.forEach(function (entry, idx) {
      const pageNum = idx + 1;
      const src = typeof entry === 'string' ? entry : entry.src;
      const alt =
        (typeof entry === 'object' && entry.alt) || 'Sayfa ' + pageNum;

      const isFirst = idx === 0;
      const isLast = idx === magazinePages.length - 1;
      // Turn.js adds .turn-page and .pN — only attach modifier classes here.
      const classes = [];
      if (isFirst || isLast) classes.push('hard');
      if (isKapakName(src) || isFirst) classes.push('cover');

      const $page = $('<div/>', { class: classes.join(' ') });
      const $inner = $('<div/>', { class: 'page-inner' });
      const $img = $('<img/>', {
        alt: alt,
        draggable: false,
        'data-page-src': src,
      });

      $inner.append($img);
      $page.append($inner);
      $fb.append($page);
    });
  }

  function getPageImg(page) {
    return $('#flipbook .p' + page + ' img');
  }

  function assignImageIfNeeded(page) {
    const $img = getPageImg(page);
    if (!$img.length) return $.Deferred().resolve().promise();

    const src = $img.attr('data-page-src');
    if (!src) return $.Deferred().resolve().promise();
    if ($img.attr('src') === src) return $.Deferred().resolve().promise();

    const dfd = $.Deferred();
    const img = new Image();
    img.onload = function () {
      $img.attr('src', src);
      dfd.resolve();
    };
    img.onerror = function () {
      $img.attr(
        'src',
        'data:image/svg+xml,' +
          encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="520">' +
              '<rect fill="#eee" width="100%" height="100%"/>' +
              '<text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#999" font-size="18">Yüklenemedi</text></svg>'
          )
      );
      dfd.resolve();
    };
    img.src = src;
    return dfd.promise();
  }

  function preloadAround(centerPage) {
    const total = magazinePages.length;
    if (!total) return;
    const lo = clamp(centerPage - CONFIG.preloadRadius, 1, total);
    const hi = clamp(centerPage + CONFIG.preloadRadius, 1, total);
    const jobs = [];
    for (let p = lo; p <= hi; p++) jobs.push(assignImageIfNeeded(p));
    $.when.apply($, jobs).fail(function () {});
  }

  function loadVisibleView() {
    if (!state.$fb) return $.Deferred().resolve().promise();
    const view = state.$fb.turn('view');
    const jobs = [];
    for (let i = 0; i < view.length; i++) {
      if (view[i]) jobs.push(assignImageIfNeeded(view[i]));
    }
    return $.when.apply($, jobs);
  }

  // ---------------------------------------------------------------------------
  // Sayfa geçişi ses efekti (Turn.js `turning` ile senkron)
  // ---------------------------------------------------------------------------

  function ensureAudio() {
    if (paperAudio) return paperAudio;
    paperAudio = new Audio(CONFIG.paperSoundUrl);
    paperAudio.preload = 'auto';
    paperAudio.volume = CONFIG.paperSoundVolume;
    return paperAudio;
  }

  function unlockAudioGate() {
    const a = ensureAudio();
    const p = a.play();
    if (p && p.catch) {
      p.catch(function () {});
    }
    a.pause();
    a.currentTime = 0;
  }

  /**
   * Gerçek sayfa dönüşü başladığında (`turning`) kısa kağıt sesi.
   * cloneNode ile üst üste binen animasyonlarda ses kesilmez; hafif playbackRate ile varyasyon.
   */
  function playPaperTurnEffect() {
    if (state.muted || state.zoomed) return;
    if (Date.now() < state.turnSfxEligibleAt) return;
    const now = Date.now();
    if (now - state.lastPaperSfxAt < CONFIG.paperSoundMinIntervalMs) return;
    state.lastPaperSfxAt = now;

    const master = ensureAudio();
    try {
      let clip = master;
      if (typeof master.cloneNode === 'function') {
        clip = master.cloneNode(true);
        clip.volume = CONFIG.paperSoundVolume;
        if (CONFIG.paperSoundPlaybackJitter) {
          clip.playbackRate = 0.94 + Math.random() * 0.1;
        }
      } else {
        master.currentTime = 0;
      }
      const p = clip.play();
      if (p && p.catch) {
        p.catch(function () {});
      }
      if (clip !== master) {
        clip.addEventListener(
          'ended',
          function () {
            clip.src = '';
            clip.load();
          },
          { once: true }
        );
      }
    } catch (e) {
      /* ignore */
    }
  }

  function updateSoundButton() {
    const icon = $('#btn-sound i');
    icon.removeClass('fa-volume-high fa-volume-xmark');
    icon.addClass(state.muted ? 'fa-volume-xmark' : 'fa-volume-high');
  }

  // ---------------------------------------------------------------------------
  // Turn.js safe accessors (never throw — broken data() would freeze the UI)
  // ---------------------------------------------------------------------------

  function safeTurnAnimating() {
    try {
      return !!(state.$fb && state.$fb.length && state.$fb.turn('animating'));
    } catch (e) {
      return false;
    }
  }

  function safeTurnPage() {
    try {
      if (!state.$fb || !state.$fb.length) return 1;
      const p = parseInt(state.$fb.turn('page'), 10);
      return Number.isFinite(p) ? p : 1;
    } catch (e) {
      return 1;
    }
  }

  function setLoadingVisible(show) {
    const el = document.getElementById('loading-overlay');
    if (!el) return;
    el.classList.toggle('is-hidden', !show);
    el.setAttribute('aria-busy', show ? 'true' : 'false');
  }

  function updatePageCounter() {
    const cur = safeTurnPage();
    const total = magazinePages.length;
    $('#page-counter').text(cur + ' / ' + total);
  }

  function refreshToolbarAvailability() {
    const $fb = state.$fb;
    const animating = safeTurnAnimating();
    const turnBusy = !$fb || !$fb.length || animating || state.peelActive;
    const navBlocked = turnBusy || state.zoomed;
    const page = safeTurnPage();
    const atStart = $fb && $fb.length && page <= 1;
    const atEnd = $fb && $fb.length && page >= magazinePages.length;
    $('#btn-prev').prop('disabled', navBlocked || atStart);
    $('#btn-next').prop('disabled', navBlocked || atEnd);
    $('#btn-prev-side').prop('disabled', navBlocked || atStart);
    $('#btn-next-side').prop('disabled', navBlocked || atEnd);
    $('#btn-zoom').prop('disabled', turnBusy);
  }

  // ---------------------------------------------------------------------------
  // Zoom + pan (Turn disabled while zoomed — avoids gesture conflicts)
  // ---------------------------------------------------------------------------

  function applyZoomTransform() {
    const $layer = $('#zoom-pan-layer');
    const s = state.zoomed ? CONFIG.zoomScale : 1;
    $layer.css(
      'transform',
      'translate3d(' +
        state.pan.x +
        'px,' +
        state.pan.y +
        'px,0) scale(' +
        s +
        ')'
    );
  }

  function setZoomed(on) {
    state.zoomed = !!on;
    $('#zoom-viewport').toggleClass('is-zoomed', state.zoomed);
    if (!state.zoomed) {
      state.pan = { x: 0, y: 0 };
      state.panning = false;
      $('#zoom-viewport').removeClass('is-panning');
    }
    if (state.$fb) {
      try {
        state.$fb.turn('disable', state.zoomed);
      } catch (e) {
        /* ignore */
      }
    }
    applyZoomTransform();
    const icon = $('#btn-zoom i');
    icon.toggleClass('fa-magnifying-glass-plus', !state.zoomed);
    icon.toggleClass('fa-magnifying-glass-minus', state.zoomed);
    refreshToolbarAvailability();
  }

  function toggleZoom() {
    setZoomed(!state.zoomed);
  }

  function clampPan() {
    const $vp = $('#zoom-viewport');
    const $layer = $('#zoom-pan-layer');
    const vw = $vp.outerWidth();
    const vh = $vp.outerHeight();
    const lw = $layer.outerWidth() * CONFIG.zoomScale;
    const lh = $layer.outerHeight() * CONFIG.zoomScale;
    const maxX = Math.max(0, (lw - vw) / 2);
    const maxY = Math.max(0, (lh - vh) / 2);
    state.pan.x = clamp(state.pan.x, -maxX, maxX);
    state.pan.y = clamp(state.pan.y, -maxY, maxY);
  }

  function bindZoomPan() {
    const blocker = document.getElementById('interaction-blocker');
    if (!blocker) return;

    blocker.addEventListener(
      'pointerdown',
      function (e) {
        if (!state.zoomed) return;
        state.panning = true;
        state.zoomPointerId = e.pointerId;
        blocker.setPointerCapture(e.pointerId);
        $('#zoom-viewport').addClass('is-panning');
        state.lastTouch = { x: e.clientX, y: e.clientY, t: Date.now() };
      },
      { passive: true }
    );

    blocker.addEventListener(
      'pointermove',
      function (e) {
        if (!state.zoomed || !state.panning || e.pointerId !== state.zoomPointerId)
          return;
        const dx = e.clientX - state.lastTouch.x;
        const dy = e.clientY - state.lastTouch.y;
        state.lastTouch.x = e.clientX;
        state.lastTouch.y = e.clientY;
        state.pan.x += dx;
        state.pan.y += dy;
        clampPan();
        applyZoomTransform();
      },
      { passive: true }
    );

    function endPan(e) {
      if (e.pointerId !== state.zoomPointerId) return;
      state.panning = false;
      state.zoomPointerId = null;
      $('#zoom-viewport').removeClass('is-panning');
      try {
        blocker.releasePointerCapture(e.pointerId);
      } catch (err) {
        /* ignore */
      }
    }

    blocker.addEventListener('pointerup', endPan, { passive: true });
    blocker.addEventListener('pointercancel', endPan, { passive: true });
  }

  // ---------------------------------------------------------------------------
  // Turn.js lifecycle
  // ---------------------------------------------------------------------------

  function bindTurnEvents($fb) {
    $fb.on('start', function () {
      if (state.zoomed) return;
      state.peelActive = true;
      refreshToolbarAvailability();
    });

    $fb.on('end', function () {
      state.peelActive = false;
      refreshToolbarAvailability();
    });

    $fb.on('turning', function (e, page) {
      playPaperTurnEffect();
      preloadAround(page);
    });

    $fb.on('turned', function (e, page) {
      /* Köşe sürüklemesi yarım kaldıysa butonların kilitli kalmasını önle */
      state.peelActive = false;
      updatePageCounter();
      writeHashForPage(page);
      preloadAround(page);
      loadVisibleView();
      refreshToolbarAvailability();
    });
  }

  function initTurn(layout) {
    const $fb = $('#flipbook');
    state.$fb = $fb;

    const initialFromHash = parseHashPage();
    const initialPage = clamp(
      initialFromHash != null ? initialFromHash : 1,
      1,
      magazinePages.length
    );

    $fb.turn({
      width: layout.width,
      height: layout.height,
      autoCenter: true,
      display: layout.display,
      duration: 880,
      elevation: 68,
      gradients: true,
      acceleration: true,
      page: initialPage,
    });

    bindTurnEvents($fb);

    $('#flipbook-mount').css({
      width: layout.width,
      height: layout.height,
    });

    state.lastDisplay = layout.display;
    state.initialized = true;
    /* İlk `turning` (yerleşim) kullanıcıya ses patlatmasın */
    state.turnSfxEligibleAt = Date.now() + 480;

    loadVisibleView().always(function () {
      setLoadingVisible(false);
      updatePageCounter();
      refreshToolbarAvailability();
    });
  }

  function applyLayout(layout) {
    const key = layoutKey(layout);
    if (key === state.lastLayoutKey && state.initialized) return;
    state.lastLayoutKey = key;

    $('#flipbook-mount').css({
      width: layout.width,
      height: layout.height,
    });

    if (!state.initialized) {
      setLoadingVisible(true);
      buildFlipbookPages();
      initTurn(layout);
      return;
    }

    const $fb = state.$fb;
    if (!$fb) return;

    // Stop mid-flight animations before mutating display to avoid stuck peels.
    try {
      $fb.turn('stop');
    } catch (e) {
      /* ignore */
    }

    if (layout.display !== state.lastDisplay) {
      try {
        $fb.turn('display', layout.display);
      } catch (e) {
        /* ignore */
      }
      state.lastDisplay = layout.display;
    }

    try {
      $fb.turn('size', layout.width, layout.height);
    } catch (e) {
      /* ignore */
    }

    preloadAround($fb.turn('page'));
    loadVisibleView();
    refreshToolbarAvailability();
  }

  const debouncedLayout = debounce(function () {
    applyLayout(computeBookLayout());
  }, CONFIG.resizeDebounceMs);

  // ---------------------------------------------------------------------------
  // Navigation (debounced / mutexed)
  // ---------------------------------------------------------------------------

  function canUseNav() {
    if (!state.$fb || state.zoomed) return false;
    if (safeTurnAnimating() || state.peelActive) return false;
    return true;
  }

  function goPrevious() {
    if (!canUseNav()) return;
    try {
      state.$fb.turn('previous');
    } catch (e) {
      /* ignore */
    }
  }

  function goNext() {
    if (!canUseNav()) return;
    try {
      state.$fb.turn('next');
    } catch (e) {
      /* ignore */
    }
  }

  function goToPage(page) {
    if (!state.$fb || state.zoomed) return;
    if (safeTurnAnimating() || state.peelActive) return;
    const p = clamp(page, 1, magazinePages.length);
    try {
      state.$fb.turn('page', p);
    } catch (e) {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------------------
  // Fullscreen
  // ---------------------------------------------------------------------------

  function toggleFullscreen() {
    const root = document.documentElement;
    if (!document.fullscreenElement) {
      root.requestFullscreen &&
        root.requestFullscreen().catch(function () {});
    } else {
      document.exitFullscreen && document.exitFullscreen();
    }
  }

  function syncFullscreenClass() {
    document.body.classList.toggle('is-fullscreen', !!document.fullscreenElement);
    const icon = $('#btn-fullscreen i');
    icon.toggleClass('fa-expand', !document.fullscreenElement);
    icon.toggleClass('fa-compress', !!document.fullscreenElement);
  }

  // ---------------------------------------------------------------------------
  // Swipe + double-tap (scoped listeners; do not set touch-action:none globally)
  // ---------------------------------------------------------------------------

  function bindSwipeOnShell() {
    const shell = document.getElementById('book-shell');
    if (!shell) return;

    let sx = 0;
    let sy = 0;
    let st = 0;

    shell.addEventListener(
      'touchstart',
      function (e) {
        if (e.touches.length !== 1) return;
        const t = e.touches[0];
        sx = t.clientX;
        sy = t.clientY;
        st = Date.now();
      },
      { passive: true }
    );

    shell.addEventListener(
      'touchend',
      function (e) {
        if (state.zoomed) return;
        if (!e.changedTouches.length) return;
        const t = e.changedTouches[0];
        const dt = Date.now() - st;
        const dx = t.clientX - sx;
        const dy = t.clientY - sy;
        if (dt > 320) return;
        if (Math.abs(dx) < 56) return;
        if (Math.abs(dy) > 95) return;
        if (state.peelActive || (state.$fb && safeTurnAnimating())) return;
        if (dx < 0) goNext();
        else goPrevious();
      },
      { passive: true }
    );
  }

  function bindDoubleTapZoom() {
    const vp = document.getElementById('zoom-viewport');
    if (!vp) return;

    vp.addEventListener(
      'pointerup',
      function (e) {
        if (e.pointerType !== 'touch') return;
        const now = Date.now();
        const dt = now - state.lastTap.t;
        const dist = Math.hypot(e.clientX - state.lastTap.x, e.clientY - state.lastTap.y);
        state.lastTap = { t: now, x: e.clientX, y: e.clientY };
        if (dt < 320 && dist < 36) {
          if (state.$fb && (safeTurnAnimating() || state.peelActive)) return;
          toggleZoom();
        }
      },
      { passive: true }
    );
  }

  // ---------------------------------------------------------------------------
  // Hash sync
  // ---------------------------------------------------------------------------

  function onHashChange() {
    if (state.hashSyncSuspended) return;
    const p = parseHashPage();
    if (p == null) return;
    goToPage(p);
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  function boot() {
    if (!$.isFunction($.fn.turn)) {
      // eslint-disable-next-line no-console
      console.error('Turn.js failed to load.');
      setLoadingVisible(false);
      return;
    }

    if (!magazinePages.length) {
      // eslint-disable-next-line no-console
      console.warn('magazinePages is empty — add image URLs.');
      setLoadingVisible(false);
      return;
    }

    document.addEventListener(
      'pointerdown',
      function () {
        unlockAudioGate();
      },
      { once: true, passive: true }
    );

    $('#btn-prev, #btn-prev-side').on('click', goPrevious);
    $('#btn-next, #btn-next-side').on('click', goNext);
    $('#btn-zoom').on('click', toggleZoom);
    $('#btn-fullscreen').on('click', toggleFullscreen);
    $('#btn-sound').on('click', function () {
      state.muted = !state.muted;
      updateSoundButton();
    });

    document.addEventListener('fullscreenchange', syncFullscreenClass);
    syncFullscreenClass();

    $(window).on('keydown', function (e) {
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.isDefaultPrevented()) return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goPrevious();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        goNext();
      }
    });

    $(window).on('resize orientationchange', debouncedLayout);
    $(window).on('hashchange', onHashChange);

    bindZoomPan();
    bindSwipeOnShell();
    bindDoubleTapZoom();
    updateSoundButton();

    // Kick layout once DOM is painted.
    requestAnimationFrame(function () {
      applyLayout(computeBookLayout());
    });

    // Safety: never leave the loader stuck if Turn or images misbehave.
    setTimeout(function () {
      setLoadingVisible(false);
    }, 12000);
  }

  $(boot);
})(window, document, jQuery);
