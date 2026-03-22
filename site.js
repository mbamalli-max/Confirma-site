var DEFAULT_CONFIRMA_APP_URL = window.location.origin + "/app";

window.CONFIRMA_APP_URL = window.CONFIRMA_APP_URL || DEFAULT_CONFIRMA_APP_URL;

document.addEventListener("DOMContentLoaded", function () {
  var appUrl = window.CONFIRMA_APP_URL;

  document.querySelectorAll("[data-confirma-app-link]").forEach(function (link) {
    link.setAttribute("href", appUrl);
  });

  document.querySelectorAll("[data-confirma-app-text]").forEach(function (node) {
    node.textContent = appUrl;
  });
});
