var DEFAULT_CONFIRMA_APP_URL = "https://your-confirma-app.vercel.app";

window.CONFIRMA_APP_URL = window.CONFIRMA_APP_URL || DEFAULT_CONFIRMA_APP_URL;

document.addEventListener("DOMContentLoaded", function () {
  var appUrl = window.CONFIRMA_APP_URL;
  var usingPlaceholder = appUrl === DEFAULT_CONFIRMA_APP_URL;

  document.querySelectorAll("[data-confirma-app-link]").forEach(function (link) {
    if (usingPlaceholder) {
      link.setAttribute("href", "#set-live-url");
      link.textContent = "Set live app link";
      return;
    }

    link.setAttribute("href", appUrl);
  });

  document.querySelectorAll("[data-confirma-app-text]").forEach(function (node) {
    node.textContent = appUrl;
  });
});
