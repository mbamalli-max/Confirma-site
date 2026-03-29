/* ============================================================
   Konfirmata — Site JavaScript
   App URL binding + Scroll animations (IntersectionObserver)
   ============================================================ */

var DEFAULT_CONFIRMA_APP_URL = window.location.origin + "/app";

window.CONFIRMA_APP_URL = window.CONFIRMA_APP_URL || DEFAULT_CONFIRMA_APP_URL;

document.addEventListener("DOMContentLoaded", function () {
  // ── App URL binding ──────────────────────────────────────
  var appUrl = window.CONFIRMA_APP_URL;

  document.querySelectorAll("[data-confirma-app-link]").forEach(function (link) {
    link.setAttribute("href", appUrl);
  });

  document.querySelectorAll("[data-confirma-app-text]").forEach(function (node) {
    node.textContent = appUrl;
  });

  // ── Mobile nav toggle ────────────────────────────────────
  var toggle = document.querySelector('.menu-toggle');
  var nav = document.getElementById('main-nav');
  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      var open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open);
    });
  }

  // ── Scroll animations ────────────────────────────────────

  // 1. Add fade-up class to animatable elements
  var animateSelectors = [
    '.card', '.card-accent', '.timeline', '.story', '.install-card',
    '.trust-band', '.quote-card', '.faq-item', '.section-header', '.hero-panel'
  ].join(', ');

  document.querySelectorAll(animateSelectors).forEach(function (el) {
    // Skip elements inside the hero (hero-panel handled separately via hero-text)
    if (!el.classList.contains('hero-panel') || !el.closest('.hero')) {
      el.classList.add('fade-up');
    }
  });

  // Also animate hero-panel elements inside hero sections
  document.querySelectorAll('.hero .hero-panel').forEach(function (el) {
    el.classList.add('fade-up');
  });

  // 2. Stagger delays on grid children
  var gridSelectors = '.grid-3, .grid-2, .story-grid, .install-grid, .audience-grid, .timeline-grid, .trust-grid';
  document.querySelectorAll(gridSelectors).forEach(function (grid) {
    var children = grid.children;
    for (var i = 0; i < children.length; i++) {
      if (children[i].classList.contains('fade-up')) {
        children[i].style.transitionDelay = (i * 0.1) + 's';
      }
    }
  });

  // 3. Trust belt item stagger
  document.querySelectorAll('.trust-belt-inner').forEach(function (belt) {
    var items = belt.querySelectorAll('.trust-item');
    for (var i = 0; i < items.length; i++) {
      items[i].classList.add('fade-up');
      items[i].style.transitionDelay = (i * 0.08) + 's';
    }
  });

  // 4. Hero text fade-in on load
  document.querySelectorAll('.hero-grid > div:first-child, .page-hero > div:first-child').forEach(function (el) {
    el.classList.add('hero-text');
  });

  // 5. Section header smooth reveal (also add to fade-up observer)
  document.querySelectorAll('.section-header').forEach(function (el) {
    if (!el.classList.contains('fade-up')) {
      el.classList.add('fade-up');
    }
  });

  // 6. IntersectionObserver for all fade-up elements
  if ('IntersectionObserver' in window) {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          observer.unobserve(entry.target);
        }
      });
    }, {
      threshold: 0.08,
      rootMargin: '0px 0px -50px 0px'
    });

    document.querySelectorAll('.fade-up').forEach(function (el) {
      observer.observe(el);
    });
  } else {
    // Fallback for browsers without IntersectionObserver
    document.querySelectorAll('.fade-up').forEach(function (el) {
      el.classList.add('visible');
    });
  }
});
