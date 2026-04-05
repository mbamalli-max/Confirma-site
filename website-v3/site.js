var DEFAULT_CONFIRMA_APP_URL = "https://confirma-site.vercel.app/app";

window.CONFIRMA_APP_URL = window.CONFIRMA_APP_URL || DEFAULT_CONFIRMA_APP_URL;

document.addEventListener("DOMContentLoaded", function () {
  var appUrl = window.CONFIRMA_APP_URL;
  var nav = document.querySelector("[data-nav]");
  var toggle = document.querySelector("[data-menu-toggle]");

  document.querySelectorAll("[data-confirma-app-link]").forEach(function (link) {
    link.setAttribute("href", appUrl);
  });

  document.querySelectorAll("[data-confirma-app-text]").forEach(function (node) {
    node.textContent = appUrl;
  });

  if (toggle && nav) {
    toggle.addEventListener("click", function () {
      var isOpen = nav.classList.toggle("open");
      toggle.setAttribute("aria-expanded", String(isOpen));
    });

    nav.querySelectorAll("a").forEach(function (link) {
      link.addEventListener("click", function () {
        nav.classList.remove("open");
        toggle.setAttribute("aria-expanded", "false");
      });
    });
  }

  if ("IntersectionObserver" in window) {
    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15, rootMargin: "0px 0px -40px 0px" }
    );

    document.querySelectorAll("[data-reveal]").forEach(function (node) {
      observer.observe(node);
    });
  } else {
    document.querySelectorAll("[data-reveal]").forEach(function (node) {
      node.classList.add("is-visible");
    });
  }
});
