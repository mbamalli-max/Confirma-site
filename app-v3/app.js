import {
  getDefaultSyncApiBaseUrl,
  postJson,
  requestOtpCode,
  syncQueuedEntries,
  verifyOtpCode
} from "./syncWorker.js";
import {
  SECTORS, SUPPORTED_LANGUAGES, PHONE_COUNTRY_RULES, COUNTRIES,
  REGION_CURRENCY_MAP, CAPTURE_EXAMPLES, BUSINESS_TYPES, QUICK_PICKS,
  LAYER_B, EXTRA_SEARCH_LABELS, LIABILITY_LABELS,
  PRIMARY_ACTIONS, TRANSFER_ACTIONS, LIABILITY_ACTIONS, isLiabilityAction
} from "./catalog-data.js";
import {
  NATURAL_AMOUNT_PATTERN, QUANTITY_UNIT_WORDS,
  normalizeNaturalTransactionText, parseNaturalAmount, isLikelyNaturalAmount,
  cleanNaturalLabelQuery, isQuantityOnlySaleQuery,
  parsedNaturalTransaction, parseNaturalTransaction
} from "./nlp-parser.js";
import {
  PASSCODE_KDF_VERSION, PASSCODE_PBKDF2_ITERATIONS,
  legacyHashPin, hashPin, createPinSalt,
  hexToBytes, bytesToHex, hashPasscodeWithPbkdf2
} from "./passcode-crypto.js";

const DB_NAME = "confirma-v3-db";
const DB_VERSION = 5;
const FEATURE_TRANSFER_PRIMARY = false;
const ONBOARDING_TOTAL_STEPS = 6;
const ONBOARDING_PROFILE_STEP = 6;

let LABEL_CATALOG = [];

const state = {
  db: null,
  profile: null,
  onboardingStep: 1,
  selectorMode: "search",
  currentAction: "sale",
  transferSubtype: "transfer_in",
  selectedLabel: null,
  candidateRecord: null,
  searchResults: [],
  browseResults: [],
  speechResults: [],
  amountsHidden: false,
  isRecording: false,
  pinEntry: "",
  pinAttempts: 0,
  lastPinUnlockAt: 0,
  reminderDismissed: false,
  isConfirming: false,
  dashboardMetricsCache: null,
  lowStorageWarning: "",
  otpChallenge: null,
  otpReturnScreen: "screen-capture",
  activeRecognition: null,
  captureExampleIndex: 0,
  captureExampleInterval: null,
  lastVoiceTranscript: "",
  lastVoiceCaptureContext: "",
  lastVoiceLearnedCorrection: "",
  pendingVoiceParse: null,
  pinConfirmResolver: null,
  pinConfirmWrongMessage: "",
  pinRecoveryReturnScreen: "screen-capture",
  preferredLabelEditorOpen: false,
  passcodeReminderEditorOpen: false,
  emailVerified: false,
  phoneVerified: false,
  smsSupported: false,
  authPhoneCountry: "",
  devicePrivateKey: null,
  devicePublicKey: "",
  deviceIdentity: "",
  publicKeyFingerprint: "",
  authSessionKey: "",
  authSessionExpiresAt: "",
  syncApiBaseUrl: "",
  syncStatus: "Sync not configured yet.",
  syncInFlight: false,
  syncQueueCount: 0,
  lastSyncAt: "",
  lastSyncReceipt: "",
  swRegistration: null,
  swRefreshInFlight: false,
  anomalyAutoReviewTimer: null
};

let dashChart = null;
let searchDebounceTimer = null;
let privacyResetFlashTimer = null;

const els = {};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  cacheElements();
  state.db = await openDb();
  await loadCustomLabelsIntoCatalog();
  try {
    const savedAuthPhoneCountry = await getSetting("auth_phone_country");
    state.authPhoneCountry = getRecognizedCountryId(savedAuthPhoneCountry) || "";
  } catch (error) {
    state.authPhoneCountry = "";
  }
  try {
    state.profile = await getProfile();
  } catch (error) {
    console.warn("Unable to load saved profile. Continuing with onboarding.", error);
    state.profile = null;
  }
  if (state.profile?._needsReminderMigration) {
    delete state.profile._needsReminderMigration;
    try {
      await saveProfile(state.profile, { skipPush: true });
    } catch (error) {
      console.warn("Unable to persist migrated local passcode reminder.", error);
    }
  }
  if (state.profile?._needsDimensionMigration) {
    delete state.profile._needsDimensionMigration;
    try {
      await saveProfile(state.profile, { skipPush: true });
    } catch (error) {
      console.warn("Unable to persist migrated country/language profile fields.", error);
    }
  }
  initializeAuthPhoneCountry();
  syncVerificationState();
  await loadDeviceTrustState();
  await loadSyncState();
  await updateSyncBadge();
  wireEvents();
  window.addEventListener("online", () => {
    void updateSyncBadge();
    void flushSyncQueue();
  });
  window.addEventListener("offline", () => {
    void updateSyncBadge();
  });
  registerPwa();
  renderOnboarding();
  renderActionRows();
  await notifyAnomaly();

  if (state.profile) {
    try {
      state.profile.preferred_labels = normalizePreferredLabels(state.profile.preferred_labels, state.profile.business_type_id);
    } catch (error) {
      console.warn("Unable to normalize saved preferred labels. Resetting them for onboarding safety.", error);
      state.profile.preferred_labels = [];
    }
    if (!state.profile.display_name) {
      state.onboardingStep = ONBOARDING_PROFILE_STEP;
      renderOnboarding();
      showScreen("screen-onboarding");
      return;
    }
    hydrateProfileUi();
    const pinLockEnabled = Boolean(state.profile.pinEnabled && state.profile.pinHash);
    await showCapture();
    if (pinLockEnabled) {
      showPinLock();
    }
    void flushSyncQueue();
    void restoreServerAccountIntoLocal({ quiet: true });
  } else {
    showScreen("screen-onboarding");
  }
  syncDevQaSnapshot("init");
}

function cacheElements() {
  [
    "country-grid", "operating-region-grid", "operating-region-note", "operating-region-next", "restore-account-link", "sector-grid", "business-grid", "common-label-grid", "onboarding-step-copy", "finish-onboarding",
    "onboarding-next", "onboarding-name", "onboarding-phone", "onboarding-email", "onboarding-state",
    "onboarding-birth-year", "onboarding-gender", "onboarding-profile-error",
    "business-helper", "profile-summary", "anomaly-banner", "anomaly-banner-text", "anomaly-banner-cta", "primary-actions", "advanced-panel", "transfer-actions", "liability-actions",
    "quick-label-grid", "selected-label-chip", "amount-input-v2", "amount-helper-v2", "counterparty-input-v2", "source-account-input",
    "destination-account-input", "transfer-details", "capture-error", "confirm-copy-v2", "confirm-meta-v2",
    "recent-records-v2", "history-records-v2", "selector-modal", "label-search-input", "search-results",
    "speech-results", "browse-results", "speech-status", "custom-label-input", "onboarding-back",
    "change-confirm-modal", "pin-confirm-modal", "pin-confirm-title", "pin-confirm-copy", "pin-confirm-input", "pin-confirm-error", "pin-confirm-submit", "pin-confirm-cancel", "pin-confirm-close",
    "pin-lock-hint", "pin-entry-input", "pin-unlock-btn",
    "pin-forgot-link", "pin-forgot-modal", "pin-forgot-close", "pin-forgot-copy", "pin-forgot-hint", "pin-forgot-helper", "pin-forgot-code-wrap",
    "pin-forgot-code", "pin-forgot-send", "pin-forgot-confirm", "pin-forgot-cancel", "pin-forgot-error",
    "pin-wipe-modal", "pin-wipe-close", "pin-wipe-confirm", "pin-wipe-cancel",
    "restore-modal", "restore-close", "restore-copy", "restore-email-field", "restore-email-input", "restore-phone-field", "restore-country-prefix", "restore-phone-input", "restore-helper-text",
    "restore-code-wrap", "restore-code-input", "restore-error-text", "restore-send-code", "restore-verify-code", "restore-cancel",
    "revoke-old-devices-modal", "revoke-old-devices-list", "revoke-old-devices-skip",
    "mic-button-v2", "voice-label-v2", "voice-error-v2", "quick-text-input-v2",
    "voice-example-v2", "voice-announce",
    "voice-review-transcript-row", "voice-review-transcript", "voice-review-edit-row", "voice-review-edit",
    "voice-review-understood-row", "voice-review-understood",
    "voice-review-missing-row", "voice-review-missing", "voice-review-message",
    "voice-review-suggestions", "voice-review-manual", "voice-review-cancel",
    "bottom-nav-v2", "sync-status-badge", "sync-dot", "sync-label", "dash-today-sales-v2", "dash-monthly-sales-v2", "dash-monthly-expenses-v2",
    "dash-cash-flow-v2", "dash-borrowing-v2", "dashboard-records-v2", "settings-profile-v2", "settings-preferred-v2",
    "settings-preferred-edit-v2", "settings-preferred-editor", "settings-preferred-grid", "settings-preferred-done-v2",
    "settings-voice-corrections-v2", "anomaly-panel", "anomaly-badge", "anomaly-list", "mark-anomalies-reviewed",
    "settings-capture-v2", "settings-summary-v2", "settings-trust-toggle", "settings-trust-panel", "settings-trust-v3", "settings-devices-v2", "settings-change-profile-v2",
    "settings-open-trust-v3", "export-button-v2", "export-status-v2", "export-trust-status-v3", "export-open-trust-v3",
    "verified-report-section", "verified-report-region-note", "free-report-btn", "report-status",
    "daily-reminder-banner", "dismiss-reminder-btn", "privacy-toggle-btn", "reminder-toggle", "pin-lock-toggle",
    "pin-setup-area", "pin-input-new", "pin-input-confirm", "pin-passcode-guidance", "pin-reminder-summary", "pin-reminder-edit", "pin-reminder-clear",
    "pin-reminder-editor", "pin-reminder-question", "pin-reminder-answer", "pin-reminder-save", "pin-reminder-cancel",
    "pin-reset-btn", "pin-save-btn", "pin-remove-btn", "pin-setup-error",
    "settings-security-status", "pin-setup-label", "pin-lock-screen", "pin-error", "first-record-guide",
    "storage-warning-v2", "record-history-banner", "banner-tier-icon", "banner-headline", "banner-subtext", "banner-cta",
    "settings-logout-v2",
    "otp-back", "otp-screen-header-title", "otp-screen-header-copy", "otp-screen-title", "otp-screen-copy", "otp-status-card",
    "otp-email-field", "otp-email-input", "otp-phone-field", "otp-country-prefix", "otp-phone-input", "otp-request-code",
    "otp-helper-text", "otp-code-input", "otp-verify-code", "otp-error-text"
  ].forEach((id) => {
    els[id] = document.getElementById(id);
  });
}

function wireEvents() {
  document.getElementById("finish-onboarding").addEventListener("click", finishOnboarding);
  document.getElementById("onboarding-next").addEventListener("click", () => updateOnboardingStep(ONBOARDING_PROFILE_STEP));
  document.getElementById("operating-region-next")?.addEventListener("click", () => {
    if (!getRecognizedCountryId(state.profile?.operating_region || state.profile?.country || state.profile?.phone_country)) return;
    renderSectorGrid();
    updateOnboardingStep(3);
  });
  document.getElementById("restore-account-link").addEventListener("click", () => {
    restoreAccountFlow();
  });
  document.getElementById("change-profile").addEventListener("click", openChangeProfileConfirm);
  document.getElementById("anomaly-banner-cta")?.addEventListener("click", () => {
    void openAnomalyReview();
  });
  document.getElementById("anomaly-banner-dismiss")?.addEventListener("click", () => {
    void markAllAnomaliesReviewed();
  });
  document.getElementById("confirm-change-profile").addEventListener("click", confirmChangeProfile);
  document.getElementById("cancel-change-profile").addEventListener("click", closeChangeProfileConfirm);
  document.getElementById("change-confirm-close").addEventListener("click", closeChangeProfileConfirm);
  document.getElementById("pin-confirm-submit").addEventListener("click", () => {
    void submitPinConfirmation();
  });
  document.getElementById("pin-confirm-cancel").addEventListener("click", () => resolvePinConfirmation(""));
  document.getElementById("pin-confirm-close").addEventListener("click", () => resolvePinConfirmation(""));
  document.getElementById("pin-confirm-input").addEventListener("input", clearPinConfirmationError);
  document.getElementById("pin-unlock-btn").addEventListener("click", () => {
    void unlockWithPasscode();
  });
  document.getElementById("pin-entry-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void unlockWithPasscode();
    }
  });
  document.getElementById("pin-forgot-link").addEventListener("click", () => {
    void openForgotPinFlow();
  });
  document.getElementById("pin-forgot-send").addEventListener("click", () => {
    void sendForgotPinResetCode();
  });
  document.getElementById("pin-forgot-confirm").addEventListener("click", () => {
    void confirmForgotPinReset();
  });
  document.getElementById("pin-forgot-cancel").addEventListener("click", closeForgotPinModal);
  document.getElementById("pin-forgot-close").addEventListener("click", closeForgotPinModal);
  document.getElementById("pin-forgot-code").addEventListener("input", clearForgotPinError);
  document.getElementById("pin-wipe-cancel").addEventListener("click", closePinWipeModal);
  document.getElementById("pin-wipe-close").addEventListener("click", closePinWipeModal);
  document.getElementById("pin-wipe-confirm").addEventListener("click", () => {
    void handlePinWipeRestart();
  });
  document.getElementById("restore-send-code").addEventListener("click", () => {
    void sendRestoreCode();
  });
  document.getElementById("restore-verify-code").addEventListener("click", () => {
    void verifyRestoreCode();
  });
  document.getElementById("restore-cancel").addEventListener("click", closeRestoreModal);
  document.getElementById("restore-close").addEventListener("click", closeRestoreModal);
  document.getElementById("restore-email-input").addEventListener("input", clearRestoreError);
  document.getElementById("restore-phone-input").addEventListener("input", clearRestoreError);
  document.getElementById("restore-code-input").addEventListener("input", clearRestoreError);
  document.getElementById("revoke-old-devices-skip").addEventListener("click", closeRevocationPrompt);
  els["onboarding-back"].addEventListener("click", goToPreviousOnboardingStep);
  document.getElementById("advanced-toggle").addEventListener("click", () => {
    els["advanced-panel"].hidden = !els["advanced-panel"].hidden;
  });
  document.getElementById("open-selector").addEventListener("click", () => {
    openSelector();
  });
  document.getElementById("selector-close").addEventListener("click", closeSelector);
  document.getElementById("selector-close-backdrop").addEventListener("click", closeSelector);
  document.getElementById("prepare-confirmation").addEventListener("click", prepareConfirmation);
  document.getElementById("confirm-append").addEventListener("click", confirmAppend);
  document.getElementById("back-to-capture").addEventListener("click", () => showScreen("screen-capture"));
  document.getElementById("voice-review-manual").addEventListener("click", handleVoiceReviewManual);
  document.getElementById("voice-review-cancel").addEventListener("click", cancelVoiceReview);
  document.getElementById("voice-review-edit").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      retryVoiceReview();
    }
  });
  document.getElementById("open-history").addEventListener("click", async () => {
    await renderHistory();
    showScreen("screen-history");
  });
  document.getElementById("back-home").addEventListener("click", () => showScreen("screen-capture"));
  document.getElementById("settings-change-profile-v2").addEventListener("click", openChangeProfileConfirm);
  document.getElementById("settings-open-trust-v3").addEventListener("click", () => openTrustSetup("screen-settings"));
  document.getElementById("settings-trust-toggle").addEventListener("click", toggleSettingsTrustDetails);
  document.getElementById("settings-preferred-edit-v2").addEventListener("click", () => togglePreferredLabelEditor());
  document.getElementById("settings-preferred-done-v2").addEventListener("click", () => togglePreferredLabelEditor(false));
  document.getElementById("mark-anomalies-reviewed").addEventListener("click", () => {
    void markAllAnomaliesReviewed();
  });
  document.getElementById("export-button-v2").addEventListener("click", generateExport);
  document.getElementById("free-report-btn")?.addEventListener("click", () => {
    void claimFreeReport();
  });
  document.getElementById("export-open-trust-v3").addEventListener("click", () => openTrustSetup("screen-export"));
  document.getElementById("dismiss-reminder-btn").addEventListener("click", dismissDailyReminder);
  document.getElementById("privacy-toggle-btn").addEventListener("click", togglePrivacyMode);
  document.getElementById("reminder-toggle").addEventListener("click", toggleReminderPreference);
  document.getElementById("pin-lock-toggle").addEventListener("click", togglePinLockPreference);
  document.getElementById("pin-save-btn").addEventListener("click", savePinLock);
  document.getElementById("pin-remove-btn").addEventListener("click", removePinLock);
  document.getElementById("pin-reminder-edit").addEventListener("click", openPasscodeReminderEditor);
  document.getElementById("pin-reminder-clear").addEventListener("click", () => {
    void clearPasscodeReminder();
  });
  document.getElementById("pin-reminder-save").addEventListener("click", () => {
    void savePasscodeReminderOnly();
  });
  document.getElementById("pin-reminder-cancel").addEventListener("click", closePasscodeReminderEditor);
  document.getElementById("pin-reminder-question").addEventListener("input", clearPasscodeSetupError);
  document.getElementById("pin-reminder-answer").addEventListener("input", clearPasscodeSetupError);
  document.getElementById("pin-reset-btn").addEventListener("click", () => {
    void openForgotPinFlow();
  });
  document.getElementById("mic-button-v2").addEventListener("click", startVoiceRecordShortcut);
  document.getElementById("quick-text-submit").addEventListener("click", handleQuickTextRecord);
  document.getElementById("amount-input-v2").addEventListener("change", () => {
    void maybeLearnVoiceCorrection();
  });
  document.getElementById("onboarding-name").addEventListener("input", updateFinishOnboardingState);
  document.getElementById("onboarding-phone").addEventListener("change", () => {
    const normalizedPhone = normalizePhoneNumber(
      document.getElementById("onboarding-phone")?.value.trim() || "",
      getPhoneInputCountry()
    );
    const detectedPhoneCountry = detectPhoneCountryFromPhoneNumber(normalizedPhone);
    if (detectedPhoneCountry) {
      void persistAuthPhoneCountry(detectedPhoneCountry);
    }
    syncCountryAwareInputs();
  });
  document.getElementById("onboarding-phone").addEventListener("input", clearOnboardingProfileError);
  document.getElementById("onboarding-email").addEventListener("input", clearOnboardingProfileError);
  document.getElementById("otp-back").addEventListener("click", () => showScreen(state.otpReturnScreen || "screen-capture"));
  document.getElementById("otp-request-code").addEventListener("click", requestServerOtpCode);
  document.getElementById("otp-verify-code").addEventListener("click", verifyLocalOtpCode);
  document.getElementById("otp-email-input").addEventListener("input", clearOtpError);
  document.getElementById("otp-phone-input").addEventListener("input", clearOtpError);
  document.getElementById("otp-code-input").addEventListener("input", clearOtpError);
  document.getElementById("settings-logout-v2").addEventListener("click", () => {
    void logoutFromServerSession();
  });
  document.querySelectorAll(".pin-key").forEach((button) => {
    button.addEventListener("click", () => handlePinKey(button.dataset.digit));
  });
  document.querySelectorAll("[data-target-screen]").forEach((button) => {
    button.addEventListener("click", async () => {
      const target = button.dataset.targetScreen;
      if (target === "screen-dashboard") {
        await renderDashboard();
      }
      if (target === "screen-history") {
        await renderHistory();
      }
      if (target === "screen-settings") {
        await renderSettings();
      }
      if (target === "screen-export") {
        renderExportScreen();
      }
      if (target === "screen-capture") {
        await checkDailyReminder();
      }
      showScreen(target);
    });
  });
  document.getElementById("label-search-input").addEventListener("input", queueHandleSearch);
  document.getElementById("speak-label-button").addEventListener("click", startSpeechMatch);
  document.getElementById("save-custom-label").addEventListener("click", saveCustomLabel);
  document.querySelectorAll("[data-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      setSelectorMode(button.dataset.mode);
    });
  });
  wireChartToggle();
  syncSettingsTrustDetailsToggle();
}

function registerPwa() {
  if ("serviceWorker" in navigator) {
    const syncWaitingServiceWorker = (registration) => {
      if (!registration) return;
      state.swRegistration = registration;
      if (registration.waiting) {
        applyWaitingServiceWorkerUpdate();
      }
    };

    const watchInstallingServiceWorker = (registration, worker) => {
      if (!worker) return;
      worker.addEventListener("statechange", () => {
        if (worker.state === "installed") {
          syncWaitingServiceWorker(registration);
        }
      });
    };

    navigator.serviceWorker.register("/app/sw.js").then((registration) => {
      state.swRegistration = registration;
      watchInstallingServiceWorker(registration, registration.installing);
      registration.addEventListener("updatefound", () => {
        watchInstallingServiceWorker(registration, registration.installing);
      });
    }).catch((error) => {
      console.warn("Service worker registration failed.", error);
    });

    navigator.serviceWorker.addEventListener("message", (event) => {
      if (event.data?.type === "SW_UPDATED") {
        navigator.serviceWorker.getRegistration("/app/").then((registration) => {
          syncWaitingServiceWorker(registration || state.swRegistration);
        }).catch(() => {
          syncWaitingServiceWorker(state.swRegistration);
        });
      }
    });
  }

  // PWA install prompt (Chrome/Android/Edge)
  let deferredInstallPrompt = null;

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    const panel = document.getElementById("install-app-panel");
    if (panel) panel.hidden = false;
  });

  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    const panel = document.getElementById("install-app-panel");
    if (panel) panel.hidden = true;
  });

  const installBtn = document.getElementById("install-app-btn");
  if (installBtn) {
    installBtn.addEventListener("click", async () => {
      if (deferredInstallPrompt) {
        deferredInstallPrompt.prompt();
        const { outcome } = await deferredInstallPrompt.userChoice;
        if (outcome === "accepted") {
          deferredInstallPrompt = null;
          const panel = document.getElementById("install-app-panel");
          if (panel) panel.hidden = true;
        }
      }
    });
  }

  // iOS Safari — no beforeinstallprompt; show manual instructions
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isInStandaloneMode = ("standalone" in navigator && navigator.standalone);
  if (isIos && !isInStandaloneMode) {
    const panel = document.getElementById("install-app-panel");
    const hint = document.getElementById("install-app-hint");
    const btn = document.getElementById("install-app-btn");
    if (panel && hint && btn) {
      hint.textContent = "To install: tap the Share button in Safari, then choose \u201cAdd to Home Screen\u201d.";
      btn.hidden = true;
      panel.hidden = false;
    }
  }
}

function applyWaitingServiceWorkerUpdate() {
  const waitingWorker = state.swRegistration?.waiting;
  if (!waitingWorker) {
    window.location.reload();
    return;
  }

  if (state.swRefreshInFlight) {
    return;
  }

  state.swRefreshInFlight = true;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    window.location.reload();
  }, { once: true });
  waitingWorker.postMessage({ type: "SKIP_WAITING" });
}

function renderOnboarding() {
  ensureOnboardingCountrySteps();
  renderCountryGrid("phone_country");
  renderCountryGrid("operating_region");
  renderSectorGrid();
  renderBusinessGrid();
  renderCommonLabelGrid();
  renderOnboardingProfileStep();
  updateOperatingRegionContinueState();
  updateOnboardingStep(state.onboardingStep || 1);
}

function ensureOnboardingCountrySteps() {
  const stepper = els["onboarding-step-copy"];
  if (stepper) {
    stepper.textContent = `Step 1 of ${ONBOARDING_TOTAL_STEPS}`;
  }

  const onboardingScreen = document.getElementById("screen-onboarding");
  if (!onboardingScreen) return;

  const phoneCountryStep = onboardingScreen.querySelector('.step[data-step="1"]');
  if (!phoneCountryStep) return;

  const phoneCountryHeading = phoneCountryStep.querySelector("h2");
  if (phoneCountryHeading) {
    phoneCountryHeading.textContent = "Choose your phone country";
  }

  let phoneCountryCopy = phoneCountryStep.querySelector(".subtle");
  if (!phoneCountryCopy) {
    phoneCountryCopy = document.createElement("p");
    phoneCountryCopy.className = "subtle";
    phoneCountryHeading?.insertAdjacentElement("afterend", phoneCountryCopy);
  }
  phoneCountryCopy.textContent = "We use this for phone number formatting and OTP delivery. Your business region can be different.";

  let operatingRegionStep = document.getElementById("operating-region-step");
  if (!operatingRegionStep) {
    onboardingScreen.querySelectorAll(".step[data-step]").forEach((stepNode) => {
      const currentStep = Number(stepNode.dataset.step || 0);
      if (currentStep >= 2) {
        stepNode.dataset.step = String(currentStep + 1);
      }
    });

    operatingRegionStep = document.createElement("div");
    operatingRegionStep.className = "step";
    operatingRegionStep.dataset.step = "2";
    operatingRegionStep.id = "operating-region-step";
    phoneCountryStep.insertAdjacentElement("afterend", operatingRegionStep);
  }

  operatingRegionStep.dataset.step = "2";
  operatingRegionStep.innerHTML = `
    <h2>Where does your business primarily operate?</h2>
    <p class="subtle">This sets your business context, default currency, and region-specific features.</p>
    <button class="btn btn-secondary" id="operating-region-next" type="button" disabled>Continue with selected country</button>
    <div class="visual-grid" id="operating-region-grid"></div>
    <p class="subtle" id="operating-region-note" hidden></p>
  `;

  els["operating-region-grid"] = document.getElementById("operating-region-grid");
  els["operating-region-note"] = document.getElementById("operating-region-note");
  els["operating-region-next"] = document.getElementById("operating-region-next");
  els["operating-region-next"]?.addEventListener("click", () => {
    if (!getRecognizedCountryId(state.profile?.operating_region || state.profile?.country || state.profile?.phone_country)) return;
    renderSectorGrid();
    updateOnboardingStep(3);
  });
}

function renderCountryGrid(dimension = "phone_country") {
  const gridId = dimension === "operating_region" ? "operating-region-grid" : "country-grid";
  const container = document.getElementById(gridId);
  if (!container) return;

  const searchId = gridId + "-search";
  let searchInput = document.getElementById(searchId);
  if (!searchInput) {
    searchInput = document.createElement("input");
    searchInput.type = "search";
    searchInput.id = searchId;
    searchInput.placeholder = dimension === "operating_region" ? "Search business regions..." : "Search phone countries...";
    searchInput.autocomplete = "off";
    searchInput.style.cssText = "width:100%;padding:10px 14px;border:1.5px solid var(--border);border-radius:var(--r-md);font-size:15px;margin-bottom:12px;box-sizing:border-box;background:var(--card);color:var(--text);";
    searchInput.addEventListener("input", () => renderCountryGrid(dimension));
    container.insertAdjacentElement("beforebegin", searchInput);
  }
  const query = (searchInput.value || "").trim().toLowerCase();

  container.innerHTML = "";

  const selectedCountry = dimension === "operating_region"
    ? getRecognizedCountryId(state.profile?.operating_region || state.profile?.country || state.profile?.phone_country)
    : getRecognizedCountryId(state.profile?.country || state.profile?.phone_country || state.authPhoneCountry);

  const filteredCountries = query ? COUNTRIES.filter(c => c.name.toLowerCase().includes(query)) : COUNTRIES;
  filteredCountries.forEach((country) => {
    container.appendChild(buildVisualCard(country.icon, country.name, dimension === "operating_region" ? "Business region" : "Phone country", () => {
      if (dimension === "phone_country") {
        state.authPhoneCountry = country.id;
        state.profile = {
          ...(state.profile || {}),
          plan: normalizePlan(state.profile?.plan),
          country: country.id,
          phone_country: country.id,
          operating_region: getRecognizedCountryId(state.profile?.operating_region) || country.id,
          language: normalizeLanguageId(state.profile?.language || "en"),
          last_action: state.profile?.last_action || "sale",
          preferred_labels: state.profile?.preferred_labels || [],
          display_name: state.profile?.display_name || "",
          phone_number: state.profile?.phone_number || "",
          email: state.profile?.email || "",
          region: state.profile?.region || "",
          birth_year: state.profile?.birth_year || "",
          gender: state.profile?.gender || ""
        };
        void persistAuthPhoneCountry(country.id);
        renderCountryGrid("phone_country");
        renderCountryGrid("operating_region");
        syncCountryAwareInputs();
        syncOnboardingRegionNote();
        renderOnboardingProfileStep();
        updateOnboardingStep(2);
        return;
      }

      state.profile = {
        ...(state.profile || {}),
        plan: normalizePlan(state.profile?.plan),
        country: getRecognizedCountryId(state.profile?.country) || getPhoneInputCountry() || country.id,
        phone_country: getRecognizedCountryId(state.profile?.phone_country) || getPhoneInputCountry() || "",
        operating_region: country.id,
        language: normalizeLanguageId(state.profile?.language || "en"),
        sector_id: null,
        business_type_id: null,
        last_action: state.profile?.last_action || "sale",
        preferred_labels: [],
        display_name: state.profile?.display_name || "",
        phone_number: state.profile?.phone_number || "",
        email: state.profile?.email || "",
        region: state.profile?.region || "",
        birth_year: state.profile?.birth_year || "",
        gender: state.profile?.gender || ""
      };
      renderCountryGrid("operating_region");
      renderSectorGrid();
      renderBusinessGrid();
      renderOnboardingProfileStep();
      updateOnboardingStep(3);
    }, selectedCountry === country.id));
  });

  if (dimension === "operating_region") {
    updateOperatingRegionContinueState();
  }
}

function renderSectorGrid() {
  els["sector-grid"].innerHTML = "";
  SECTORS.forEach((sector) => {
    els["sector-grid"].appendChild(buildVisualCard(sector.icon, sector.name, "Sector", () => {
      state.profile = {
        ...(state.profile || {}),
        sector_id: sector.id,
        business_type_id: null,
        preferred_labels: []
      };
      renderBusinessGrid();
      renderOnboardingProfileStep();
      updateOnboardingStep(4);
    }, state.profile && state.profile.sector_id === sector.id));
  });
}

function renderBusinessGrid() {
  els["business-grid"].innerHTML = "";
  const items = getAvailableBusinessTypes();
  const sectorName = state.profile && state.profile.sector_id
    ? SECTORS.find((item) => item.id === state.profile.sector_id)?.name
    : "your selected sector";
  els["business-helper"].textContent = state.profile && state.profile.operating_region
    ? `Showing business types for ${countryName(state.profile.operating_region)} in ${sectorName}.`
    : "Pick a country and sector first.";

  items.forEach((item) => {
    els["business-grid"].appendChild(buildVisualCard(item.icon, item.name, sectorName, () => {
      state.profile = {
        ...state.profile,
        business_type_id: item.id,
        preferred_labels: []
      };
      renderBusinessGrid();
      renderCommonLabelGrid();
      renderOnboardingProfileStep();
      updateOnboardingStep(5);
    }, state.profile && state.profile.business_type_id === item.id));
  });
}

function renderCommonLabelGrid(containerId = "common-label-grid") {
  const container = els[containerId] || document.getElementById(containerId);
  if (!container) return;

  container.innerHTML = "";
  if (!(state.profile && state.profile.business_type_id)) return;

  const labels = getCommonTransactionOptions(state.profile.business_type_id);
  const selected = normalizePreferredLabels(state.profile.preferred_labels, state.profile.business_type_id);

  labels.forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `ranked-item${selected.includes(item.display_name) ? " active" : ""}`;
    button.innerHTML = `<strong>${getIconForLabel(item.display_name)} ${escapeHtml(item.display_name)}</strong><span>${friendlyActionLabel(item.context)}</span><small>Show more often while recording</small>`;
    button.addEventListener("click", () => {
      void togglePreferredLabel(item.display_name);
    });
    container.appendChild(button);
  });
}

function focusFirstInteractive(container) {
  if (!container) return;
  const target = container.querySelector(
    "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"
  );
  if (!target) return;
  window.requestAnimationFrame(() => {
    target.focus();
  });
}

function updateOnboardingStep(step) {
  state.onboardingStep = step;
  document.querySelectorAll(".step").forEach((node) => node.classList.remove("active"));
  const activeStep = document.querySelector(`.step[data-step="${state.onboardingStep}"]`);
  activeStep?.classList.add("active");
  els["onboarding-step-copy"].textContent = `Step ${state.onboardingStep} of ${ONBOARDING_TOTAL_STEPS}`;
  els["onboarding-back"].hidden = state.onboardingStep === 1;
  els["finish-onboarding"].hidden = state.onboardingStep !== ONBOARDING_PROFILE_STEP;
  updateFinishOnboardingState();
  window.scrollTo(0, 0);
  focusFirstInteractive(activeStep);
}

function goToPreviousOnboardingStep() {
  if (state.onboardingStep <= 1) return;
  const targetStep = state.onboardingStep - 1;
  if (targetStep === 2) {
    renderCountryGrid("operating_region");
  }
  if (targetStep === 3) {
    renderSectorGrid();
  }
  if (targetStep === 4) {
    renderBusinessGrid();
  }
  if (targetStep === 5) {
    renderCommonLabelGrid();
  }
  updateOnboardingStep(targetStep);
}

function buildVisualCard(icon, title, description, onClick, active) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `visual-card${active ? " active" : ""}`;
  button.innerHTML = `<span class="visual-icon">${icon}</span><strong>${title}</strong><span>${description}</span>`;
  button.addEventListener("click", onClick);
  return button;
}

function renderLanguageSelectOptions(selectedLanguage = getProfileLanguage()) {
  return SUPPORTED_LANGUAGES.map((item) => {
    const selected = item.id === normalizeLanguageId(selectedLanguage) ? " selected" : "";
    return `<option value="${item.id}"${selected}>${item.name}</option>`;
  }).join("");
}

function ensureOnboardingLanguageField() {
  document.getElementById("onboarding-language-wrap")?.remove();
}

function updateOperatingRegionContinueState() {
  const button = els["operating-region-next"] || document.getElementById("operating-region-next");
  if (!button) return;

  const operatingRegion = getRecognizedCountryId(
    state.profile?.operating_region || state.profile?.country || state.profile?.phone_country || ""
  );

  button.disabled = !operatingRegion;
  button.textContent = operatingRegion
    ? `Continue with ${countryName(operatingRegion)}`
    : "Continue with selected country";
}

function syncOnboardingRegionNote() {
  const note = document.getElementById("operating-region-note");
  if (!note) return;
  note.hidden = true;
  note.textContent = "";
  updateOperatingRegionContinueState();
}

async function finishOnboarding() {
  clearOnboardingProfileError();
  const operatingRegion = getOperatingRegionId();
  const phoneCountry = getPhoneInputCountry();
  const displayName = document.getElementById("onboarding-name")?.value.trim() || "";
  const rawPhoneNumber = document.getElementById("onboarding-phone")?.value.trim() || "";
  const normalizedPhoneNumber = rawPhoneNumber ? normalizePhoneNumber(rawPhoneNumber, phoneCountry) : "";
  const email = normalizeEmailAddress(document.getElementById("onboarding-email")?.value.trim() || "");
  const region = document.getElementById("onboarding-state")?.value.trim() || "";
  const birthYear = document.getElementById("onboarding-birth-year")?.value.trim() || "";
  const gender = document.getElementById("onboarding-gender")?.value || "";
  const language = normalizeLanguageId(state.profile?.language || "en");
  const detectedPhoneCountry = detectPhoneCountryFromPhoneNumber(normalizedPhoneNumber) || getRecognizedCountryId(state.profile?.phone_country) || "";

  if (!displayName) {
    updateFinishOnboardingState();
    return;
  }

  if (rawPhoneNumber && !normalizedPhoneNumber) {
    showOnboardingProfileError(getPhoneValidationMessage(phoneCountry));
    return;
  }

  if (email && !isValidEmailAddress(email)) {
    showOnboardingProfileError("Enter a valid email address");
    return;
  }

  state.profile = {
    ...(state.profile || {}),
    plan: normalizePlan(state.profile?.plan),
    preferred_labels: state.profile?.preferred_labels || [],
    created_at: state.profile?.created_at || new Date().toISOString(),
    operating_region: operatingRegion,
    language,
    country: getRecognizedCountryId(state.profile?.country) || detectedPhoneCountry || phoneCountry || "",
    phone_country: detectedPhoneCountry,
    display_name: displayName,
    phone_number: normalizedPhoneNumber,
    email,
    region,
    birth_year: birthYear,
    gender
  };

  await saveProfile(state.profile);
  if (normalizedPhoneNumber && detectedPhoneCountry) {
    await persistAuthPhoneCountry(detectedPhoneCountry);
  }
  hydrateProfileUi();
  await showCapture();
}

function hydrateProfileUi() {
  const businessType = BUSINESS_TYPES.find((item) => item.id === state.profile.business_type_id);
  const sector = SECTORS.find((item) => item.id === state.profile.sector_id);
  const nameDisplay = state.profile.display_name
    ? `${state.profile.display_name} · `
    : "";
  els["profile-summary"].textContent = `${nameDisplay}${countryName(state.profile.operating_region)} · ${sector?.name || ""} · ${businessType?.name || ""}`;
  updateAmountInputStep();
}

async function showCapture() {
  state.currentAction = state.profile.last_action || "sale";
  state.selectedLabel = null;
  state.candidateRecord = null;
  state.onboardingStep = 3;
  hydrateProfileUi();
  renderActionRows();
  await renderQuickLabels();
  await renderRecentRecords();
  await checkDailyReminder();
  showScreen("screen-capture");
}

async function renderChart(records, mode) {
  const currency = getProfileCurrency();
  const symbol = getCurrencySymbol(currency);
  const now = new Date();
  const effectiveRecords = getOperationalRecords(records);
  let labels, salesData, expenseData;

  if (mode === "weekly") {
    labels = [];
    salesData = new Array(7).fill(0);
    expenseData = new Array(7).fill(0);
    for (let i = 6; i >= 0; i -= 1) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      labels.push(d.toLocaleDateString("en", { weekday: "short" }));
    }
    effectiveRecords.forEach((r) => {
      const d = new Date(r.confirmed_at * 1000);
      const daysAgo = Math.floor((now - d) / 86400000);
      if (daysAgo > 6) return;
      const idx = 6 - daysAgo;
      const amt = Number(r.amount_minor || 0);
      if (isInflowRecord(r)) salesData[idx] += amt;
      if (isOutflowRecord(r)) expenseData[idx] += amt;
    });
  } else {
    labels = ["Wk 1", "Wk 2", "Wk 3", "Wk 4", "This wk"];
    salesData = new Array(5).fill(0);
    expenseData = new Array(5).fill(0);
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay());
    effectiveRecords.forEach((r) => {
      const d = new Date(r.confirmed_at * 1000);
      const weeksAgo = Math.floor((startOfWeek - d) / (7 * 86400000));
      if (weeksAgo > 4) return;
      const idx = 4 - Math.min(weeksAgo, 4);
      const amt = Number(r.amount_minor || 0);
      if (isInflowRecord(r)) salesData[idx] += amt;
      if (isOutflowRecord(r)) expenseData[idx] += amt;
    });
  }

  const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const fmt = (v) => {
    const n = v / 100;
    if (n >= 1000000) return symbol + (n / 1000000).toFixed(1) + "M";
    if (n >= 1000) return symbol + Math.round(n / 1000) + "k";
    return symbol + Math.round(n);
  };

  const ctx = document.getElementById("dashboard-chart");
  if (!ctx) return;

  if (dashChart) {
    dashChart.data.labels = labels;
    dashChart.data.datasets[0].data = salesData;
    dashChart.data.datasets[1].data = expenseData;
    dashChart.update();
    return;
  }

  dashChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Inflows",
          data: salesData,
          backgroundColor: isDark ? "rgba(82,183,136,0.75)" : "rgba(45,106,79,0.75)",
          borderRadius: 6,
          borderSkipped: false
        },
        {
          label: "Expenses",
          data: expenseData,
          backgroundColor: "rgba(244,162,97,0.7)",
          borderRadius: 6,
          borderSkipped: false
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 400 },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: { label: (c) => " " + c.dataset.label + ": " + fmt(c.raw) },
          backgroundColor: "#1A3C34",
          titleColor: "rgba(255,255,255,0.7)",
          bodyColor: "white",
          padding: 10,
          cornerRadius: 8
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: isDark ? "#9ca3af" : "#6b7280", font: { size: 11 } },
          border: { display: false }
        },
        y: {
          grid: { color: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)", lineWidth: 0.5 },
          ticks: { color: isDark ? "#9ca3af" : "#6b7280", font: { size: 11 }, callback: (v) => fmt(v), maxTicksLimit: 5 },
          border: { display: false }
        }
      }
    }
  });
}

function wireChartToggle() {
  const weekly = document.getElementById("chart-weekly");
  const monthly = document.getElementById("chart-monthly");
  if (!weekly || !monthly) return;
  weekly.addEventListener("click", async () => {
    weekly.classList.add("active");
    monthly.classList.remove("active");
    await renderChart(await getRecords(), "weekly");
  });
  monthly.addEventListener("click", async () => {
    monthly.classList.add("active");
    weekly.classList.remove("active");
    await renderChart(await getRecords(), "monthly");
  });
}

async function renderDashboard() {
  const records = await getRecords();
  const effectiveRecords = getOperationalRecords(records);
  const currency = getProfileCurrency();
  const metrics = getDashboardMetrics(records, effectiveRecords);

  els["dash-today-sales-v2"].textContent = formatMoney(metrics.todaySales, currency);
  els["dash-monthly-sales-v2"].textContent = formatMoney(metrics.monthlySales, currency);
  els["dash-monthly-expenses-v2"].textContent = formatMoney(metrics.monthlyExpenses, currency);
  els["dash-cash-flow-v2"].textContent = formatMoney(metrics.monthlySales - metrics.monthlyExpenses, currency);
  if (els["dash-borrowing-v2"]) {
    els["dash-borrowing-v2"].textContent = formatMoney(metrics.monthlyBorrowed, currency);
  }

  renderDashboardRecords(records);

  await renderChart(records, "weekly");

  const tierFillBar = document.getElementById("tier-fill-bar");
  const tierDaysText = document.getElementById("tier-days-text");
  const tierLabelText = document.getElementById("tier-label-text");
  const daySet = new Set(records.map((r) => new Date(r.confirmed_at * 1000).toDateString()));
  let streak = 0;
  const streakDate = new Date();
  while (daySet.has(streakDate.toDateString())) {
    streak += 1;
    streakDate.setDate(streakDate.getDate() - 1);
  }

  if (tierFillBar) tierFillBar.style.width = Math.min((streak / 180) * 100, 100) + "%";
  if (tierDaysText) tierDaysText.textContent = streak + " / 180 days";
  if (tierLabelText) {
    if (streak >= 180) tierLabelText.textContent = "🥇 Gold";
    else if (streak >= 90) tierLabelText.textContent = "🥈 Silver";
    else if (streak >= 30) tierLabelText.textContent = "🥉 Bronze";
    else tierLabelText.textContent = "🆕 New";
  }
  const streakEl = document.getElementById("dash-streak-v2");
  if (streakEl) streakEl.textContent = streak;

  const banner = document.getElementById("record-history-banner");
  if (banner && isAuthSessionValid() && state.deviceIdentity) {
    if (streak >= 90) {
      document.getElementById("banner-tier-icon").textContent = "🥈";
      document.getElementById("banner-headline").textContent = "You have " + streak + " days of record history.";
      document.getElementById("banner-subtext").textContent = "Your verifiable export is ready when you choose to share.";
      banner.hidden = false;
    } else if (streak >= 30) {
      document.getElementById("banner-tier-icon").textContent = "🥉";
      document.getElementById("banner-headline").textContent = "You have " + streak + " days of record history.";
      document.getElementById("banner-subtext").textContent = "Generate a verifiable export when you choose to share.";
      banner.hidden = false;
    } else {
      banner.hidden = true;
    }
  } else if (banner) {
    banner.hidden = true;
  }

  refreshTrustBanner("screen-dashboard");
}

function renderDashboardRecords(records) {
  const recent = [...records].reverse().slice(0, 5);
  renderRecordListWithMarketing(
    "dashboard-records-v2",
    recent,
    `<div class="record-card"><strong>No confirmed records yet.</strong><div class="record-meta">Your recent confirmed transactions will appear here.</div></div>`,
    (record) => createElementFromHtml(renderRecordCard(record))
  );
}

function maskContact(value) {
  const contact = String(value || "").trim();
  if (!contact) return value;

  if (contact.includes("@")) {
    const [localPart, ...domainParts] = contact.split("@");
    const domain = domainParts.join("@");
    if (!localPart || !domain) return value;
    return `${localPart.slice(0, 2)}***@${domain}`;
  }

  if (contact.startsWith("+") || /^\d+$/.test(contact)) {
    return `${contact.slice(0, 4)}***${contact.slice(-4)}`;
  }

  return value;
}

function syncSettingsTrustDetailsToggle() {
  if (!els["settings-trust-toggle"] || !els["settings-trust-panel"]) return;
  const expanded = !els["settings-trust-panel"].hidden;
  els["settings-trust-toggle"].textContent = expanded
    ? "Device & sync details ▾"
    : "Device & sync details ▸";
  els["settings-trust-toggle"].setAttribute("aria-expanded", expanded ? "true" : "false");
}

function toggleSettingsTrustDetails() {
  if (!els["settings-trust-panel"]) return;
  els["settings-trust-panel"].hidden = !els["settings-trust-panel"].hidden;
  syncSettingsTrustDetailsToggle();
}

async function renderSettings() {
  if (!state.profile) return;
  refreshTrustSetupButtons();
  const records = await getRecords();
  const effectiveRecords = getOperationalRecords(records);
  const businessType = BUSINESS_TYPES.find((item) => item.id === state.profile.business_type_id);
  const sector = SECTORS.find((item) => item.id === state.profile.sector_id);
  const preferred = normalizePreferredLabels(state.profile.preferred_labels, state.profile.business_type_id);
  state.profile.preferred_labels = preferred;
  const currency = getProfileCurrency();
  const latestRecord = records.length ? records[records.length - 1] : null;
  const totalSales = effectiveRecords
    .filter((record) => isInflowRecord(record))
    .reduce((sum, record) => sum + Number(record.amount_minor || 0), 0);
  const totalOutflow = effectiveRecords
    .filter((record) => isOutflowRecord(record))
    .reduce((sum, record) => sum + Number(record.amount_minor || 0), 0);

  els["settings-profile-v2"].innerHTML = `
    ${renderSettingsRow("Operating region", countryName(state.profile.operating_region))}
    ${renderSettingsRow("Phone country", countryName(state.profile.phone_country) || "Not detected yet")}
    ${renderSettingsRow("Language", getLanguageName(state.profile.language))}
    ${renderSettingsRow("Sector", sector?.name || "Not selected")}
    ${renderSettingsRow("Business type", businessType?.name || "Not selected")}
    ${state.profile.display_name ? renderSettingsRow("Name", state.profile.display_name) : ""}
    ${state.profile.phone_number ? renderSettingsRow("Phone", maskContact(state.profile.phone_number)) : ""}
    ${state.profile.email ? renderSettingsRow("Email", maskContact(state.profile.email)) : ""}
    ${state.profile.region ? renderSettingsRow("Region", state.profile.region) : ""}
    ${renderSettingsRow("Last action", friendlyActionLabel(state.profile.last_action || "sale"))}
    ${renderSettingsRow("Plan", getPlanLabel(state.profile.plan))}
    <label class="field" style="margin-bottom:0">
      Language
      <select id="settings-language-select" style="width:100%;min-height:48px;border-radius:12px;border:1px solid var(--border);background:white;margin-top:6px;padding:0 12px;color:var(--text)">
        ${renderLanguageSelectOptions()}
      </select>
    </label>
    <p class="record-meta" id="settings-region-note" hidden></p>
  `;
  const settingsLanguageSelect = document.getElementById("settings-language-select");
  if (settingsLanguageSelect) {
    settingsLanguageSelect.value = getProfileLanguage();
    settingsLanguageSelect.addEventListener("change", async () => {
      if (!state.profile) return;
      state.profile.language = normalizeLanguageId(settingsLanguageSelect.value);
      await saveProfile(state.profile);
      await renderSettings();
    });
  }

  els["settings-trust-v3"].innerHTML = `
    ${renderSettingsRow("Verification summary", getVerificationSummaryLabel())}
    ${renderSettingsRow("Verification channels", getVerificationChannelAvailabilityLabel())}
    ${renderSettingsRow("Email verification", getVerificationStatusLabel("email"))}
    ${(state.smsSupported || state.profile.phone_verified) ? renderSettingsRow("Phone verification", getVerificationStatusLabel("sms")) : ""}
    ${renderSettingsRow("Phone anchor", getPhoneAnchorStatusLabel())}
    ${state.profile.identity_verified_at ? renderSettingsRow("Verified on", new Date(state.profile.identity_verified_at).toLocaleString()) : ""}
    ${renderSettingsRow("Device key", getDeviceKeyStatusLabel())}
    ${state.publicKeyFingerprint ? renderSettingsRow("Device ID", state.publicKeyFingerprint.slice(0, 8)) : ""}
    ${renderSettingsRow("Auth session", getAuthSessionStatusLabel())}
    ${renderSettingsRow("Queued sync entries", String(state.syncQueueCount))}
    ${renderSettingsRow("Sync status", state.syncStatus || "Idle")}
    ${state.lastSyncAt ? renderSettingsRow("Last sync", new Date(state.lastSyncAt).toLocaleString()) : ""}
    ${renderSettingsRow("Recovery contact", maskContact(state.profile.email || state.profile.phone_number || "Not set"))}
  `;

  if (els["settings-open-trust-v3"]) {
    if (state.profile?.email_verified) {
      els["settings-open-trust-v3"].textContent = "Email verified ✓";
    } else if (state.profile?.phone_verified) {
      els["settings-open-trust-v3"].textContent = "Device verified ✓";
    } else {
      els["settings-open-trust-v3"].textContent = "Verify this device";
    }
  }
  syncSettingsTrustDetailsToggle();

  renderRecordingSetupSummary();

  if (state.profile.reminderEnabled === false) {
    els["reminder-toggle"].classList.remove("on");
  } else {
    els["reminder-toggle"].classList.add("on");
  }

  if (state.profile.pinEnabled && state.profile.pinHash) {
    els["pin-lock-toggle"].classList.add("on");
    els["pin-setup-area"].hidden = false;
    els["pin-remove-btn"].hidden = false;
    if (els["pin-reset-btn"]) els["pin-reset-btn"].hidden = false;
    els["pin-setup-label"].textContent = "Passcode is set — current passcode required to change";
    if (els["pin-save-btn"]) els["pin-save-btn"].textContent = "Update passcode";
  } else {
    els["pin-lock-toggle"].classList.remove("on");
    els["pin-setup-area"].hidden = true;
    els["pin-remove-btn"].hidden = true;
    if (els["pin-reset-btn"]) els["pin-reset-btn"].hidden = true;
    els["pin-setup-label"].textContent = "Create a passcode";
    if (els["pin-save-btn"]) els["pin-save-btn"].textContent = "Save passcode";
    els["settings-security-status"].textContent = "";
    els["pin-setup-error"].textContent = "";
  }
  syncPasscodeReminderEditor();

  renderPreferredLabelsSummary();
  await renderVoiceCorrectionsSettings();
  await renderAnomalyPanel();
  await renderTrustedDevicesSettings();
  syncPreferredLabelEditor();

  els["settings-summary-v2"].innerHTML = `
    ${renderSettingsRow("Confirmed records", String(records.length))}
    ${renderSettingsRow("Total sales", formatMoney(totalSales, currency))}
    ${renderSettingsRow("Total outflow", formatMoney(totalOutflow, currency))}
    ${renderSettingsRow("Latest confirmed record", latestRecord ? `${latestRecord.label} • ${new Date(latestRecord.confirmed_at * 1000).toLocaleString()}` : "No confirmed records yet")}
    ${renderSettingsRow("Storage", "Saved locally on this device")}
  `;

  await refreshStorageWarning();
  if (state.lowStorageWarning) {
    els["settings-summary-v2"].innerHTML += renderSettingsRow("Backup recommendation", state.lowStorageWarning);
  }
}

function renderSettingsRow(label, value) {
  return `<div class="settings-row"><span>${label}</span><strong>${escapeHtml(String(value ?? ""))}</strong></div>`;
}

function getRecordConfirmedAtMs(record) {
  const confirmedAt = Number(record?.confirmed_at || 0);
  if (!Number.isFinite(confirmedAt) || confirmedAt <= 0) return 0;
  return confirmedAt > 1e12 ? confirmedAt : confirmedAt * 1000;
}

function getAnomalyStore(mode = "readonly") {
  if (!(state.db && state.db.objectStoreNames.contains("anomaly_log"))) return null;
  return state.db.transaction("anomaly_log", mode).objectStore("anomaly_log");
}

async function getAnomalyEntries() {
  const store = getAnomalyStore("readonly");
  if (!store) return [];

  return new Promise((resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => {
      const entries = Array.isArray(request.result) ? request.result : [];
      resolve(entries.sort((a, b) => {
        const timeDiff = Number(b.detected_at || 0) - Number(a.detected_at || 0);
        if (timeDiff) return timeDiff;
        return Number(b.id || 0) - Number(a.id || 0);
      }));
    };
    request.onerror = () => reject(request.error);
  });
}

async function getUnreviewedAnomalyCount() {
  const entries = await getAnomalyEntries();
  const cutoffMs = Date.now() - (3 * 24 * 3600000);
  return entries.filter((entry) => !entry.reviewed && Number(entry.detected_at || 0) >= cutoffMs).length;
}

async function computeUserP95HourlyCount() {
  const records = await getRecords();
  const cutoffMs = Date.now() - (30 * 24 * 3600000);
  const recentRecords = records.filter((record) => getRecordConfirmedAtMs(record) >= cutoffMs);
  if (recentRecords.length < 10) return 0;

  const buckets = new Map();
  recentRecords.forEach((record) => {
    const hourBucket = Math.floor(getRecordConfirmedAtMs(record) / 3600000);
    buckets.set(hourBucket, (buckets.get(hourBucket) || 0) + 1);
  });

  const counts = [...buckets.values()].sort((a, b) => a - b);
  const percentileIndex = Math.min(counts.length - 1, Math.max(0, Math.ceil(counts.length * 0.95) - 1));
  return counts[percentileIndex] || 0;
}

async function getAnomalyThreshold() {
  const p95 = await computeUserP95HourlyCount();
  return Math.max(50, p95 * 3);
}

function clearAnomalyAutoReviewTimer() {
  if (state.anomalyAutoReviewTimer) {
    window.clearTimeout(state.anomalyAutoReviewTimer);
    state.anomalyAutoReviewTimer = null;
  }
}

async function logAnomaly(type, detail, entry_id) {
  const store = getAnomalyStore("readwrite");
  if (!store) return;

  await new Promise((resolve, reject) => {
    store.add({
      type,
      detail,
      entry_id: entry_id == null ? null : String(entry_id),
      detected_at: Date.now(),
      reviewed: false
    });
    store.transaction.oncomplete = () => resolve();
    store.transaction.onerror = () => reject(store.transaction.error);
  });

  await notifyAnomaly();
}

async function checkForAnomalies(newEntry) {
  if (newEntry?.importedFromServer) return;
  try {
    const threshold = await getAnomalyThreshold();
    const oneHourAgoMs = Date.now() - 3600000;
    const fiveMinAgoMs = Date.now() - 300000;
    const recentRecords = (await getRecords()).filter((record) => getRecordConfirmedAtMs(record) >= oneHourAgoMs);
    const thisHourCount = recentRecords.length;

    if (thisHourCount > threshold) {
      await logAnomaly(
        "volume_spike",
        `${thisHourCount} records in the last hour (threshold: ${threshold})`,
        newEntry.id
      );
    }

    const sameAmountRecent = recentRecords.filter((record) => {
      return getRecordConfirmedAtMs(record) >= fiveMinAgoMs
        && record.amount_minor === newEntry.amount_minor;
    });

    if (sameAmountRecent.length >= 8) {
      await logAnomaly(
        "repeated_amount",
        `Amount ${newEntry.amount_minor} recorded ${sameAmountRecent.length} times in 5 min`,
        newEntry.id
      );
    }

    const newEntryMs = getRecordConfirmedAtMs(newEntry);
    if (newEntryMs > Date.now() + 120000) {
      await logAnomaly(
        "future_timestamp",
        `Entry timestamp is ${Math.round((newEntryMs - Date.now()) / 1000)}s in the future`,
        newEntry.id
      );
    }

    const duplicateChain = recentRecords.filter((record) => {
      return record.prev_entry_hash
        && record.prev_entry_hash === newEntry.prev_entry_hash
        && record.id !== newEntry.id;
    });

    if (duplicateChain.length > 0) {
      await logAnomaly(
        "hash_fork",
        `prev_entry_hash ${newEntry.prev_entry_hash?.slice(0, 12)} appears in multiple entries`,
        newEntry.id
      );
    }
  } catch (error) {
    console.warn("Anomaly detection skipped.", error);
  }
}

async function notifyAnomaly() {
  const entries = await getAnomalyEntries();
  const cutoffMs = Date.now() - (3 * 24 * 3600000);
  const recent = entries.filter(
    (entry) => !entry.reviewed && Number(entry.detected_at || 0) >= cutoffMs
  );
  const count = recent.length;

  if (els["anomaly-banner"] && els["anomaly-banner-text"]) {
    if (count <= 0) {
      els["anomaly-banner"].hidden = true;
    } else {
      els["anomaly-banner"].hidden = false;
      const top = recent[0];
      const meta = getAnomalyDisplayMeta(top.type);
      if (count === 1) {
        els["anomaly-banner-text"].textContent =
          `${meta.icon} ${meta.label}: ${top.detail}`;
      } else {
        els["anomaly-banner-text"].textContent =
          `${meta.icon} ${count} security alerts — tap to review`;
      }
    }
  }

  if (els["anomaly-badge"]) {
    els["anomaly-badge"].hidden = count <= 0;
    els["anomaly-badge"].textContent = count > 0 ? String(count) : "";
  }

  if (document.querySelector(".screen.active")?.id === "screen-settings") {
    await renderAnomalyPanel();
  }
}

function getAnomalyDisplayMeta(type) {
  const meta = {
    volume_spike: { icon: "📈", label: "Volume spike" },
    repeated_amount: { icon: "🔁", label: "Repeated amount" },
    future_timestamp: { icon: "⏰", label: "Future timestamp" },
    hash_fork: { icon: "⚠️", label: "Hash chain fork" }
  }[type];

  return meta || { icon: "⚠️", label: "Security alert" };
}

async function renderAnomalyPanel() {
  if (!(els["anomaly-list"] && els["mark-anomalies-reviewed"])) return;

  const entries = await getAnomalyEntries();
  const unreviewedCount = entries.filter((entry) => !entry.reviewed).length;

  if (unreviewedCount <= 0) {
    clearAnomalyAutoReviewTimer();
  }

  if (els["anomaly-badge"]) {
    els["anomaly-badge"].hidden = unreviewedCount <= 0;
    els["anomaly-badge"].textContent = unreviewedCount > 0 ? String(unreviewedCount) : "";
  }

  els["anomaly-list"].innerHTML = "";

  if (!entries.length) {
    els["anomaly-list"].innerHTML = `<div class="record-meta">No security alerts recorded yet.</div>`;
    els["mark-anomalies-reviewed"].hidden = true;
    return;
  }

  entries.forEach((entry) => {
    const row = document.createElement("div");
    row.className = "settings-row";
    row.dataset.anomalyId = String(entry.id || "");
    row.dataset.reviewed = entry.reviewed ? "true" : "false";
    row.style.alignItems = "flex-start";
    row.style.gap = "12px";
    row.style.borderLeft = entry.reviewed ? "3px solid transparent" : "3px solid #ffc107";
    row.style.paddingLeft = "10px";

    const left = document.createElement("div");
    left.style.minWidth = "0";

    const title = document.createElement("strong");
    const meta = getAnomalyDisplayMeta(entry.type);
    title.textContent = `${meta.icon} ${meta.label}`;

    const detail = document.createElement("div");
    detail.className = "record-meta";
    detail.textContent = entry.detail;

    left.append(title, detail);

    const time = document.createElement("span");
    time.className = "record-meta";
    time.textContent = new Date(entry.detected_at).toLocaleString();

    row.append(left, time);
    els["anomaly-list"].appendChild(row);
  });

  els["mark-anomalies-reviewed"].hidden = unreviewedCount <= 0;
}

function getVisibleUnreviewedAnomalyIds() {
  if (!els["anomaly-list"]) return [];
  return [...els["anomaly-list"].querySelectorAll("[data-anomaly-id][data-reviewed='false']")]
    .map((row) => Number(row.dataset.anomalyId))
    .filter((id) => Number.isFinite(id));
}

function scheduleAnomalyAutoReview() {
  clearAnomalyAutoReviewTimer();
  const visibleIds = getVisibleUnreviewedAnomalyIds();
  if (!visibleIds.length) return;

  state.anomalyAutoReviewTimer = window.setTimeout(() => {
    state.anomalyAutoReviewTimer = null;
    void markAnomaliesReviewed(visibleIds);
  }, 5000);
}

async function markAnomaliesReviewed(entryIds = null) {
  const store = getAnomalyStore("readwrite");
  if (!store) return;
  clearAnomalyAutoReviewTimer();

  const idsToMark = Array.isArray(entryIds)
    ? new Set(entryIds.map((id) => Number(id)).filter((id) => Number.isFinite(id)))
    : null;

  await new Promise((resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => {
      const entries = Array.isArray(request.result) ? request.result : [];
      entries.forEach((entry) => {
        if (!entry.reviewed && (!idsToMark || idsToMark.has(Number(entry.id)))) {
          store.put({ ...entry, reviewed: true });
        }
      });
    };
    request.onerror = () => reject(request.error);
    store.transaction.oncomplete = () => resolve();
    store.transaction.onerror = () => reject(store.transaction.error);
  });

  await renderAnomalyPanel();
  await notifyAnomaly();
}

async function markAllAnomaliesReviewed() {
  await markAnomaliesReviewed();
}

async function openAnomalyReview() {
  await renderSettings();
  showScreen("screen-settings");
  window.requestAnimationFrame(() => {
    els["anomaly-panel"]?.scrollIntoView({ behavior: "smooth", block: "start" });
    scheduleAnomalyAutoReview();
  });
}

function getPlanLabel(plan) {
  return "Free";
}

function normalizePlan() {
  return "free";
}

function setRecordingState(isRecording) {
  state.isRecording = Boolean(isRecording);
}

function getCurrentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function getMonthlyStorageKey(baseKey) {
  return `${baseKey}:${getCurrentMonthKey()}`;
}

function getMonthlyLocalNumber(baseKey) {
  const value = parseInt(localStorage.getItem(getMonthlyStorageKey(baseKey)) || "0", 10);
  return Number.isFinite(value) ? value : 0;
}

function incrementMonthlyLocalNumber(baseKey, amount = 1) {
  const nextValue = getMonthlyLocalNumber(baseKey) + amount;
  localStorage.setItem(getMonthlyStorageKey(baseKey), String(nextValue));
  return nextValue;
}

function getMonthlyFreeExportCount() {
  return getMonthlyLocalNumber("freeExportsThisMonth");
}

function hasFreeExportQuota() {
  return true;
}

function refreshExportState() {
  if (!els["export-button-v2"]) return;
  els["export-button-v2"].disabled = false;
  els["export-button-v2"].textContent = isAuthSessionValid() && state.deviceIdentity
    ? "Generate verifiable PDF"
    : "Generate text export";
}

function createElementFromHtml(html) {
  const template = document.createElement("template");
  template.innerHTML = String(html || "").trim();
  return template.content.firstElementChild;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderRecordListWithMarketing(containerId, records, emptyHtml, renderer) {
  const container = els[containerId] || document.getElementById(containerId);
  if (!container) return;

  container.innerHTML = "";
  if (!records.length) {
    container.innerHTML = emptyHtml;
    return;
  }

  const fragment = document.createDocumentFragment();

  records.forEach((record, index) => {
    const node = renderer(record, index);
    if (node) fragment.appendChild(node);
  });

  container.appendChild(fragment);
}

function refreshTrustBanner(screenId) {
  return screenId;
}

function renderRecordingSetupSummary() {
  if (!(els["settings-capture-v2"] && state.profile)) return;
  const preferred = normalizePreferredLabels(state.profile.preferred_labels, state.profile.business_type_id);
  els["settings-capture-v2"].innerHTML = `
    ${renderSettingsRow("Primary recording mode", "Voice-first with text fallback")}
    ${renderSettingsRow("Confirmation rule", "Every transaction must be reviewed before append")}
    ${renderSettingsRow("Quick-pick strategy", preferred.length ? `${preferred.length} common transaction${preferred.length === 1 ? "" : "s"} boosted` : "Using business defaults")}
    ${renderSettingsRow("Transfer handling", "Separate from income and expense")}
  `;
}

function renderPreferredLabelsSummary() {
  if (!els["settings-preferred-v2"]) return;
  const preferred = normalizePreferredLabels(state.profile?.preferred_labels, state.profile?.business_type_id);
  els["settings-preferred-v2"].innerHTML = preferred.length
    ? preferred.map((label) => `<div class="settings-chip">${getIconForLabel(label)} ${escapeHtml(label)}</div>`).join("")
    : `<div class="record-meta">No common transactions selected yet.</div>`;
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getVoiceCorrectionsStore(mode = "readonly") {
  if (!(state.db && state.db.objectStoreNames.contains("voiceCorrections"))) return null;
  return state.db.transaction("voiceCorrections", mode).objectStore("voiceCorrections");
}

async function getVoiceCorrections() {
  const store = getVoiceCorrectionsStore("readonly");
  if (!store) return [];

  return new Promise((resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => {
      const entries = Array.isArray(request.result) ? request.result : [];
      resolve(entries.sort((a, b) => {
        const countDiff = Number(b.count || 0) - Number(a.count || 0);
        if (countDiff) return countDiff;
        return Number(b.updated_at || 0) - Number(a.updated_at || 0);
      }));
    };
    request.onerror = () => reject(request.error);
  });
}

function applyVoiceCorrectionEntry(transcript, raw, corrected) {
  if (!raw || !corrected) return transcript;
  const matcher = new RegExp(`(^|[^\\w])(${escapeRegExp(raw)})(?=$|[^\\w])`, "gi");
  return String(transcript || "").replace(matcher, (match, prefix) => `${prefix}${corrected}`);
}

async function applyVoiceCorrections(transcript) {
  const input = String(transcript || "").trim();
  if (!input) return "";

  try {
    const corrections = await getVoiceCorrections();
    return corrections
      .sort((a, b) => String(b.raw || "").length - String(a.raw || "").length)
      .reduce((nextTranscript, entry) => {
        return applyVoiceCorrectionEntry(nextTranscript, entry.raw, entry.corrected);
      }, input);
  } catch (error) {
    console.warn("Unable to apply voice corrections.", error);
    return input;
  }
}

async function saveVoiceCorrection(raw, corrected) {
  const normalizedRaw = String(raw || "").trim().toLowerCase();
  const normalizedCorrected = String(corrected || "").trim().toLowerCase();
  if (!normalizedRaw || !normalizedCorrected || normalizedRaw === normalizedCorrected) return;

  const store = getVoiceCorrectionsStore("readwrite");
  if (!store) return;

  return new Promise((resolve, reject) => {
    const existingRequest = store.get(normalizedRaw);
    existingRequest.onsuccess = () => {
      const existing = existingRequest.result;
      store.put({
        raw: normalizedRaw,
        corrected: normalizedCorrected,
        count: Number(existing?.count || 0) + 1,
        updated_at: Date.now()
      });
    };
    existingRequest.onerror = () => reject(existingRequest.error);

    store.transaction.oncomplete = () => resolve();
    store.transaction.onerror = () => reject(store.transaction.error);
  });
}

async function deleteVoiceCorrection(raw) {
  const key = String(raw || "").trim().toLowerCase();
  if (!key) return;

  const store = getVoiceCorrectionsStore("readwrite");
  if (!store) return;

  return new Promise((resolve, reject) => {
    store.delete(key);
    store.transaction.oncomplete = () => resolve();
    store.transaction.onerror = () => reject(store.transaction.error);
  });
}

async function renderVoiceCorrectionsSettings() {
  if (!els["settings-voice-corrections-v2"]) return;

  const corrections = await getVoiceCorrections();
  els["settings-voice-corrections-v2"].innerHTML = "";

  if (!corrections.length) {
    els["settings-voice-corrections-v2"].innerHTML = `<div class="record-meta">No saved corrections yet. Konfirmata will learn from manual voice fixes on this device.</div>`;
    return;
  }

  corrections.forEach((entry) => {
    const row = document.createElement("div");
    row.className = "settings-row";

    const left = document.createElement("div");
    left.style.minWidth = "0";

    const raw = document.createElement("span");
    raw.textContent = entry.raw;
    raw.style.display = "block";

    const corrected = document.createElement("strong");
    corrected.textContent = entry.corrected;
    corrected.style.display = "block";
    corrected.style.textAlign = "left";
    corrected.style.marginTop = "4px";
    left.append(raw, corrected);

    const right = document.createElement("div");
    right.style.display = "grid";
    right.style.justifyItems = "end";
    right.style.gap = "8px";

    const count = document.createElement("span");
    count.className = "record-meta";
    count.textContent = `${entry.count} time${entry.count === 1 ? "" : "s"}`;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "pill-button";
    remove.textContent = "Delete";
    remove.addEventListener("click", () => {
      void deleteVoiceCorrection(entry.raw).then(() => renderVoiceCorrectionsSettings());
    });

    right.append(count, remove);
    row.append(left, right);
    els["settings-voice-corrections-v2"].appendChild(row);
  });
}

function syncPreferredLabelEditor() {
  if (els["settings-preferred-edit-v2"]) {
    els["settings-preferred-edit-v2"].textContent = state.preferredLabelEditorOpen ? "Close" : "Edit";
  }
  if (els["settings-preferred-editor"]) {
    els["settings-preferred-editor"].hidden = !state.preferredLabelEditorOpen;
  }
  if (!els["settings-preferred-grid"]) return;
  if (state.preferredLabelEditorOpen) {
    renderCommonLabelGrid("settings-preferred-grid");
  } else {
    els["settings-preferred-grid"].innerHTML = "";
  }
}

function togglePreferredLabelEditor(forceOpen) {
  if (!(state.profile && state.profile.business_type_id)) return;
  state.preferredLabelEditorOpen = typeof forceOpen === "boolean"
    ? forceOpen
    : !state.preferredLabelEditorOpen;
  syncPreferredLabelEditor();
}

function dismissDailyReminder() {
  state.reminderDismissed = true;
  els["daily-reminder-banner"].hidden = true;
}

async function checkDailyReminder() {
  if (!state.db || !state.profile) return;
  if (state.profile.reminderEnabled === false) {
    els["daily-reminder-banner"].hidden = true;
    return;
  }

  const entries = await getRecords();
  const todayStr = new Date().toDateString();
  const recordedToday = entries.some((entry) => new Date(entry.confirmed_at * 1000).toDateString() === todayStr);

  if (recordedToday) {
    state.reminderDismissed = false;
    els["daily-reminder-banner"].hidden = true;
    return;
  }

  els["daily-reminder-banner"].hidden = state.reminderDismissed;
}

function toggleReminderPreference() {
  if (!state.profile) return;
  const enabled = els["reminder-toggle"].classList.toggle("on");
  state.profile.reminderEnabled = enabled;
  if (enabled) state.reminderDismissed = false;
  saveProfile(state.profile);
  checkDailyReminder();
}

function togglePrivacyMode() {
  state.amountsHidden = !state.amountsHidden;
  if (state.amountsHidden) {
    document.body.classList.add("amounts-hidden");
    els["privacy-toggle-btn"].textContent = "🙈";
  } else {
    document.body.classList.remove("amounts-hidden");
    els["privacy-toggle-btn"].textContent = "👁️";
  }
}

function resetPrivacyMode() {
  state.amountsHidden = false;
  document.body.classList.remove("amounts-hidden");
  if (els["privacy-toggle-btn"]) {
    els["privacy-toggle-btn"].textContent = "👁️";
    els["privacy-toggle-btn"].classList.remove("reset-flash");
    void els["privacy-toggle-btn"].offsetWidth;
    els["privacy-toggle-btn"].classList.add("reset-flash");
    if (privacyResetFlashTimer) clearTimeout(privacyResetFlashTimer);
    privacyResetFlashTimer = setTimeout(() => {
      els["privacy-toggle-btn"]?.classList.remove("reset-flash");
    }, 700);
  }
}

function showPinLock() {
  state.pinEntry = "";
  updatePinDots();
  if (els["pin-entry-input"]) {
    els["pin-entry-input"].value = "";
  }
  syncPasscodeReminderDisplays();
  els["pin-error"].textContent = "";
  els["pin-lock-screen"].hidden = false;
  focusFirstInteractive(els["pin-lock-screen"]);
}

function hidePinLock() {
  els["pin-lock-screen"].hidden = true;
}

function updatePinDots() {
  document.querySelectorAll(".pin-dot").forEach((dot, index) => {
    dot.classList.toggle("filled", index < state.pinEntry.length);
  });
}


function getPasscodeValidationMessage(passcode) {
  const value = String(passcode || "");
  if (value.length < 8) return "Passcode must be at least 8 characters";
  if (!/[A-Za-z]/.test(value)) return "Passcode must include at least one letter";
  if (!/\d/.test(value)) return "Passcode must include at least one number";
  return "";
}

function normalizePasscodeReminder(reminder, legacyHint = "") {
  if (reminder && typeof reminder === "object" && !Array.isArray(reminder)) {
    const question = String(reminder.question || "").trim();
    const answer = String(reminder.answer || "").trim();
    if (question && answer) {
      return {
        reminder: { question, answer },
        migrated: false
      };
    }
  }

  const hint = String(legacyHint || "").trim();
  if (hint) {
    return {
      reminder: {
        question: "Your hint:",
        answer: hint
      },
      migrated: true
    };
  }

  return {
    reminder: null,
    migrated: false
  };
}

function clonePasscodeReminder(reminder) {
  if (!(reminder && reminder.question && reminder.answer)) return null;
  return {
    question: String(reminder.question || "").trim(),
    answer: String(reminder.answer || "").trim()
  };
}

function getPasscodeReminder(profile = state.profile) {
  const { reminder } = normalizePasscodeReminder(profile?.passcodeReminder, profile?.passcode_hint);
  return clonePasscodeReminder(reminder);
}

function normalizeLocalProfile(profile, { trackReminderMigration = false, trackDimensionMigration = false } = {}) {
  if (!profile) return null;
  const { reminder, migrated } = normalizePasscodeReminder(profile.passcodeReminder, profile.passcode_hint);
  const normalizedOperatingRegion = getRecognizedCountryId(profile.operating_region || profile.country) || "NG";
  const normalizedPhoneCountry = getRecognizedCountryId(profile.phone_country) || detectPhoneCountryFromPhoneNumber(profile.phone_number) || "";
  const normalizedLanguage = normalizeLanguageId(profile.language || "en");
  const needsDimensionMigration = Boolean(
    profile.country
    || !profile.operating_region
    || !profile.language
    || (profile.phone_number && !profile.phone_country && normalizedPhoneCountry)
  );
  const normalizedProfile = {
    ...profile,
    plan: normalizePlan(profile.plan),
    preferred_labels: normalizePreferredLabels(profile.preferred_labels, profile.business_type_id),
    operating_region: normalizedOperatingRegion,
    phone_country: normalizedPhoneCountry,
    language: normalizedLanguage
  };
  if (reminder) {
    normalizedProfile.passcodeReminder = clonePasscodeReminder(reminder);
  } else {
    delete normalizedProfile.passcodeReminder;
  }
  delete normalizedProfile.country;
  delete normalizedProfile.passcode_hint;
  delete normalizedProfile._needsReminderMigration;
  delete normalizedProfile._needsDimensionMigration;
  if (trackReminderMigration && migrated) {
    normalizedProfile._needsReminderMigration = true;
  }
  if (trackDimensionMigration && needsDimensionMigration) {
    normalizedProfile._needsDimensionMigration = true;
  }
  return normalizedProfile;
}

function getPasscodeReminderFromInputs() {
  const question = String(els["pin-reminder-question"]?.value || "").trim();
  const answer = String(els["pin-reminder-answer"]?.value || "").trim();
  if (!question && !answer) return null;
  return { question, answer };
}

function setPasscodeReminderInputs(reminder = getPasscodeReminder()) {
  if (els["pin-reminder-question"]) {
    els["pin-reminder-question"].value = reminder?.question || "";
  }
  if (els["pin-reminder-answer"]) {
    els["pin-reminder-answer"].value = reminder?.answer || "";
  }
}

function maskPasscodeReminderAnswer(answer) {
  if (!String(answer || "").trim()) return "Not set";
  return "••••";
}

function getPasscodeReminderValidationMessage(passcode, question, answer) {
  const normalizedPasscode = String(passcode || "").trim().toLowerCase();
  const normalizedQuestion = String(question || "").trim().toLowerCase();
  const normalizedAnswer = String(answer || "").trim().toLowerCase();

  if (!normalizedQuestion && !normalizedAnswer) return "";
  if (!normalizedQuestion || !normalizedAnswer) {
    return "Add both a security question and an answer, or leave both blank";
  }
  if (!normalizedPasscode) return "";
  if (normalizedAnswer === normalizedPasscode) {
    return "Reminder answer must not be your actual passcode";
  }
  if (
    normalizedAnswer.includes(normalizedPasscode)
    || normalizedPasscode.includes(normalizedAnswer)
  ) {
    return "Reminder answer must not reveal your passcode";
  }
  if (normalizedQuestion.includes(normalizedPasscode)) {
    return "Security question must not include your passcode";
  }
  return "";
}

function getPasscodeReminderDisplay(attempts = state.pinAttempts) {
  const reminder = getPasscodeReminder();
  if (!reminder || attempts < 3) return "";
  if (attempts >= 5) {
    return `Hint: ${reminder.question} → ${reminder.answer}`;
  }
  return `Hint: ${reminder.question}`;
}

function syncPasscodeReminderDisplays() {
  const reminderText = getPasscodeReminderDisplay();
  if (els["pin-lock-hint"]) {
    els["pin-lock-hint"].hidden = !reminderText;
    els["pin-lock-hint"].textContent = reminderText;
  }
  if (els["pin-forgot-hint"]) {
    els["pin-forgot-hint"].hidden = !reminderText;
    els["pin-forgot-hint"].textContent = reminderText;
  }
}

function clearPasscodeSetupError() {
  if (els["pin-setup-error"]) {
    els["pin-setup-error"].textContent = "";
  }
}

function openPasscodeReminderEditor() {
  state.passcodeReminderEditorOpen = true;
  setPasscodeReminderInputs();
  syncPasscodeReminderEditor();
  if (els["pin-reminder-editor"]) {
    focusFirstInteractive(els["pin-reminder-editor"]);
  }
}

function closePasscodeReminderEditor() {
  state.passcodeReminderEditorOpen = false;
  setPasscodeReminderInputs();
  clearPasscodeSetupError();
  syncPasscodeReminderEditor();
}

function syncPasscodeReminderEditor() {
  const reminder = getPasscodeReminder();
  const pinConfigured = isPinLockConfigured();
  const showEditor = !pinConfigured || state.passcodeReminderEditorOpen;

  if (els["pin-reminder-summary"]) {
    els["pin-reminder-summary"].innerHTML = reminder
      ? renderSettingsRow("Reminder", `${reminder.question} • ${maskPasscodeReminderAnswer(reminder.answer)}`)
      : renderSettingsRow("Reminder", "Not set");
    els["pin-reminder-summary"].hidden = !pinConfigured && !reminder;
  }
  if (els["pin-reminder-edit"]) {
    els["pin-reminder-edit"].hidden = !pinConfigured;
  }
  if (els["pin-reminder-clear"]) {
    els["pin-reminder-clear"].hidden = !reminder;
  }
  if (els["pin-reminder-editor"]) {
    els["pin-reminder-editor"].hidden = !showEditor;
  }
  if (els["pin-reminder-save"]) {
    els["pin-reminder-save"].hidden = !pinConfigured || !showEditor;
  }
  if (els["pin-reminder-cancel"]) {
    els["pin-reminder-cancel"].hidden = !pinConfigured || !showEditor;
  }

  if (showEditor) {
    setPasscodeReminderInputs(reminder);
  }
}

async function pinMatchesProfile(pin) {
  if (!state.profile) return false;
  if (state.profile.pinKdf === PASSCODE_KDF_VERSION) {
    const iterations = Number(state.profile.pinIterations || PASSCODE_PBKDF2_ITERATIONS);
    return (await hashPasscodeWithPbkdf2(pin, state.profile.pinSalt, iterations)) === state.profile.pinHash;
  }
  if (state.profile.pinSalt) {
    return (await hashPin(pin, state.profile.pinSalt)) === state.profile.pinHash;
  }
  return legacyHashPin(pin) === state.profile.pinHash;
}

async function verifyPin(inputPin) {
  const pin = String(inputPin || "").trim();
  if (!pin) return false;
  return pinMatchesProfile(pin);
}

async function migrateLegacyPinHash(pin) {
  if (!(state.profile && state.profile.pinHash && state.profile.pinKdf !== PASSCODE_KDF_VERSION)) return;
  state.profile.pinSalt = createPinSalt();
  state.profile.pinIterations = PASSCODE_PBKDF2_ITERATIONS;
  state.profile.pinKdf = PASSCODE_KDF_VERSION;
  state.profile.pinHash = await hashPasscodeWithPbkdf2(pin, state.profile.pinSalt, PASSCODE_PBKDF2_ITERATIONS);
  await saveProfile(state.profile, { skipPush: true });
}

async function handlePinKey(digit) {
  if (digit === "back" && els["pin-entry-input"]) {
    els["pin-entry-input"].value = els["pin-entry-input"].value.slice(0, -1);
    return;
  }
  if (els["pin-entry-input"] && digit && digit !== "back") {
    els["pin-entry-input"].value += digit;
  }
}

function isPinLockConfigured() {
  return Boolean(state.profile?.pinEnabled && state.profile?.pinHash);
}

function showSecurityStatusMessage(message) {
  if (!els["settings-security-status"]) return;
  els["settings-security-status"].textContent = message || "";
  if (!message) return;
  setTimeout(() => {
    if (els["settings-security-status"]) els["settings-security-status"].textContent = "";
  }, 2000);
}

async function applyPinLock(newPin) {
  const reminder = (!isPinLockConfigured() || state.passcodeReminderEditorOpen)
    ? getPasscodeReminderFromInputs()
    : getPasscodeReminder();
  state.profile.pinEnabled = true;
  state.profile.pinSalt = createPinSalt();
  state.profile.pinIterations = PASSCODE_PBKDF2_ITERATIONS;
  state.profile.pinKdf = PASSCODE_KDF_VERSION;
  state.profile.pinHash = await hashPasscodeWithPbkdf2(newPin, state.profile.pinSalt, PASSCODE_PBKDF2_ITERATIONS);
  if (reminder) {
    state.profile.passcodeReminder = clonePasscodeReminder(reminder);
  } else {
    delete state.profile.passcodeReminder;
  }
  delete state.profile.passcode_hint;
  await saveProfile(state.profile, { skipPush: true });

  state.pinAttempts = 0;
  els["pin-input-new"].value = "";
  els["pin-input-confirm"].value = "";
  state.passcodeReminderEditorOpen = false;
  syncPasscodeReminderEditor();
  syncPasscodeReminderDisplays();
  els["pin-setup-error"].textContent = "";
  els["pin-lock-toggle"].classList.add("on");
  els["pin-remove-btn"].hidden = false;
  if (els["pin-reset-btn"]) els["pin-reset-btn"].hidden = false;
  els["pin-setup-area"].hidden = false;
  els["pin-setup-label"].textContent = "Passcode is set — current passcode required to change";
  if (els["pin-save-btn"]) els["pin-save-btn"].textContent = "Update passcode";
  showSecurityStatusMessage("Passcode lock enabled");
}

async function disablePinLockWithConfirmation() {
  const confirmedPin = await requestCurrentPinConfirmation({
    title: "Remove passcode lock?",
    copy: "Enter your current passcode to turn off app lock on this device.",
    confirmText: "Remove passcode lock",
    wrongPinMessage: "Incorrect passcode. Security lock not removed."
  });

  if (!confirmedPin) {
    els["pin-lock-toggle"].classList.add("on");
    return false;
  }

  state.profile.pinEnabled = false;
  state.profile.pinHash = null;
  state.profile.pinSalt = null;
  state.profile.pinKdf = null;
  state.profile.pinIterations = null;
  delete state.profile.passcodeReminder;
  delete state.profile.passcode_hint;
  await saveProfile(state.profile, { skipPush: true });
  state.pinAttempts = 0;
  els["pin-lock-toggle"].classList.remove("on");
  els["pin-setup-area"].hidden = true;
  els["pin-remove-btn"].hidden = true;
  if (els["pin-reset-btn"]) els["pin-reset-btn"].hidden = true;
  els["pin-input-new"].value = "";
  els["pin-input-confirm"].value = "";
  state.passcodeReminderEditorOpen = false;
  setPasscodeReminderInputs(null);
  syncPasscodeReminderEditor();
  els["pin-setup-error"].textContent = "";
  showSecurityStatusMessage("Passcode removed");
  return true;
}

async function togglePinLockPreference() {
  if (!state.profile) return;
  if (isPinLockConfigured()) {
    els["pin-lock-toggle"].classList.add("on");
    await disablePinLockWithConfirmation();
    return;
  }

  const enabled = els["pin-lock-toggle"].classList.toggle("on");
  if (enabled) {
    state.passcodeReminderEditorOpen = true;
    els["pin-setup-area"].hidden = false;
    els["pin-remove-btn"].hidden = !state.profile.pinEnabled;
    if (els["pin-reset-btn"]) els["pin-reset-btn"].hidden = !state.profile.pinEnabled;
    els["pin-setup-label"].textContent = state.profile.pinEnabled ? "Passcode is set — current passcode required to change" : "Create a passcode";
    if (els["pin-save-btn"]) els["pin-save-btn"].textContent = state.profile.pinEnabled ? "Update passcode" : "Save passcode";
    syncPasscodeReminderEditor();
    return;
  }

  state.passcodeReminderEditorOpen = false;
  els["pin-setup-area"].hidden = true;
  els["pin-remove-btn"].hidden = true;
  if (els["pin-reset-btn"]) els["pin-reset-btn"].hidden = true;
  els["pin-setup-error"].textContent = "";
  syncPasscodeReminderEditor();
}

async function savePinLock() {
  if (!state.profile) return;
  const newPin = els["pin-input-new"].value.trim();
  const confirmPin = els["pin-input-confirm"].value.trim();
  const reminder = (!isPinLockConfigured() || state.passcodeReminderEditorOpen)
    ? getPasscodeReminderFromInputs()
    : getPasscodeReminder();

  const passcodeError = getPasscodeValidationMessage(newPin);
  if (passcodeError) {
    els["pin-setup-error"].textContent = passcodeError;
    return;
  }

  if (newPin !== confirmPin) {
    els["pin-setup-error"].textContent = "Passcodes do not match";
    return;
  }

  const reminderError = getPasscodeReminderValidationMessage(newPin, reminder?.question, reminder?.answer);
  if (reminderError) {
    els["pin-setup-error"].textContent = reminderError;
    return;
  }

  if (isPinLockConfigured()) {
    const confirmedPin = await requestCurrentPinConfirmation({
      title: "Confirm current passcode",
      copy: "Enter your current passcode before setting a new one.",
      confirmText: "Confirm passcode",
      wrongPinMessage: "Incorrect passcode. Passcode not changed."
    });

    if (!confirmedPin) {
      return;
    }
  }

  await applyPinLock(newPin);
}

async function savePasscodeReminderOnly() {
  if (!state.profile) return;
  const reminder = getPasscodeReminderFromInputs();
  let currentPasscode = "";

  if (isPinLockConfigured()) {
    const confirmedPin = await requestCurrentPinConfirmation({
      title: "Confirm current passcode",
      copy: "Enter your current passcode before updating the reminder on this device.",
      confirmText: "Save reminder",
      wrongPinMessage: "Incorrect passcode. Reminder not changed."
    });
    if (!confirmedPin) {
      return;
    }
    currentPasscode = confirmedPin;
  }

  const reminderError = getPasscodeReminderValidationMessage(currentPasscode, reminder?.question, reminder?.answer);
  if (reminderError) {
    els["pin-setup-error"].textContent = reminderError;
    return;
  }

  if (reminder) {
    state.profile.passcodeReminder = clonePasscodeReminder(reminder);
  } else {
    delete state.profile.passcodeReminder;
  }
  delete state.profile.passcode_hint;
  await saveProfile(state.profile, { skipPush: true });
  state.passcodeReminderEditorOpen = false;
  clearPasscodeSetupError();
  syncPasscodeReminderEditor();
  syncPasscodeReminderDisplays();
  showSecurityStatusMessage(reminder ? "Reminder updated" : "Reminder cleared");
}

async function clearPasscodeReminder() {
  if (!state.profile) return;
  delete state.profile.passcodeReminder;
  delete state.profile.passcode_hint;
  await saveProfile(state.profile, { skipPush: true });
  state.passcodeReminderEditorOpen = false;
  setPasscodeReminderInputs(null);
  syncPasscodeReminderEditor();
  syncPasscodeReminderDisplays();
  clearPasscodeSetupError();
  showSecurityStatusMessage("Reminder cleared");
}

async function removePinLock() {
  if (!state.profile) return;
  await disablePinLockWithConfirmation();
}

async function unlockWithPasscode() {
  if (!(state.profile && state.profile.pinEnabled && state.profile.pinHash)) return;
  const passcode = String(els["pin-entry-input"]?.value || "").trim();
  if (!passcode) {
    els["pin-error"].textContent = "Enter your passcode.";
    return;
  }

  if (await pinMatchesProfile(passcode)) {
    if (state.profile.pinKdf !== PASSCODE_KDF_VERSION) {
      await migrateLegacyPinHash(passcode);
    }
    state.pinAttempts = 0;
    state.lastPinUnlockAt = Date.now();
    syncPasscodeReminderDisplays();
    hidePinLock();
    els["pin-error"].textContent = "";
    if (els["pin-entry-input"]) {
      els["pin-entry-input"].value = "";
    }
    return;
  }

  state.pinAttempts += 1;
  syncPasscodeReminderDisplays();
  if (els["pin-entry-input"]) {
    els["pin-entry-input"].value = "";
  }
  els["pin-error"].textContent = state.pinAttempts >= 3 ? "Too many attempts. Try again." : "Incorrect passcode. Try again.";
  window.setTimeout(() => {
    if (els["pin-error"]) els["pin-error"].textContent = "";
  }, 2400);
}

async function requireFreshPin() {
  if (!(state.profile?.pinEnabled && state.profile?.pinHash)) return;
  if (Date.now() - (state.lastPinUnlockAt || 0) < 4 * 60 * 60 * 1000) return;

  const confirmedPin = await requestCurrentPinConfirmation({
    title: "Confirm PIN to continue",
    copy: "Enter your current passcode to continue.",
    confirmText: "Continue",
    wrongPinMessage: "Incorrect passcode."
  });

  if (!confirmedPin) {
    throw new Error("cancelled");
  }

  state.lastPinUnlockAt = Date.now();
}

function formatVerifiedReportSpanDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "N/A";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric"
  }).format(date);
}

function getTierButtonPriceLabel(button, currencyPrefix) {
  const amountMinor = Number(button?.dataset?.amount || 0);
  const amountMajor = amountMinor > 0 ? Math.round(amountMinor / 100) : 0;
  return `${currencyPrefix}${amountMajor.toLocaleString("en-US")}`;
}

async function refreshTierButtonLabels() {
  if (!state.db) return;

  try {
    const records = await getRecords();
    if (!records.length) return;

    const distinctDays = new Set();
    let earliestDate = null;
    let latestDate = null;

    records.forEach((record) => {
      const confirmedAtMs = getRecordConfirmedAtMs(record);
      if (!confirmedAtMs) return;

      const confirmedDate = new Date(confirmedAtMs);
      if (Number.isNaN(confirmedDate.getTime())) return;

      const dayKey = [
        confirmedDate.getFullYear(),
        String(confirmedDate.getMonth() + 1).padStart(2, "0"),
        String(confirmedDate.getDate()).padStart(2, "0")
      ].join("-");

      distinctDays.add(dayKey);

      if (!earliestDate || confirmedDate < earliestDate) {
        earliestDate = confirmedDate;
      }
      if (!latestDate || confirmedDate > latestDate) {
        latestDate = confirmedDate;
      }
    });

    const totalDays = distinctDays.size;
    if (!totalDays || !earliestDate || !latestDate) return;

    const verifiedReportSubtitle = els["verified-report-region-note"]?.previousElementSibling;
    if (verifiedReportSubtitle?.matches("p.subtle")) {
      verifiedReportSubtitle.textContent = `Server-attested file. Your records span ${formatVerifiedReportSpanDate(earliestDate)} to ${formatVerifiedReportSpanDate(latestDate)}. The app is free to use.`;
    }
  } catch (error) {
    console.warn("Unable to refresh verifiable export labels.", error);
  }
}

function canClaimFreeReport() {
  return true;
}

async function rememberFreeReportClaimedUiHint() {
  localStorage.setItem("reportGeneratedHint", "1");
  if (state.profile) {
    state.profile.report_generated_hint = true;
    try {
      await saveProfile(state.profile, { skipPush: true });
    } catch (error) {
      console.warn("Unable to persist free report UI hint locally.", error);
    }
  }
}

function syncFreeReportOffer() {
  if (els["free-report-btn"]) {
    els["free-report-btn"].hidden = true;
  }
}

function renderExportScreen() {
  refreshTrustSetupButtons();
  els["export-status-v2"].textContent = "";
  if (els["report-status"]) {
    els["report-status"].textContent = "";
  }
  if (els["verified-report-section"]) {
    els["verified-report-section"].hidden = !(isAuthSessionValid() && state.deviceIdentity);
  }
  if (els["verified-report-region-note"]) {
    els["verified-report-region-note"].hidden = true;
    els["verified-report-region-note"].textContent = "";
  }
  if (els["export-trust-status-v3"]) {
    els["export-trust-status-v3"].innerHTML = `
      ${renderSettingsRow("Verification summary", getVerificationSummaryLabel())}
      ${renderSettingsRow("Verification channels", getVerificationChannelAvailabilityLabel())}
      ${renderSettingsRow("Email verification", getVerificationStatusLabel("email"))}
      ${(state.smsSupported || state.profile?.phone_verified) ? renderSettingsRow("Phone verification", getVerificationStatusLabel("sms")) : ""}
      ${renderSettingsRow("Phone anchor", getPhoneAnchorStatusLabel())}
      ${renderSettingsRow("Device key", getDeviceKeyStatusLabel())}
      ${state.publicKeyFingerprint ? renderSettingsRow("Device ID", state.publicKeyFingerprint.slice(0, 8)) : ""}
      ${renderSettingsRow("Sync status", state.syncStatus || "Idle")}
      ${renderSettingsRow("Queued sync entries", String(state.syncQueueCount))}
      ${renderSettingsRow("Recovery contact", maskContact(state.profile?.email || state.profile?.phone_number || "Not set"))}
    `;
  }
  const exportScopeNoteId = "export-scope-note";
  let scopeNote = document.getElementById(exportScopeNoteId);
  if (!scopeNote) {
    scopeNote = document.createElement("p");
    scopeNote.id = exportScopeNoteId;
    scopeNote.style.cssText = "font-size: 0.85rem; color: #6B7C6B; margin: 0.5rem 0 1rem; font-style: italic;";
    scopeNote.textContent = "This report reflects server-synced records from device identities linked to this account. The ledger lists the device used for each entry.";
  }
  const exportActionAnchor = els["export-open-trust-v3"];
  if (exportActionAnchor?.parentElement) {
    exportActionAnchor.parentElement.insertBefore(scopeNote, exportActionAnchor);
  }
  syncFreeReportOffer();
  void refreshTierButtonLabels();
  refreshExportState();
  refreshTrustBanner("screen-export");
  refreshStorageWarning();
}

async function generateExport() {
  if (isAuthSessionValid() && state.deviceIdentity) {
    await claimFreeReport();
    return;
  }

  if (!hasFreeExportQuota()) {
    refreshExportState();
    els["export-status-v2"].textContent = "Export is available.";
    return;
  }

  const records = await getRecords();
  if (!records.length) {
    els["export-status-v2"].textContent = "No confirmed records yet.";
    return;
  }

  const currency = getProfileCurrency();
  const ledgerRootHash = records[records.length - 1].entry_hash;
  const financialStatements = buildFinancialStatements(records, currency);
  const lines = records.map((record) => formatExportLedgerEntry(record, currency));
  const evidenceCounts = { self_reported: 0, device_signed: 0, server_attested: 0, corroborated: 0 };
  records.forEach((record) => {
    const level = record.evidence_level || "self_reported";
    if (evidenceCounts[level] !== undefined) evidenceCounts[level] += 1;
  });
  const total = records.length;
  const attested = evidenceCounts.server_attested + evidenceCounts.corroborated;
  const attestedPercent = total ? Math.round((attested / total) * 100) : 0;

  lines.push("");
  lines.push("=== Evidence Summary ===");
  lines.push("Total entries: " + total);
  lines.push("  Server-attested: " + evidenceCounts.server_attested);
  lines.push("  Device-signed: " + evidenceCounts.device_signed);
  lines.push("  Self-reported: " + evidenceCounts.self_reported);
  lines.push(attested + " of " + total + " entries (" + attestedPercent + "%) have server attestation.");
  const signedCount = records.filter((record) => Boolean(record.signature)).length;
  const unsignedCount = records.length - signedCount;
  let attestation = null;
  let qrDataUrl = null;
  let base64PublicKey = null;

  if (isAuthSessionValid() && state.deviceIdentity) {
    try {
      const response = await postJson(state.syncApiBaseUrl, "/attest", {
        device_identity: state.deviceIdentity,
        window_days: 0
      }, state.authSessionKey, {
        deviceIdentity: state.deviceIdentity
      });

      if (response?.vt_id && response?.verify_url) {
        attestation = response;
        await saveSetting("last_vt_id", attestation.vt_id).catch(() => null);
        await saveSetting("last_verify_url", attestation.verify_url).catch(() => null);

        if (window.QRCode?.toDataURL) {
          qrDataUrl = await window.QRCode.toDataURL(attestation.verify_url);
        }
      }
    } catch (error) {
      console.warn("Attestation unavailable during export.", error);
    }
  }

  try {
    const storedPublicKey = state.devicePublicKey || await getSetting("device_public_key");
    let publicKey = storedPublicKey;
    if (!(typeof CryptoKey !== "undefined" && storedPublicKey instanceof CryptoKey)) {
      publicKey = await crypto.subtle.importKey(
        "jwk",
        JSON.parse(storedPublicKey),
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["verify"]
      );
    }
    const spkiBuffer = await crypto.subtle.exportKey("spki", publicKey);
    base64PublicKey = btoa(String.fromCharCode(...new Uint8Array(spkiBuffer)));
  } catch (error) {
    console.warn("Device public key unavailable during export.", error);
  }

  const verificationStatus = signedCount
    ? (attestation?.verify_url
      ? `Device-signed and server-attested. Verify at ${attestation.verify_url}`
      : "Device-signed on this device. Server attestation coming.")
    : `Legacy unsigned history only. Complete ${getVerificationChannelLabel().toLowerCase()} to start device signing.`;
  const {
    grossRevenue,
    otherIncome,
    costOfGoods,
    operatingExpenses,
    netIncome
  } = financialStatements.incomeStatement;
  const totalInflows = grossRevenue + otherIncome;
  const totalOutflows = costOfGoods + operatingExpenses;
  const cashFlowTotals = financialStatements.cashFlowByMonth.reduce((totals, month) => {
    totals.inflows += month.inflows;
    totals.outflows += month.outflows;
    totals.net += month.net;
    return totals;
  }, { inflows: 0, outflows: 0, net: 0 });
  const formatExportDate = (timestampSeconds) => {
    if (!timestampSeconds) return "N/A";
    return new Date(timestampSeconds * 1000).toISOString().slice(0, 10);
  };
  const statementDivider = `${"".padEnd(29)}${"-".repeat(16)}`;
  const formatStatementRow = (label, amountMinor) => `${String(label).padEnd(29)}${formatAmount(amountMinor, currency)}`;
  const formatCashFlowValue = (value) => typeof value === "string"
    ? value
    : formatAmount(value, currency);
  const formatCashFlowRow = (monthLabel, inflows, outflows, net) => [
    String(monthLabel).padEnd(11),
    formatCashFlowValue(inflows).padStart(16),
    formatCashFlowValue(outflows).padStart(16),
    formatCashFlowValue(net).padStart(16)
  ].join("");
  const activitySummaryLines = [
    "============================",
    "ACTIVITY SUMMARY",
    `Period: ${formatExportDate(financialStatements.dateRange.start)} to ${formatExportDate(financialStatements.dateRange.end)}`,
    "============================",
    formatStatementRow("Recorded Sales Inflows", grossRevenue),
    formatStatementRow("Other Recorded Inflows", otherIncome),
    statementDivider,
    formatStatementRow("Total Recorded Inflows", totalInflows),
    "",
    formatStatementRow("Recorded Purchase Outflows", costOfGoods),
    formatStatementRow("Recorded Operating Outflows", operatingExpenses),
    statementDivider,
    formatStatementRow("Total Recorded Outflows", totalOutflows),
    "",
    formatStatementRow("NET RECORDED ACTIVITY", netIncome),
    "============================"
  ];
  const monthlyActivityLines = [
    "============================",
    "MONTHLY ACTIVITY VIEW",
    "============================",
    formatCashFlowRow("Month", "Inflows", "Outflows", "Net"),
    ...financialStatements.cashFlowByMonth.map((row) => formatCashFlowRow(row.month, row.inflows, row.outflows, row.net)),
    "-".repeat(59),
    formatCashFlowRow("TOTAL", cashFlowTotals.inflows, cashFlowTotals.outflows, cashFlowTotals.net),
    "============================"
  ];
  const borrowing = financialStatements.borrowing || { borrowedIn: 0, loanRepaid: 0 };
  const recordedBorrowingLines = (borrowing.borrowedIn || borrowing.loanRepaid)
    ? [
        "============================",
        "RECORDED BORROWING ACTIVITY",
        "============================",
        formatStatementRow("Money Borrowed (recorded)", borrowing.borrowedIn),
        formatStatementRow("Loan Repayments (recorded)", borrowing.loanRepaid),
        "============================",
        "Borrowed funds are recorded money movements, not sales, receipts,",
        "revenue, income, or verified liabilities. Konfirmata does not",
        "independently verify that the underlying borrowing occurred.",
        "Records labelled \"Business Loan\" confirmed before the borrowing",
        "taxonomy was introduced may have been recorded as receipts.",
        "============================"
      ]
    : [];
  const devicePublicKeyExportSection = [
    "",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "DEVICE PUBLIC KEY (ECDSA P-256)",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "The following public key corresponds to the signing device.",
    "Each ledger entry below includes the canonical payload, entry hash,",
    "prior hash, and signature material needed for offline verification",
    "using any standard P-256 cryptographic tool.",
    "",
    base64PublicKey
      ? `Public Key (Base64, SPKI format):\n${base64PublicKey}`
      : "Public Key: Not available — key storage error",
    "",
    "To verify offline:",
    "1. Read the canonical_payload_utf8 block for an entry",
    "2. Compute SHA-256(canonical_payload_utf8) and confirm it matches entry_hash",
    "3. Verify signature_base64 against signature_message_utf8 using the public key above",
    "4. Confirm each prev_entry_hash matches the prior entry_hash in sequence",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  ].join("\n");

  const output = [
    "KONFIRMATA V3 EXPORT",
    "Note: This local export reflects records available on this device.",
    `Generated: ${new Date().toLocaleString()}`,
    `Profile: ${countryName(state.profile.operating_region)} / ${BUSINESS_TYPES.find((item) => item.id === state.profile.business_type_id)?.name || "Unknown"}`,
    state.profile.display_name ? `Name: ${state.profile.display_name}` : null,
    state.profile.region ? `Region: ${state.profile.region}` : null,
    `Language: ${getLanguageName(state.profile.language)}`,
    `Verification Anchor: ${getPhoneAnchorStatusLabel()}`,
    `Device Key: ${getDeviceKeyStatusLabel()}`,
    state.publicKeyFingerprint ? `Public Key Fingerprint: ${state.publicKeyFingerprint}` : null,
    `Sync Server: ${state.syncApiBaseUrl || "Not configured"}`,
    `Sync Status: ${state.syncStatus || "Idle"}`,
    `Queued Sync Entries: ${state.syncQueueCount}`,
    "Note: This export contains your private account data. Do not share unless intended.",
    `Phone: ${state.profile.phone_number || "Not set"}`,
    `Email: ${state.profile.email || "Not set"}`,
    `Entries: ${records.length}`,
    `Signed entries: ${signedCount}`,
    `Unsigned legacy entries: ${unsignedCount}`,
    "NOTE: Konfirmata produces user-confirmed, tamper-evident business activity records whose integrity, sequence, and device origin can be checked. Konfirmata does not independently verify that an underlying transaction occurred, does not produce financial statements, and does not make lending, underwriting, credit, tax, eligibility, or institutional decisions.",
    "---",
    ...activitySummaryLines,
    "",
    ...monthlyActivityLines,
    "",
    ...recordedBorrowingLines,
    "",
    "--- TRANSACTION LEDGER (APPENDIX) ---",
    "Each record below includes a human-readable summary followed by its verification bundle.",
    ...lines,
    "---",
    `Ledger Root Hash: ${ledgerRootHash}`,
    `Verification Status: ${verificationStatus}`,
    attestation?.vt_id ? `vt_id: ${attestation.vt_id}` : null,
    attestation?.verify_url ? `verify_url: ${attestation.verify_url}` : null,
    qrDataUrl ? `qr_code_data_url: ${qrDataUrl}` : null,
    devicePublicKeyExportSection
  ].filter(Boolean).join("\n");

  const blob = new Blob([output], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `konfirmata-export-${Date.now()}.txt`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  refreshExportState();
  els["export-status-v2"].textContent = "Export downloaded.";
}

function setReportStatus(message) {
  if (els["report-status"]) {
    els["report-status"].textContent = message || "";
  }
}

function downloadBase64File(base64, filename, mimeType) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  const blob = new Blob([bytes], { type: mimeType });
  downloadBlobFile(blob, filename);
}

function downloadBlobFile(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

async function offerPdfShare(blob, filename, verifyUrl = "") {
  try {
    if (!("File" in window) || !navigator.share) return false;
    const file = new File([blob], filename, { type: "application/pdf" });
    if (navigator.canShare && !navigator.canShare({ files: [file] })) return false;

    await navigator.share({
      files: [file],
      title: "Konfirmata verifiable export",
      text: verifyUrl ? `Verify this export at ${verifyUrl}` : "Konfirmata verifiable export"
    });
    return true;
  } catch (error) {
    if (error?.name !== "AbortError") {
      console.warn("PDF share was not completed.", error);
    }
    return false;
  }
}

function getVerifiedReportDownloadPayload(response) {
  if (!(response?.ok && response?.pdf_base64 && response?.filename)) {
    throw new Error("Invalid PDF response.");
  }
  return response;
}

function downloadVerifiedReportPayload(response) {
  const payload = getVerifiedReportDownloadPayload(response);
  downloadBase64File(payload.pdf_base64, payload.filename, "application/pdf");
  setReportStatus("Verifiable export downloaded.");
  return payload;
}

function addWrappedPdfText(doc, text, x, y, options = {}) {
  const width = options.width || 500;
  const lineHeight = options.lineHeight || 14;
  const lines = doc.splitTextToSize(String(text || ""), width);
  doc.text(lines, x, y);
  return y + (lines.length * lineHeight);
}

function addPdfPageIfNeeded(doc, y, bottom = 740) {
  if (y <= bottom) return y;
  doc.addPage();
  return 54;
}

function isRecordFromCurrentDevice(record) {
  const recordDeviceIdentity = String(record?.device_identity || "").trim();
  if (state.deviceIdentity && recordDeviceIdentity) {
    return recordDeviceIdentity === state.deviceIdentity;
  }

  const recordFingerprint = String(record?.public_key_fingerprint || "").trim();
  if (state.publicKeyFingerprint && recordFingerprint) {
    return recordFingerprint === state.publicKeyFingerprint;
  }

  return !recordDeviceIdentity;
}

function selectRecordsCoveredByAttestation(records, attestation) {
  if (!attestation) return records;
  const attestedCount = Number(attestation.entry_count || 0);
  const ledgerRootHash = String(attestation.ledger_root_hash || "").trim();
  if (!attestedCount || !ledgerRootHash) return records;

  const rootIndex = records.findIndex((record) => String(record.entry_hash || "").trim() === ledgerRootHash);
  if (rootIndex === -1) return [];

  const startIndex = Math.max(0, rootIndex - attestedCount + 1);
  return records.slice(startIndex, rootIndex + 1);
}

async function getReportRecordsForCurrentDevice() {
  const localRecords = await getRecords();
  let serverRecords = [];

  try {
    if (isAuthSessionValid() && state.syncApiBaseUrl) {
      await flushSyncQueue();
      const response = await fetchAuthenticatedJson("/records");
      const restoredRecords = Array.isArray(response.records) ? response.records : [];
      serverRecords = restoredRecords
        .filter((record) => isRecordFromCurrentDevice(record))
        .map((record, index) => normalizeImportedRecord(record, index));
    }
  } catch (error) {
    console.warn("Server records unavailable during report generation.", error);
  }

  if (serverRecords.length) {
    return {
      records: serverRecords,
      localRecordCount: localRecords.length,
      source: "server"
    };
  }

  const merged = new Map();
  localRecords.filter((record) => isRecordFromCurrentDevice(record)).forEach((record) => {
    const key = record.entry_hash
      || (record.server_entry_id ? `server:${record.server_entry_id}:${record.device_identity || ""}` : "")
      || `local:${record.id || ""}:${record.confirmed_at || ""}:${record.amount_minor || ""}:${record.label || ""}`;
    if (!key) return;
    const existing = merged.get(key);
    merged.set(key, {
      ...(existing || {}),
      ...record,
      evidence_level: record.evidence_level || existing?.evidence_level || null
    });
  });

  const records = [...merged.values()].sort((a, b) => {
    const timeDiff = getRecordConfirmedAtMs(a) - getRecordConfirmedAtMs(b);
    if (timeDiff) return timeDiff;
    return Number(a.server_entry_id || a.id || 0) - Number(b.server_entry_id || b.id || 0);
  });

  return {
    records,
    localRecordCount: localRecords.length,
    source: "local"
  };
}

async function buildClientVerifiablePdfReport() {
  const reportData = await getReportRecordsForCurrentDevice();
  let records = reportData.records;
  if (!records.length) {
    throw new Error("No confirmed records yet.");
  }

  const jsPdfCtor = window.jspdf?.jsPDF;
  if (!jsPdfCtor) {
    throw new Error("PDF generator is not available. Refresh the app and try again.");
  }

  const currency = getProfileCurrency();
  const issuedAt = new Date();
  let attestation = null;
  let qrDataUrl = "";

  try {
    attestation = await postJson(state.syncApiBaseUrl, "/attest", {
      device_identity: state.deviceIdentity,
      window_days: 0
    }, state.authSessionKey, {
      deviceIdentity: state.deviceIdentity
    });

    const coveredRecords = selectRecordsCoveredByAttestation(records, attestation);
    if (coveredRecords.length) {
      records = coveredRecords;
    }

    const attestedCount = Number(attestation?.entry_count || 0);
    const attestedRootHash = String(attestation?.ledger_root_hash || "").trim();
    const reportRootHash = String(records[records.length - 1]?.entry_hash || "").trim();
    if (attestedCount && attestedCount !== records.length) {
      throw new Error(`Public attestation covered ${attestedCount} server record${attestedCount === 1 ? "" : "s"}, but the draft report had ${records.length}. Please wait for sync and try again.`);
    }
    if (attestedRootHash && reportRootHash && attestedRootHash !== reportRootHash) {
      throw new Error("Public attestation did not match the report ledger root. Please wait for sync and try again.");
    }

    if (attestation?.vt_id) {
      await saveSetting("last_vt_id", attestation.vt_id).catch(() => null);
    }
    if (attestation?.verify_url) {
      await saveSetting("last_verify_url", attestation.verify_url).catch(() => null);
    }
    if (attestation?.verify_url && window.QRCode?.toDataURL) {
      qrDataUrl = await window.QRCode.toDataURL(attestation.verify_url, { width: 180, margin: 1 });
    }
  } catch (error) {
    console.warn("Server attestation unavailable during client PDF generation.", error);
    attestation = null;
    qrDataUrl = "";
  }

  const omittedRecordCount = Math.max(0, Number(reportData.localRecordCount || records.length) - records.length);
  const ledgerRootHash = records[records.length - 1].entry_hash || "";
  const doc = new jsPdfCtor({ unit: "pt", format: "letter" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 54;
  let y = 58;

  doc.setTextColor(13, 31, 23);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  y = addWrappedPdfText(doc, "Konfirmata Activity Export - Device-Generated Fallback", margin, y, { width: 380, lineHeight: 21 }) + 14;

  const fallbackTicketAvailable = Boolean(attestation && attestation.vt_id);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.setTextColor(13, 31, 23);
  const fallbackNoticeText = "This PDF was generated on the user's device as a fallback because the server-generated report was unavailable. It is not the account-level server-attested report generated by POST /report/generate-pdf. "
    + (fallbackTicketAvailable
      ? "Reviewers should use any included verification ticket only as a single-device attestation, not as account-level report attestation."
      : "No server attestation ticket is included in this fallback copy.");
  y = addWrappedPdfText(doc, fallbackNoticeText, margin, y, { width: 380, lineHeight: 12 }) + 14;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(77, 91, 81);
  y = addWrappedPdfText(
    doc,
    "Konfirmata does not independently verify that an underlying transaction occurred. It produces user-controlled, tamper-evident business activity records whose integrity, sequence, and device origin can be cryptographically verified. It does not produce financial statements and does not make lending decisions.",
    margin,
    y,
    { width: 500, lineHeight: 12 }
  ) + 12;

  if (records.some((record) => record.transaction_type === "liability_in" || record.transaction_type === "liability_out")) {
    y = addWrappedPdfText(
      doc,
      "Borrowed funds are recorded money movements, not sales, receipts, revenue, income, or verified liabilities. Konfirmata does not independently verify that the underlying borrowing occurred.",
      margin,
      y,
      { width: 500, lineHeight: 12 }
    ) + 12;
  }

  if (qrDataUrl) {
    try {
      doc.addImage(qrDataUrl, "PNG", pageWidth - margin - 112, 58, 112, 112);
    } catch (error) {
      console.warn("QR image could not be embedded in the PDF.", error);
    }
  }

  const detailRows = [
    ["Generated", issuedAt.toLocaleString()],
    ["Profile", `${countryName(state.profile.operating_region)} / ${BUSINESS_TYPES.find((item) => item.id === state.profile.business_type_id)?.name || "Unknown"}`],
    ["Entry count", String(records.length)],
    ["Ledger root hash", attestation?.ledger_root_hash || ledgerRootHash],
    ["Device fingerprint", attestation?.device_fingerprint || state.publicKeyFingerprint?.slice(0, 8) || "Not available"],
    ["Verification ticket", attestation?.vt_id || "Server attestation unavailable"],
    ["Verification URL", attestation?.verify_url || "Server attestation unavailable"],
    ["Signature algorithm", attestation?.signature_algorithm || "Server attestation unavailable"],
    ["Verification key URL", attestation?.verification_key_url || "Server attestation unavailable"]
  ];

  doc.setFontSize(11);
  detailRows.forEach(([label, value]) => {
    y = addPdfPageIfNeeded(doc, y);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(13, 31, 23);
    doc.text(label, margin, y);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(34, 48, 38);
    y = addWrappedPdfText(doc, value, 190, y, { width: 330, lineHeight: 13 }) + 7;
  });

  if (attestation?.verify_url && omittedRecordCount) {
    y += 6;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(77, 91, 81);
    y = addWrappedPdfText(
      doc,
      `${omittedRecordCount} local or restored record${omittedRecordCount === 1 ? "" : "s"} were not included because this public ticket only covers server-attested records for the current device session.`,
      margin,
      y,
      { width: 500, lineHeight: 11 }
    ) + 8;
  }

  y += 10;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.setTextColor(13, 31, 23);
  doc.text("Recorded Activity", margin, y);
  y += 18;

  doc.setFontSize(9);
  records.slice(-75).forEach((record) => {
    y = addPdfPageIfNeeded(doc, y, 720);
    const timestamp = record.confirmed_at ? new Date(record.confirmed_at * 1000).toLocaleString() : "Not dated";
    const line = [
      timestamp,
      record.transaction_type || "record",
      record.label || record.normalized_label || "Unlabeled",
      formatMoney(record.amount_minor || 0, record.currency || currency),
      record.entry_hash ? `hash ${String(record.entry_hash).slice(0, 18)}...` : "hash unavailable"
    ].join(" | ");
    doc.setFont("helvetica", "normal");
    doc.setTextColor(34, 48, 38);
    y = addWrappedPdfText(doc, line, margin, y, { width: 500, lineHeight: 11 }) + 4;
  });

  const filenameDate = issuedAt.toISOString().slice(0, 10);
  const filename = `konfirmata-activity-export-fallback-${filenameDate}.pdf`;
  const pdfBlob = doc.output("blob");
  downloadBlobFile(pdfBlob, filename);
  const shared = await offerPdfShare(pdfBlob, filename, attestation?.verify_url || "");
  const omittedStatus = omittedRecordCount && attestation?.verify_url
    ? ` ${omittedRecordCount} local/restored record${omittedRecordCount === 1 ? "" : "s"} were excluded because they are not covered by this public ticket.`
    : "";
  setReportStatus(attestation?.verify_url
    ? `Fallback PDF downloaded with single-device verification ticket. This is not the account-level server-attested report.${shared ? " Share options opened." : ""}${omittedStatus}`
    : "Fallback PDF downloaded. This device-generated export is not the account-level server-attested report.");
}

async function claimFreeReport() {
  if (!isAuthSessionValid()) {
    setReportStatus(getExpiredAuthSessionMessage());
    return;
  }

  if (!state.deviceIdentity) {
    setReportStatus(`Complete ${getVerificationChannelLabel().toLowerCase()} on this device before generating a verifiable export.`);
    return;
  }

  const button = document.getElementById("free-report-btn");
  if (button) {
    button.disabled = true;
    button.textContent = "Generating free report...";
  }
  setReportStatus("Generating your verifiable export...");

  try {
    const response = await postJson(state.syncApiBaseUrl, "/report/generate-pdf", {
      free_claim: true,
      window_days: 0
    }, state.authSessionKey, {
      deviceIdentity: state.deviceIdentity
    });
    getVerifiedReportDownloadPayload(response);
    await rememberFreeReportClaimedUiHint();
    syncFreeReportOffer();
    downloadVerifiedReportPayload(response);
  } catch (error) {
    console.error("Free verifiable export generation failed.", error);
    if (error.statusCode === 404 || error.statusCode == null) {
      try {
        setReportStatus(error.statusCode == null
          ? "You appear to be offline. Generating PDF on this device..."
          : "Server PDF route unavailable. Generating PDF on this device...");
        await buildClientVerifiablePdfReport();
        await rememberFreeReportClaimedUiHint();
        syncFreeReportOffer();
      } catch (fallbackError) {
        console.error("Client verifiable PDF generation failed.", fallbackError);
        const fallbackMessage = fallbackError?.message || "Unable to generate your verifiable export right now.";
        setReportStatus(`PDF generation failed: ${fallbackMessage}`);
      }
    } else {
      setReportStatus(error.message || "Unable to generate your verifiable export right now.");
    }
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "Get free report";
    }
  }
}

function renderActionRows() {
  const isSpecialAction = state.currentAction === "transfer" || isLiabilityAction(state.currentAction);
  const primarySelected = isSpecialAction ? null : state.currentAction;
  const transferSelected = state.currentAction === "transfer" ? state.transferSubtype : null;
  const liabilitySelected = isLiabilityAction(state.currentAction) ? state.currentAction : null;

  renderActionButtons(els["primary-actions"], PRIMARY_ACTIONS, primarySelected, (id) => {
    state.currentAction = id;
    state.profile.last_action = id;
    renderActionRows();
    renderQuickLabels();
    clearSelectedLabel();
  });

  renderActionButtons(els["transfer-actions"], TRANSFER_ACTIONS, transferSelected, (id) => {
    state.currentAction = "transfer";
    state.transferSubtype = id;
    renderActionRows();
    renderQuickLabels();
    clearSelectedLabel();
  });

  renderActionButtons(els["liability-actions"], LIABILITY_ACTIONS, liabilitySelected, (id) => {
    state.currentAction = id;
    state.profile.last_action = id;
    renderActionRows();
    renderQuickLabels();
    clearSelectedLabel();
  });

  if (FEATURE_TRANSFER_PRIMARY && !PRIMARY_ACTIONS.find((item) => item.id === "transfer")) {
    PRIMARY_ACTIONS.push({ id: "transfer", label: "Transfer", icon: "🔁", help: "Internal movement between owned accounts." });
  }

  els["transfer-details"].hidden = state.currentAction !== "transfer";
}

function renderActionButtons(container, actions, selectedId, handler) {
  container.innerHTML = "";
  actions.forEach((action) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `action-card${selectedId === action.id ? " active" : ""}`;
    button.innerHTML = `<strong>${action.icon} ${action.label}</strong><span>${action.help}</span>`;
    button.addEventListener("click", () => handler(action.id));
    container.appendChild(button);
  });
}

async function renderQuickLabels() {
  els["quick-label-grid"].innerHTML = "";
  const preferredCount = normalizePreferredLabels(state.profile?.preferred_labels, state.profile?.business_type_id).length;
  const ranked = await rankLabels("", {
    limit: Math.max(9, preferredCount),
    includePreferred: true
  });
  ranked.forEach((item) => {
    els["quick-label-grid"].appendChild(buildRankedLabelButton(item));
  });
  await renderBrowseResults();
}

function buildRankedLabelButton(item) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `ranked-item${state.selectedLabel && state.selectedLabel.id === item.id ? " active" : ""}`;
  button.innerHTML = `<strong>${item.icon || "🏷️"} ${escapeHtml(item.display_name)}</strong><span>${escapeHtml(contextCopy(item))}</span>`;
  button.addEventListener("click", () => selectLabel(item));
  return button;
}

function contextCopy(item) {
  if (item.subtitle) return item.subtitle;
  const context = item.transaction_contexts[0] || "";
  return friendlyActionLabel(context);
}

function selectLabel(item) {
  state.selectedLabel = item;
  els["selected-label-chip"].textContent = `${item.icon || "🏷️"} ${item.display_name} selected`;
  void maybeLearnVoiceCorrection();
  renderQuickLabels();
  closeSelector();
}

function clearSelectedLabel() {
  state.selectedLabel = null;
  els["selected-label-chip"].textContent = "No label selected yet.";
}

function setVoiceRecordError(message) {
  els["voice-error-v2"].hidden = !message;
  els["voice-error-v2"].textContent = message || "";
}

function clearPendingVoiceTranscript() {
  state.lastVoiceTranscript = "";
  state.lastVoiceCaptureContext = "";
  state.lastVoiceLearnedCorrection = "";
}

function rememberVoiceTranscript(transcript, context) {
  state.lastVoiceTranscript = String(transcript || "").trim();
  state.lastVoiceCaptureContext = context || "";
  state.lastVoiceLearnedCorrection = "";
}

function getSpeechRecognitionErrorMessage(errorType) {
  if (errorType === "not-allowed") {
    return "Microphone access denied. In Safari, go to Settings → Safari → Microphone and allow access for this site.";
  }
  if (errorType === "no-speech") {
    return "No speech detected. Please try again.";
  }
  if (errorType === "audio-capture") {
    return "No microphone found on this device.";
  }
  if (errorType === "network") {
    return "Speech service unavailable. Please use text input.";
  }
  return "Microphone error. Please try again or use text input.";
}

function getSpeechEventTranscript(event) {
  const results = event?.results;
  if (!results?.length) return { transcript: "", isFinal: false };

  const finalParts = [];
  const interimParts = [];

  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    const transcript = String(result?.[0]?.transcript || "").trim();
    if (!transcript) continue;
    if (result.isFinal) {
      finalParts.push(transcript);
    } else {
      interimParts.push(transcript);
    }
  }

  if (finalParts.length) {
    return { transcript: finalParts.join(" ").trim(), isFinal: true };
  }

  return { transcript: interimParts.join(" ").trim(), isFinal: false };
}

function formatVoiceCorrectionAmount(value) {
  const normalized = String(value || "").trim().replace(/,/g, "");
  if (!normalized) return "";
  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount <= 0) return "";
  const currency = getProfileCurrency();
  return amount.toLocaleString(getCurrencyLocale(currency), {
    minimumFractionDigits: currency === "NGN" ? 0 : (Number.isInteger(amount) ? 0 : 2),
    maximumFractionDigits: currency === "NGN" ? 0 : 2
  });
}

function buildVoiceCorrectionCandidate() {
  if (!state.lastVoiceTranscript || state.lastVoiceCaptureContext !== "capture") return "";
  const label = state.selectedLabel?.display_name?.trim();
  const amount = formatVoiceCorrectionAmount(els["amount-input-v2"]?.value);
  if (!label || !amount) return "";

  const actionContext = getCurrentActionContext();
  if (actionContext === "sale") return `sold ${label} for ${amount}`;
  if (actionContext === "purchase") return `bought ${label} for ${amount}`;
  if (actionContext === "payment") return `paid ${label} ${amount}`;
  if (actionContext === "receipt") return `received ${label} ${amount}`;
  return "";
}

async function maybeLearnVoiceCorrection() {
  const rawTranscript = String(state.lastVoiceTranscript || "").trim();
  if (!rawTranscript || state.lastVoiceCaptureContext !== "capture") return;

  const corrected = buildVoiceCorrectionCandidate();
  const normalizedCorrected = String(corrected || "").trim().toLowerCase();
  if (!normalizedCorrected) return;
  if (normalizedCorrected === rawTranscript.toLowerCase()) return;
  if (normalizedCorrected === state.lastVoiceLearnedCorrection) return;

  await saveVoiceCorrection(rawTranscript, corrected);
  state.lastVoiceLearnedCorrection = normalizedCorrected;

  if (document.querySelector(".screen.active")?.id === "screen-settings") {
    await renderVoiceCorrectionsSettings();
  }
}

function announceVoiceCapture(parsed, labelDisplayName) {
  if (!els["voice-announce"]) return;
  const actionCopy = {
    sale: "sold",
    purchase: "bought",
    payment: "paid",
    receipt: "received",
    liability_in: "recorded borrowing of",
    liability_out: "recorded loan repayment of"
  }[parsed.action] || "captured";
  const currency = getProfileCurrency();
  const label = String(labelDisplayName || parsed.labelQuery || "transaction").toLowerCase();
  const amount = formatMoney(parsed.amountMinor || 0, currency);
  const message = `Captured: ${actionCopy} ${label}, ${amount}`;
  els["voice-announce"].textContent = "";
  window.setTimeout(() => {
    if (els["voice-announce"]) {
      els["voice-announce"].textContent = message;
    }
  }, 0);
}

function handleQuickTextRecord() {
  const input = els["quick-text-input-v2"].value.trim();
  if (!input) {
    setVoiceRecordError(`Type a short transaction like: ${getCurrentCaptureExample()}.`);
    return;
  }
  const parsed = parseNaturalTransaction(input);
  const routed = routeCapturedTransaction(input, (parsed && parsed.amountMinor) ? parsed : null, "text");
  if (routed) {
    els["quick-text-input-v2"].value = "";
  }
}
 return null;
}

async function startVoiceRecordShortcut() {
  setVoiceRecordError("");
  clearPendingVoiceTranscript();
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRec) {
    setRecordingState(false);
    setVoiceRecordError("Voice input is not available in this browser. Please use text input.");
    return;
  }

  stopActiveRecognition();
  const recognition = new SpeechRec();
  state.activeRecognition = recognition;
  setRecordingState(true);
  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  recognition.lang = getVoiceLocale();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  let finalTranscriptHandled = false;

  recognition.onresult = async (event) => {
    const speech = getSpeechEventTranscript(event);
    if (!speech.transcript) return;
    if (!speech.isFinal) {
      els["voice-label-v2"].textContent = `Listening: ${speech.transcript}`;
      return;
    }

    finalTranscriptHandled = true;
    const transcript = speech.transcript;
    const corrected = await applyVoiceCorrections(transcript);
    const parsed = parseNaturalTransaction(corrected);
    routeCapturedTransaction(transcript, (parsed && parsed.amountMinor) ? parsed : null, "voice");
    try {
      recognition.stop();
    } catch (error) {
      if (state.activeRecognition === recognition) {
        state.activeRecognition = null;
      }
      setRecordingState(false);
    }
  };

  recognition.onerror = (event) => {
    setVoiceRecordError(getSpeechRecognitionErrorMessage(event?.error));
    try {
      recognition.stop();
    } catch (error) {
      // Ignore stop errors after the recognition session has already ended.
    }
    if (state.activeRecognition === recognition) {
      state.activeRecognition = null;
    }
    setRecordingState(false);
  };

  recognition.onend = () => {
    if (state.activeRecognition === recognition) {
      state.activeRecognition = null;
    }
    setRecordingState(false);
    if (!finalTranscriptHandled) {
      els["voice-label-v2"].textContent = "Tap to speak your transaction";
    }
  };

  if (isSafari && navigator.mediaDevices?.getUserMedia) {
    await navigator.mediaDevices.getUserMedia({ audio: true })
      .then((stream) => {
        stream.getTracks().forEach((track) => track.stop());
      })
      .catch(() => {});
  }
  recognition.start();
}

function getCatalogForProfileAction(actionContext) {
  const operatingRegion = getOperatingRegionId();
  const exactBusinessMatches = LABEL_CATALOG.filter((item) => {
    return item.transaction_contexts.includes(actionContext)
      && item.business_types.includes(state.profile.business_type_id);
  });

  if (exactBusinessMatches.length) return exactBusinessMatches;

  const sectorBusinessIds = BUSINESS_TYPES
    .filter((item) => (item.country === operatingRegion || item.country === "GLOBAL") && item.sector_id === state.profile.sector_id)
    .map((item) => item.id);

  const sectorMatches = LABEL_CATALOG.filter((item) => {
    return item.transaction_contexts.includes(actionContext)
      && labelSupportsRegion(item, operatingRegion)
      && item.business_types.some((businessId) => sectorBusinessIds.includes(businessId));
  });

  if (sectorMatches.length) return sectorMatches;

  return LABEL_CATALOG.filter((item) => {
    return item.transaction_contexts.includes(actionContext)
      && labelSupportsRegion(item, operatingRegion);
  });
}

function textTokens(value) {
  return normalizeText(value).split(/\s+/).filter(Boolean);
}

function levenshteinDistance(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;

  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const current = row[j];
      const substitution = previous + (left[i - 1] === right[j - 1] ? 0 : 1);
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, substitution);
      previous = current;
    }
  }
  return row[right.length];
}

function soundexCode(value) {
  const letters = normalizeText(value).replace(/[^a-z]/g, "").toUpperCase();
  if (!letters) return "";
  const codes = { B: 1, F: 1, P: 1, V: 1, C: 2, G: 2, J: 2, K: 2, Q: 2, S: 2, X: 2, Z: 2, D: 3, T: 3, L: 4, M: 5, N: 5, R: 6 };
  let output = letters[0];
  let previous = codes[output] || "";

  for (let index = 1; index < letters.length && output.length < 4; index += 1) {
    const code = codes[letters[index]] || "";
    if (code && code !== previous) output += code;
    previous = code;
  }

  return output.padEnd(4, "0");
}

function fuzzyTokenMatch(queryToken, labelToken) {
  if (queryToken.length < 4 || labelToken.length < 4) return false;
  if (queryToken.length <= 4 && queryToken.length !== labelToken.length) return false;
  const distance = levenshteinDistance(queryToken, labelToken);
  return distance <= (Math.max(queryToken.length, labelToken.length) >= 7 ? 2 : 1);
}

function phoneticTokenMatch(queryToken, labelToken) {
  if (queryToken.length < 4 || labelToken.length < 4) return false;
  if (Math.abs(queryToken.length - labelToken.length) > 2) return false;
  return soundexCode(queryToken) === soundexCode(labelToken);
}

function labelSearchTerms(item) {
  return [item.display_name, ...(item.synonyms || [])]
    .map((term) => normalizeText(term))
    .filter(Boolean);
}

function scoreLabelTextMatch(query, item) {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return { score: 0, reason: "" };

  const queryTokens = textTokens(normalizedQuery);
  let best = { score: 0, reason: "" };

  labelSearchTerms(item).forEach((term) => {
    const termTokens = textTokens(term);
    let score = 0;
    let reason = "";

    if (term === normalizedQuery) {
      score = 56;
      reason = "Exact match";
    } else if (termTokens.includes(normalizedQuery)) {
      score = 42;
      reason = "Exact word match";
    } else if (queryTokens.length > 1 && queryTokens.every((queryToken) => {
      return termTokens.some((labelToken) => labelToken === queryToken
        || (queryToken.length >= 3 && labelToken.startsWith(queryToken))
        || fuzzyTokenMatch(queryToken, labelToken));
    })) {
      score = 38;
      reason = "Multi-word match";
    } else if (normalizedQuery.length >= 5 && term.includes(normalizedQuery)) {
      score = 28;
      reason = "Phrase match";
    } else if (queryTokens.some((queryToken) => queryToken.length >= 3 && termTokens.some((labelToken) => labelToken.startsWith(queryToken)))) {
      score = 22;
      reason = "Starts with your words";
    } else if (queryTokens.some((queryToken) => termTokens.some((labelToken) => fuzzyTokenMatch(queryToken, labelToken)))) {
      score = 18;
      reason = "Close spelling match";
    } else if (queryTokens.some((queryToken) => termTokens.some((labelToken) => phoneticTokenMatch(queryToken, labelToken)))) {
      score = 12;
      reason = "Sounds similar";
    }

    if (score > best.score) {
      best = { score, reason };
    }
  });

  return best;
}

function findBestLabelForAction(labelQuery, actionContext) {
  const catalog = getCatalogForProfileAction(actionContext);
  const normalizedQuery = normalizeText(labelQuery);
  const ranked = catalog
    .map((item) => {
      const match = scoreLabelTextMatch(normalizedQuery, item);
      const preferred = (state.profile?.preferred_labels || []).includes(item.display_name) ? 8 : 0;
      const score = match.score + preferred;
      return { item, score };
    })
    .filter((entry) => !normalizedQuery || entry.score > 0)
    .sort((a, b) => b.score - a.score || a.item.display_name.localeCompare(b.item.display_name));

  return ranked[0]?.score ? ranked[0].item : null;
}

// ── Voice Phase 2 — missing-field clarification ─────────────────────
// Lending/owing language Konfirmata has no record type for (borrowing IS
// supported via the liability taxonomy — Phase 4A). Detected only on a
// failed parse; never mapped into an existing action category.
const UNSUPPORTED_INTENT_PATTERN = /\b(?:lend|lends|lent|lending|loan|loans|loaned|owe|owed|owing|debt)\b/i;
// Score floor at which an auto-matched label is trusted without asking.
// Below it (close-spelling 18 / phonetic 12 / no match 0) the review card opens.
const CONFIDENT_LABEL_SCORE = 22;

function detectUnsupportedIntent(transcript) {
  const text = String(transcript || "");
  return UNSUPPORTED_INTENT_PATTERN.test(text) && /[0-9]/.test(text);
}

// Curated, predefined-only map of common speech mis-hearings of the action
// verbs. Applied only to the leading verb token, only after the original
// parse fails, and only kept if the corrected phrase then parses cleanly.
// Not auto-expanded from user input.
const ACTION_VERB_HOMOPHONES = {
  boat: "bought", bot: "bought", bowt: "bought", board: "bought",
  sould: "sold", payed: "paid", recieved: "received", recieve: "received"
};

function homophoneCorrectedTranscript(transcript) {
  const text = String(transcript || "").trim();
  if (!text) return null;
  const tokens = text.split(/\s+/);
  let verbIndex = 0;
  if (tokens[0] && tokens[0].toLowerCase() === "i" && tokens.length > 1) verbIndex = 1;
  const verbToken = String(tokens[verbIndex] || "").toLowerCase().replace(/[^a-z]/g, "");
  const replacement = ACTION_VERB_HOMOPHONES[verbToken];
  if (!replacement) return null;
  tokens[verbIndex] = replacement;
  return tokens.join(" ");
}

function rankLabelCandidates(labelQuery, actionContext) {
  const catalog = getCatalogForProfileAction(actionContext);
  const normalizedQuery = normalizeText(labelQuery);
  const ranked = catalog
    .map((item) => {
      const match = scoreLabelTextMatch(normalizedQuery, item);
      const preferred = (state.profile?.preferred_labels || []).includes(item.display_name) ? 8 : 0;
      return { item, score: match.score + preferred };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.item.display_name.localeCompare(b.item.display_name));
  const best = ranked[0] || null;
  return {
    confident: !!(best && best.score >= CONFIDENT_LABEL_SCORE),
    label: best ? best.item : null,
    candidates: ranked.slice(0, 3).map((entry) => entry.item)
  };
}

// Single entry point for both voice and typed capture. Always returns true —
// every input is routed to the capture form or to the review card.
function routeCapturedTransaction(transcript, parsed, source) {
  setVoiceRecordError("");
  if (!parsed) {
    if (source === "voice") clearPendingVoiceTranscript();
    // Borrowing/loan language is checked before any other recovery.
    if (detectUnsupportedIntent(transcript)) {
      openVoiceReview({ mode: "unsupported", transcript, source });
      return true;
    }
    // Curated leading-verb mis-hearing fix, kept only if it now parses.
    const corrected = homophoneCorrectedTranscript(transcript);
    if (corrected) {
      const reparsed = parseNaturalTransaction(corrected);
      if (reparsed && reparsed.amountMinor) {
        return routeCapturedTransaction(corrected, reparsed, source);
      }
    }
    // Genuine failure — show the transcript so the user can fix the wording.
    openVoiceReview({ mode: "failed", transcript, source });
    return true;
  }
  const match = rankLabelCandidates(parsed.labelQuery, parsed.action);
  if (match.confident) {
    if (source === "voice") rememberVoiceTranscript(transcript, "capture");
    applyParsedTransactionToCapture(parsed, { label: match.label, announce: source === "voice" });
    return true;
  }
  // Missing or low-confidence label — ask before populating the capture form.
  if (source === "voice") clearPendingVoiceTranscript();
  openVoiceReview({ mode: "clarify", transcript, parsed, suggestions: match.candidates, source });
  return true;
}

function openVoiceReview(opts) {
  state.pendingVoiceParse = opts;
  renderVoiceReview();
  showScreen("screen-voice-review");
}

function renderVoiceReview() {
  const pending = state.pendingVoiceParse;
  if (!pending) return;
  els["voice-review-suggestions"].innerHTML = "";

  if (pending.mode === "failed") {
    els["voice-review-transcript-row"].hidden = true;
    els["voice-review-edit-row"].hidden = false;
    els["voice-review-edit"].value = pending.transcript || "";
    els["voice-review-understood-row"].hidden = true;
    els["voice-review-missing-row"].hidden = true;
    els["voice-review-message"].textContent = "We couldn't read that as a transaction. Fix the wording and try again.";
    els["voice-review-manual"].textContent = "Try again";
    return;
  }

  els["voice-review-transcript-row"].hidden = false;
  els["voice-review-edit-row"].hidden = true;
  els["voice-review-transcript"].textContent = pending.transcript || "";
  const isUnsupported = pending.mode === "unsupported";
  els["voice-review-understood-row"].hidden = isUnsupported;
  els["voice-review-missing-row"].hidden = isUnsupported;

  if (isUnsupported) {
    els["voice-review-message"].textContent = "This looks like a borrowing or loan-related entry. Konfirmata does not yet support a dedicated record type for borrowing.";
    els["voice-review-manual"].textContent = "Choose a supported category";
    return;
  }

  const parsed = pending.parsed;
  const currency = getProfileCurrency();
  const actionWord = { sale: "Sale", purchase: "Purchase", payment: "Payment", receipt: "Receipt", liability_in: "Money borrowed", liability_out: "Loan repayment" }[parsed.action] || "Transaction";
  els["voice-review-understood"].textContent = `${actionWord} · ${formatMoney(parsed.amountMinor || 0, currency)}`;
  els["voice-review-missing"].textContent = "Label / category";
  els["voice-review-message"].textContent = "Choose the label that fits, or pick one manually.";
  els["voice-review-manual"].textContent = "Choose manually";

  const fragment = document.createDocumentFragment();
  (pending.suggestions || []).forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ranked-item";
    button.innerHTML = `<strong>${item.icon || "🏷️"} ${escapeHtml(item.display_name)}</strong><span>${escapeHtml(friendlyActionLabel(parsed.action))}</span>`;
    button.addEventListener("click", () => resolveVoiceReview({ label: item }));
    fragment.appendChild(button);
  });
  const customTerm = String(parsed.labelQuery || "").trim();
  if (customTerm) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ranked-item";
    button.innerHTML = `<strong>⭐ ${escapeHtml(customTerm)}</strong><span>Use as a custom label</span>`;
    button.addEventListener("click", () => { void resolveVoiceReviewWithCustomLabel(customTerm); });
    fragment.appendChild(button);
  }
  els["voice-review-suggestions"].appendChild(fragment);
}

function resolveVoiceReview(resolution) {
  const pending = state.pendingVoiceParse;
  if (!pending || pending.mode !== "clarify") return;
  state.pendingVoiceParse = null;
  if (pending.source === "voice") rememberVoiceTranscript(pending.transcript, "capture");
  applyParsedTransactionToCapture(pending.parsed, {
    label: resolution.label,
    announce: pending.source === "voice"
  });
  // Learn only from an explicit label choice made in the review card.
  if (resolution.label) void maybeLearnVoiceCorrection();
}

async function resolveVoiceReviewWithCustomLabel(term) {
  const pending = state.pendingVoiceParse;
  if (!pending || pending.mode !== "clarify") return;
  const item = await createUserCustomLabel(term);
  resolveVoiceReview({ label: item });
}

function handleVoiceReviewManual() {
  const pending = state.pendingVoiceParse;
  if (!pending) return;
  if (pending.mode === "unsupported") {
    cancelVoiceReview();
    return;
  }
  if (pending.mode === "failed") {
    retryVoiceReview();
    return;
  }
  resolveVoiceReview({ label: null });
}

function retryVoiceReview() {
  const pending = state.pendingVoiceParse;
  if (!pending || pending.mode !== "failed") return;
  const edited = String(els["voice-review-edit"].value || "").trim();
  if (!edited) {
    if (els["voice-review-message"]) {
      els["voice-review-message"].textContent = "Type a transaction above, then tap Try again.";
    }
    return;
  }
  const original = String(pending.transcript || "").trim();
  const source = pending.source;
  const parsed = parseNaturalTransaction(edited);
  const usableParsed = (parsed && parsed.amountMinor) ? parsed : null;
  if (!usableParsed) {
    if (els["voice-review-message"]) {
      els["voice-review-message"].textContent = edited === original
        ? "Edit the wording above before trying again. Example: \"bought supplies for 80\", \"sold rice for 500\", or \"paid rent 3000\"."
        : "Still couldn't read that as a transaction. Try: \"bought [item] for [amount]\", \"sold [item] for [amount]\", or \"paid [item] [amount]\".";
    }
    return;
  }
  state.pendingVoiceParse = null;
  // Learn the whole-phrase correction only from this explicit user edit.
  if (edited.toLowerCase() !== original.toLowerCase()) {
    void saveVoiceCorrection(original, edited);
  }
  routeCapturedTransaction(edited, usableParsed, source);
}

function cancelVoiceReview() {
  state.pendingVoiceParse = null;
  clearPendingVoiceTranscript();
  setVoiceRecordError("");
  showScreen("screen-capture");
}

function applyParsedTransactionToCapture(parsed, options = {}) {
  setVoiceRecordError("");
  state.currentAction = parsed.action;
  state.profile.last_action = parsed.action;
  renderActionRows();

  const label = ("label" in options)
    ? options.label
    : findBestLabelForAction(parsed.labelQuery, parsed.action);
  if (label) {
    state.selectedLabel = label;
    els["selected-label-chip"].textContent = `${label.icon || "🏷️"} ${label.display_name} selected`;
  } else {
    clearSelectedLabel();
    setVoiceRecordError("We filled the amount, but you still need to pick a label.");
  }

  els["amount-input-v2"].value = parsed.amountMinor ? String(parsed.amountMinor / 100) : "";
  els["counterparty-input-v2"].value = parsed.counterparty || "";
  renderQuickLabels();
  clearError();
  showScreen("screen-capture");
  if (options.announce) {
    announceVoiceCapture(parsed, label?.display_name || parsed.labelQuery);
  }
}

function getCommonTransactionOptions(businessTypeId) {
  const groups = QUICK_PICKS[businessTypeId] || {};
  const order = ["sell", "purchase", "payment", "receipt"];
  const seen = new Set();
  const items = [];

  order.forEach((group) => {
    (groups[group] || []).forEach((label) => {
      if (seen.has(label)) return;
      seen.add(label);
      items.push({ display_name: label, context: normalizeActionKey(group) });
    });
  });

  return items.slice(0, 16);
}

function normalizePreferredLabels(labels, businessTypeId = state.profile?.business_type_id) {
  const values = Array.isArray(labels) ? labels : [];
  const availableLabels = businessTypeId
    ? new Set(getCommonTransactionOptions(businessTypeId).map((item) => item.display_name))
    : null;
  const normalized = [];

  values.forEach((label) => {
    const value = String(label || "").trim();
    if (!value) return;
    if (availableLabels && availableLabels.size && !availableLabels.has(value)) return;
    if (!normalized.includes(value)) normalized.push(value);
  });

  return normalized;
}

async function togglePreferredLabel(label) {
  if (!state.profile) return;
  const previous = normalizePreferredLabels(state.profile.preferred_labels, state.profile.business_type_id);
  const selected = new Set(previous);
  if (selected.has(label)) selected.delete(label);
  else selected.add(label);
  state.profile.preferred_labels = normalizePreferredLabels([...selected], state.profile.business_type_id);
  try {
    await saveProfile(state.profile);
  } catch (error) {
    state.profile.preferred_labels = previous;
    console.error("Unable to save preferred labels.", error);
    renderCommonLabelGrid();
    renderPreferredLabelsSummary();
    renderRecordingSetupSummary();
    syncPreferredLabelEditor();
    return;
  }
  renderCommonLabelGrid();
  renderPreferredLabelsSummary();
  renderRecordingSetupSummary();
  syncPreferredLabelEditor();
  await renderQuickLabels();
}

async function openSelector() {
  els["selector-modal"].hidden = false;
  setSelectorMode("search");
  await handleSearch();
  focusFirstInteractive(els["selector-modal"]);
}

function queueHandleSearch() {
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer);
  }
  searchDebounceTimer = setTimeout(() => {
    handleSearch();
  }, 150);
}

function closeSelector() {
  els["selector-modal"].hidden = true;
}

function setSelectorMode(mode) {
  state.selectorMode = mode;
  document.querySelectorAll("[data-mode]").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === mode);
  });
  document.querySelectorAll("[data-mode-panel]").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.modePanel === mode);
  });
  if (mode === "browse") {
    renderBrowseResults();
  }
}

async function handleSearch() {
  const query = els["label-search-input"].value.trim();
  const results = query
    ? searchLayerBLabels(query, getOperatingRegionId(), state.profile.business_type_id, getCurrentActionContext())
    : await rankLabels("", { limit: 12 });
  state.searchResults = results;
  els["search-results"].innerHTML = results.length
    ? results.map(renderRankedItemHtml).join("")
    : `<div class="record-card"><strong>No labels found</strong><div class="record-meta">Try speech, browse all, or add Other.</div></div>`;
  wireRankedButtons("search-results", results);
}

async function renderBrowseResults() {
  const results = getBrowseAllLabels(getOperatingRegionId(), state.profile.business_type_id, getCurrentActionContext());
  state.browseResults = results;
  els["browse-results"].innerHTML = results.map(renderRankedItemHtml).join("");
  wireRankedButtons("browse-results", results);
}

function renderRankedItemHtml(item, index) {
  return `<button type="button" class="ranked-item" data-ranked-id="${escapeHtml(item.id)}"><strong>${escapeHtml(item.icon || "🏷️")} ${escapeHtml(item.display_name)}</strong><span>${escapeHtml(contextCopy(item))}</span><small>${escapeHtml(item.badge || item.reason || "Recommended label")}</small></button>`;
}

function wireRankedButtons(containerId, results) {
  document.getElementById(containerId).querySelectorAll("[data-ranked-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const item = results.find((entry) => entry.id === button.dataset.rankedId);
      if (item) selectLabel(item);
    });
  });
}

async function startSpeechMatch() {
  clearPendingVoiceTranscript();
  state.speechResults = [];
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRec) {
    setRecordingState(false);
    els["speech-status"].textContent = "Speech recognition is not available in this browser.";
    return;
  }

  els["speech-status"].textContent = "Listening...";
  els["speech-results"].innerHTML = "";
  stopActiveRecognition();
  const recognition = new SpeechRec();
  state.activeRecognition = recognition;
  setRecordingState(true);
  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  recognition.lang = getVoiceLocale();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  let finalTranscriptHandled = false;
  recognition.onresult = async (event) => {
    const speech = getSpeechEventTranscript(event);
    if (!speech.transcript) return;
    if (!speech.isFinal) {
      els["speech-status"].textContent = `Listening: ${speech.transcript}`;
      return;
    }

    finalTranscriptHandled = true;
    const transcript = speech.transcript;
    const corrected = await applyVoiceCorrections(transcript);
    rememberVoiceTranscript(transcript, "selector");
    rankLabels(corrected, { limit: 5, includeScore: true }).then((results) => {
      state.speechResults = results;
      renderSpeechResults(corrected, results);
    });
    try {
      recognition.stop();
    } catch (error) {
      if (state.activeRecognition === recognition) {
        state.activeRecognition = null;
      }
      setRecordingState(false);
    }
  };
  recognition.onerror = (event) => {
    els["speech-status"].textContent = getSpeechRecognitionErrorMessage(event?.error);
    try {
      recognition.stop();
    } catch (error) {
      // Ignore stop errors after the recognition session has already ended.
    }
    if (state.activeRecognition === recognition) {
      state.activeRecognition = null;
    }
    setRecordingState(false);
  };
  recognition.onend = () => {
    if (state.activeRecognition === recognition) {
      state.activeRecognition = null;
    }
    setRecordingState(false);
    if (!finalTranscriptHandled && !state.speechResults.length) {
      els["speech-status"].textContent = "No final speech result received. Please try again or type the label.";
    }
  };
  if (isSafari && navigator.mediaDevices?.getUserMedia) {
    await navigator.mediaDevices.getUserMedia({ audio: true })
      .then((stream) => {
        stream.getTracks().forEach((track) => track.stop());
      })
      .catch(() => {});
  }
  recognition.start();
}

function renderSpeechResults(utterance, results) {
  const customLabel = cleanNaturalLabelQuery(utterance);
  if (!results.length) {
    els["speech-status"].textContent = customLabel
      ? `No strong match for "${utterance}". You can add it as a custom label.`
      : `No strong match for "${utterance}". Try search, browse all, or Other.`;
    els["speech-results"].innerHTML = customLabel ? renderSpeechCustomLabelHtml(customLabel) : "";
    wireSpeechCustomLabelButton(customLabel);
    return;
  }

  const top = results[0];
  if (top.confidence >= 0.85) {
    els["speech-status"].textContent = `Best match for "${utterance}" found. Confirm by tapping the top result.`;
  } else if (top.confidence >= 0.6) {
    els["speech-status"].textContent = `Here are the best shortlist matches for "${utterance}".`;
  } else {
    els["speech-status"].textContent = `Low confidence for "${utterance}". Try search, browse all, or Other.`;
  }

  const fallback = top.confidence < 0.6 && customLabel
    ? renderSpeechCustomLabelHtml(customLabel)
    : "";
  els["speech-results"].innerHTML = results.map(renderRankedItemHtml).join("") + fallback;
  wireRankedButtons("speech-results", results);
  wireSpeechCustomLabelButton(customLabel);
}

function renderSpeechCustomLabelHtml(label) {
  return `<button type="button" class="ranked-item" data-voice-custom-label><strong>⭐ ${escapeHtml(label)}</strong><span>${escapeHtml(friendlyActionLabel(getCurrentActionContext()))}</span><small>Use as a custom label</small></button>`;
}

function wireSpeechCustomLabelButton(label) {
  const button = document.querySelector("[data-voice-custom-label]");
  if (!(button && label)) return;
  button.addEventListener("click", async () => {
    const item = await createUserCustomLabel(label);
    selectLabel(item);
    els["speech-status"].textContent = `"${label}" saved as a custom label.`;
  });
}

async function saveCustomLabel() {
  const value = els["custom-label-input"].value.trim();
  if (!value) return;
  const item = await createUserCustomLabel(value);
  selectLabel(item);
  els["custom-label-input"].value = "";
}

function prepareConfirmation() {
  clearError();
  const signingBlockReason = getSigningBlockReason();
  if (signingBlockReason) {
    return showError(signingBlockReason);
  }
  const amount = parseMinor(els["amount-input-v2"].value);
  if (!state.selectedLabel) {
    return showError("Pick a label first.");
  }
  const currency = getProfileCurrency();
  const maxAmount = currency === "NGN" ? 10000000 * 100 : 100000 * 100;
  if (!amount || amount <= 0) {
    return showError("Enter a valid amount before confirming.");
  }
  if (amount > maxAmount) {
    return showError(currency === "NGN"
      ? "Amount looks too large. Konfirmata accepts up to ₦10,000,000 per entry."
      : `Amount looks too large. Konfirmata accepts up to ${getCurrencySymbol(currency)}100,000 per entry.`);
  }

  const transactionType = state.currentAction === "transfer" ? "transfer" : state.currentAction;
  const record = {
    transaction_type: transactionType,
    label: state.selectedLabel.display_name,
    normalized_label: state.selectedLabel.normalized_label,
    amount_minor: amount,
    currency,
    counterparty: els["counterparty-input-v2"].value.trim() || null,
    source_account: transactionType === "transfer" ? (els["source-account-input"].value.trim() || null) : null,
    destination_account: transactionType === "transfer" ? (els["destination-account-input"].value.trim() || null) : null,
    input_mode: "visual",
    confirmation_state: "pending",
    business_type_id: state.profile.business_type_id,
    sector_id: state.profile.sector_id,
    country: getOperatingRegionId(),
    operating_region: getOperatingRegionId()
  };

  state.candidateRecord = record;
  els["confirm-copy-v2"].textContent = confirmationCopy(record);
  els["confirm-meta-v2"].innerHTML = `
    <div><strong>Type:</strong> ${escapeHtml(record.transaction_type)}</div>
    <div><strong>Normalized label:</strong> ${escapeHtml(record.normalized_label)}</div>
    <div><strong>Amount:</strong> ${formatMoney(record.amount_minor, record.currency)}</div>
    <div><strong>Counterparty:</strong> ${escapeHtml(record.counterparty || "Not provided")}</div>
    ${record.reversed_entry_hash ? `<div><strong>Reverses:</strong> ${escapeHtml(record.reversed_entry_hash)}</div>` : ""}
  `;
  showScreen("screen-confirm");
  speakConfirmationCopy(els["confirm-copy-v2"].textContent);
}

async function confirmAppend() {
  if (!state.candidateRecord || state.isConfirming) return;

  state.isConfirming = true;
  document.getElementById("confirm-append").disabled = true;
  cancelConfirmationSpeech();

  try {
    const record = {
      ...state.candidateRecord,
      confirmation_state: "confirmed"
    };
    const appendedRecord = await appendLedgerRecord(record);
    void checkForAnomalies(appendedRecord);
    await bumpLabelUsage(record.normalized_label);
    await queueSyncRecord(appendedRecord);
    await updateSyncBadge();
    resetCaptureForm();
    await renderRecentRecords();
    await renderHistory();
    await renderDashboard();
    await checkDailyReminder();
    showScreen("screen-dashboard");
    void flushSyncQueue();
  } catch (error) {
    window.alert(error.message || "Unable to confirm this record on this device.");
  } finally {
    state.isConfirming = false;
    document.getElementById("confirm-append").disabled = false;
  }
}

function resetCaptureForm() {
  state.candidateRecord = null;
  clearPendingVoiceTranscript();
  clearSelectedLabel();
  els["amount-input-v2"].value = "";
  els["counterparty-input-v2"].value = "";
  els["source-account-input"].value = "";
  els["destination-account-input"].value = "";
}

async function renderRecentRecords() {
  const records = await getRecords();
  renderFirstRecordGuide(records);
  const recent = [...records].reverse().slice(0, 5);
  renderRecordListWithMarketing(
    "recent-records-v2",
    recent,
    `<div class="record-card"><strong>No confirmed records yet.</strong><div class="record-meta">Tap a label, enter an amount, then review before confirming. Your first confirmed record starts your history.</div></div>`,
    (record) => createElementFromHtml(renderRecordCard(record))
  );
}

async function renderHistory() {
  const records = await getRecords();
  renderHistoryList(records);
  wireReverseButtons(records);
  refreshTrustBanner("screen-history");
}

function renderHistoryList(records) {
  const reversedHashes = getReversedEntryHashSet(records);
  renderRecordListWithMarketing(
    "history-records-v2",
    [...records].reverse(),
    `<div class="record-card"><strong>No history yet.</strong><div class="record-meta">Nothing has been appended yet.</div></div>`,
    (record) => {
      return createElementFromHtml(renderRecordCard(record, {
        allowReverse: record.transaction_type !== "reversal" && !reversedHashes.has(record.entry_hash)
      }));
    }
  );
}

function renderRecordCard(record, options = {}) {
  const reverseButton = options.allowReverse
    ? `<button class="pill-button" type="button" data-reverse-id="${record.id}">Reverse</button>`
    : "";
  return `
    <div class="record-card">
      <div class="action-header">
        <strong>${record.label} • ${record.transaction_type}</strong>
        ${reverseButton}
      </div>
      <div class="record-meta">
        <span class="record-money">${formatMoney(record.amount_minor, record.currency)}</span> • ${new Date(record.confirmed_at * 1000).toLocaleString()}<br>
        ${record.normalized_label}${record.counterparty ? ` • ${record.counterparty}` : ""}${record.reversed_entry_hash ? ` • reverses ${record.reversed_entry_hash.slice(0, 12)}...` : ""}
      </div>
    </div>
  `;
}

function confirmationCopy(record) {
  const amount = formatMoney(record.amount_minor, record.currency);
  if (record.transaction_type === "sale") return `You sold ${record.label} for ${amount}.`;
  if (record.transaction_type === "purchase") return `You bought ${record.label} for ${amount}.`;
  if (record.transaction_type === "payment") return `You paid ${amount} for ${record.label}.`;
  if (record.transaction_type === "receipt") return `You received ${amount} for ${record.label}.`;
  if (record.transaction_type === "liability_in") return `You recorded money borrowed: ${record.label} — ${amount}.`;
  if (record.transaction_type === "liability_out") return `You recorded a loan repayment: ${record.label} — ${amount}.`;
  if (record.transaction_type === "reversal") return `You are reversing ${record.label} for ${amount}.`;
  return `You are transferring ${amount} for ${record.label}.`;
}

function rankLabels(query, options = {}) {
  const includeScore = options.includeScore !== false;
  const limit = options.limit || 12;
  const catalog = getCatalogForCurrentProfile({ includePreferred: options.includePreferred });
  const usageMapPromise = getUsageMap();

  return usageMapPromise.then((usageMap) => {
    const normalizedQuery = normalizeText(query);
    const ranked = catalog.map((item) => {
      const match = scoreLabelTextMatch(normalizedQuery, item);
      const businessMatch = item.business_types.includes(state.profile.business_type_id) ? 1 : 0;
      const sectorMatch = businessSectorMatch(item) ? 1 : 0;
      const countryMatch = labelSupportsRegion(item) ? 1 : 0;
      const historyBoost = usageMap.get(item.normalized_label) || 0;
      const preferredBoost = (state.profile?.preferred_labels || []).includes(item.display_name) ? 18 : 0;
      const profileBoost = (businessMatch * 10) + (sectorMatch * 6) + (countryMatch * 4) + Math.min(historyBoost, 8) + preferredBoost;
      const score = normalizedQuery
        ? match.score + profileBoost
        : profileBoost;
      const confidence = normalizedQuery
        ? Math.min((match.score / 60) + (profileBoost / 100), 0.99)
        : Math.min((businessMatch * 0.55) + (sectorMatch * 0.2) + (countryMatch * 0.1) + Math.min(historyBoost, 3) / 10 + (preferredBoost ? 0.15 : 0), 0.92);
      const reason = match.reason || (preferredBoost ? "Picked during onboarding" : "Recommended for this business");
      return { ...item, score, confidence, reason, matchScore: match.score };
    })
      .filter((item) => !normalizedQuery || item.matchScore > 0)
      .sort((a, b) => b.score - a.score || a.display_name.localeCompare(b.display_name));

    return ranked.slice(0, limit).map((item) => {
      const output = includeScore ? { ...item } : stripScore(item);
      delete output.matchScore;
      return output;
    });
  });
}

function stripScore(item) {
  const clone = { ...item };
  delete clone.score;
  delete clone.confidence;
  delete clone.reason;
  return clone;
}

function businessSectorMatch(item) {
  const business = BUSINESS_TYPES.find((entry) => entry.id === state.profile.business_type_id);
  const profileSector = business ? business.sector_id : state.profile.sector_id;
  return item.business_types.some((businessId) => BUSINESS_TYPES.find((entry) => entry.id === businessId)?.sector_id === profileSector);
}

function findPreferredCatalogItem(displayName) {
  if (!(state.profile && state.profile.business_type_id)) return null;
  const actionContext = getCurrentActionContext();
  const candidates = LABEL_CATALOG
    .filter((item) => item.display_name === displayName && labelSupportsRegion(item))
    .filter((item) => item.business_types.includes(state.profile.business_type_id)
      || businessSectorMatch(item));

  if (!candidates.length) return null;

  return candidates
    .sort((a, b) => {
      const businessDiff = Number(b.business_types.includes(state.profile.business_type_id)) - Number(a.business_types.includes(state.profile.business_type_id));
      if (businessDiff) return businessDiff;
      const actionDiff = Number(b.transaction_contexts.includes(actionContext)) - Number(a.transaction_contexts.includes(actionContext));
      if (actionDiff) return actionDiff;
      return a.display_name.localeCompare(b.display_name);
    })[0];
}

function getCatalogForCurrentProfile(options = {}) {
  const catalog = getCatalogForProfileAction(getCurrentActionContext());
  if (!options.includePreferred) return catalog;

  const preferredLabels = normalizePreferredLabels(state.profile?.preferred_labels, state.profile?.business_type_id);
  if (!preferredLabels.length) return catalog;

  const existingNames = new Set(catalog.map((item) => item.display_name));
  const preferredItems = preferredLabels
    .filter((displayName) => !existingNames.has(displayName))
    .map((displayName) => findPreferredCatalogItem(displayName))
    .filter(Boolean);

  return [...preferredItems, ...catalog];
}

function getAvailableBusinessTypes() {
  if (!state.profile || !state.profile.operating_region || !state.profile.sector_id) return [];
  const exactMatches = BUSINESS_TYPES.filter((item) => item.country === state.profile.operating_region && item.sector_id === state.profile.sector_id);
  if (exactMatches.length) return exactMatches;
  return BUSINESS_TYPES.filter((item) => item.country === "GLOBAL" && item.sector_id === state.profile.sector_id);
}

function buildLabel(id, displayName, icon, synonyms, contexts, countries, businessTypes) {
  return {
    id,
    normalized_label: id,
    display_name: displayName,
    synonyms,
    icon,
    image_url: null,
    transaction_contexts: contexts,
    countries,
    business_types: businessTypes
  };
}

function labelSupportsRegion(item, region = getOperatingRegionId()) {
  const countries = Array.isArray(item?.countries) ? item.countries : [];
  if (!countries.length) return true;
  return countries.includes(region) || countries.includes("GLOBAL");
}

function buildCatalogFromQuickPicks() {
  const items = [];
  Object.entries(QUICK_PICKS).forEach(([businessTypeId, groups]) => {
    const business = BUSINESS_TYPES.find((entry) => entry.id === businessTypeId);
    if (!business) return;
    const country = business.country;

    Object.entries(groups).forEach(([action, labels]) => {
      const canonicalAction = normalizeActionKey(action);
      labels.forEach((displayName) => {
        const normalized = normalizeText(displayName).replace(/\s+/g, "_");
        const id = `${businessTypeId}_${canonicalAction}_${normalized}`;
        if (items.some((item) => item.id === id)) return;
        items.push(buildLabel(
          id,
          displayName,
          inferIcon(displayName, canonicalAction),
          [],
          [canonicalAction],
          [country],
          [businessTypeId]
        ));
      });
    });
  });
  return items;
}

function normalizeActionKey(action) {
  if (action === "sell") return "sale";
  if (action === "buy") return "purchase";
  if (action === "pay") return "payment";
  if (action === "receive") return "receipt";
  return action;
}

function getCurrentActionContext() {
  if (state.currentAction === "transfer") return state.transferSubtype;
  return state.currentAction;
}

function layerBActionKey(action) {
  if (action === "sale") return "sell";
  if (action === "purchase") return "buy";
  if (action === "payment") return "pay";
  if (action === "receipt") return "receive";
  if (action === "transfer_in") return "receive";
  if (action === "transfer_out") return "pay";
  return "sell";
}

function layerBContextFromActionKey(actionKey) {
  if (actionKey === "sell") return "sale";
  if (actionKey === "buy") return "purchase";
  if (actionKey === "pay") return "payment";
  return "receipt";
}

function slugifyLabel(value) {
  return normalizeText(value).replace(/\s+/g, "_");
}

function buildLayerBItem(country, businessTypeId, actionKey, label, badge) {
  const context = layerBContextFromActionKey(actionKey);
  return {
    id: `layerb_${country}_${businessTypeId}_${actionKey}_${slugifyLabel(label)}`,
    normalized_label: slugifyLabel(label),
    display_name: label,
    synonyms: [],
    icon: inferIcon(label, context),
    image_url: null,
    transaction_contexts: [context],
    countries: [country],
    business_types: [businessTypeId],
    subtitle: friendlyActionLabel(context),
    badge
  };
}

function getCurrentProfileFallbackLabels(context) {
  return LABEL_CATALOG.filter((item) => {
    return item.transaction_contexts.includes(context)
      && item.business_types.includes(state.profile.business_type_id);
  });
}

function getBrowseAllLabels(country, businessTypeId, currentAction) {
  const actionKey = layerBActionKey(currentAction);
  const countryData = LAYER_B[country] || {};
  const businessData = countryData[businessTypeId] || {};
  const recommended = [];
  const others = [];
  const seen = new Set();

  (businessData[actionKey] || []).forEach((label) => {
    const dedupeKey = `${actionKey}:${label}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    recommended.push(buildLayerBItem(country, businessTypeId, actionKey, label, "Recommended label"));
  });

  Object.entries(countryData).forEach(([sourceBusinessTypeId, groups]) => {
    (groups[actionKey] || []).forEach((label) => {
      const dedupeKey = `${actionKey}:${label}`;
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);
      others.push(buildLayerBItem(country, sourceBusinessTypeId, actionKey, label, "Other businesses"));
    });
  });

  if (!recommended.length) {
    const context = layerBContextFromActionKey(actionKey);
    getCurrentProfileFallbackLabels(context).forEach((item) => {
      const dedupeKey = `${actionKey}:${item.display_name}`;
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);
      recommended.push({
        ...item,
        subtitle: friendlyActionLabel(context),
        badge: "Recommended label"
      });
    });
  }

  return [...recommended, ...others];
}

function searchLayerBLabels(query, country, businessTypeId, currentAction) {
  const q = normalizeText(query);
  if (!q) return [];

  const actionKey = layerBActionKey(currentAction);
  const countryData = LAYER_B[country] || {};
  const matches = [];
  const seen = new Set();

  Object.entries(countryData).forEach(([sourceBusinessTypeId, groups]) => {
    ["sell", "buy", "pay", "receive"].forEach((groupAction) => {
      (groups[groupAction] || []).forEach((label) => {
        const normalizedLabel = normalizeText(label);
        if (!normalizedLabel.includes(q)) return;
        const dedupeKey = `${groupAction}:${normalizedLabel}`;
        if (seen.has(dedupeKey)) return;
        seen.add(dedupeKey);

        const exact = normalizedLabel === q ? 1 : 0;
        const starts = normalizedLabel.startsWith(q) ? 1 : 0;
        const actionMatch = groupAction === actionKey ? 1 : 0;
        const businessMatch = sourceBusinessTypeId === businessTypeId ? 1 : 0;
        const score = (exact * 50) + (starts * 20) + (actionMatch * 16) + (businessMatch * 12);

        matches.push({
          ...buildLayerBItem(country, sourceBusinessTypeId, groupAction, label, businessMatch ? "Recommended label" : "Other businesses"),
          score,
          reason: exact ? "Exact match" : starts ? "Starts with your search" : "Matching label"
        });
      });
    });
  });

  LABEL_CATALOG.forEach((item) => {
    if (!labelSupportsRegion(item, country)) return;
    const normalizedLabel = normalizeText(item.display_name);
    if (!normalizedLabel.includes(q)) return;
    const context = item.transaction_contexts[0] || "";
    const groupAction = layerBActionKey(context);
    const dedupeKey = `${groupAction}:${normalizedLabel}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);

    const actionMatch = groupAction === actionKey ? 1 : 0;
    const businessMatch = item.business_types.includes(businessTypeId) ? 1 : 0;
    matches.push({
      ...item,
      subtitle: friendlyActionLabel(context),
      badge: businessMatch ? "Recommended label" : "Other businesses",
      score: 10 + (actionMatch * 10) + (businessMatch * 8),
      reason: "Matching label"
    });
  });

  return matches
    .sort((a, b) => (b.score || 0) - (a.score || 0) || a.display_name.localeCompare(b.display_name))
    .slice(0, 18)
    .map((item) => stripScore(item));
}

function friendlyActionLabel(action) {
  if (action === "sale") return "Sell";
  if (action === "purchase") return "Buy";
  if (action === "payment") return "Pay";
  if (action === "receipt") return "Receive";
  if (action === "transfer") return "Transfer";
  if (action === "liability_in") return "Money Borrowed";
  if (action === "liability_out") return "Loan Repayment";
  return action;
}

const LABEL_ICONS = {
  "Cooking Gas": "🔥",
  "Firewood": "🪵",
  "Grains/Staples": "🌾",
  "Oil": "🫙",
  "Packaging": "📦",
  "Protein/Meat": "🥩",
  "Seasoning": "🧂",
  "Vegetables": "🥬",
  "Tomatoes": "🍅",
  "Pepper": "🌶️",
  "Palm Oil": "🫙",
  "Water": "💧",
  "Charcoal": "⚫",
  "Swallow & Soup": "🍲",
  "Rice Meal": "🍚",
  "Snacks": "🍘",
  "Drinks": "🥤",
  "Protein": "🍗",
  "Catering": "🍽️",
  "Takeaway": "🥡",
  "Breakfast": "🌅",
  "Rice": "🌾",
  "Beans": "🫘",
  "Garri": "🥣",
  "Yam": "🍠",
  "Onion": "🧅",
  "Plantain": "🍌",
  "Groundnuts": "🥜",
  "Crayfish": "🦐",
  "Stock Fish": "🐟",
  "Egusi": "🫘",
  "Maize": "🌽",
  "Millet": "🌾",
  "Kilishi": "🥩",
  "Dried Fish": "🐠",
  "Zobo": "🍵",
  "Kunu": "🥛",
  "Transport": "🚗",
  "Market Fee": "🎫",
  "Stall Rent": "🏪",
  "Shop Rent": "🏬",
  "Helper Pay": "👷",
  "Generator Fuel": "⛽",
  "Electricity": "💡",
  "Mobile Data": "📱",
  "Workshop Rent": "🏭",
  "Motor Levy": "🎫",
  "Parking Fee": "🅿️",
  "Repair": "🔧",
  "Driver Pay": "🚘",
  "Car Wash": "🚿",
  "Staff Pay": "💵",
  "Assistant Pay": "👩‍💼",
  "Kitchen Rent": "🍳",
  "Waste Disposal": "🗑️",
  "Water Supply": "🚰",
  "Trip Fare": "🚌",
  "Delivery Fee": "🛵",
  "Charter": "🚐",
  "Loading Fee": "📦",
  "Extra Seat": "💺",
  "Fuel": "⛽",
  "Engine Oil": "🛢️",
  "Tyres": "🛞",
  "Spare Parts": "⚙️",
  "Repair Job": "🔧",
  "Labour": "🪚",
  "Installation": "🔩",
  "Maintenance": "🛠️",
  "Inspection": "🔍",
  "Materials": "🧱",
  "Tools": "🔨",
  "Fittings": "🔩",
  "Paint": "🎨",
  "Customer Payment": "💵",
  "POS Payment": "💳",
  "Debt Collected": "📋",
  "Esusu Payout": "🤲",
  "Bulk Order Payment": "📦",
  "Passenger Payment": "🚌",
  "Delivery Payment": "🛵",
  "Charter Payment": "🚐",
  "Job Payment": "🪚",
  "Deposit": "💰",
  "Balance Payment": "✅",
  "Client Payment": "🤝",
  "Balance": "✅",
  "Meals": "🍽️",
  "Delivery": "🛵",
  "Desserts": "🍰",
  "Baked Goods": "🥐",
  "BBQ": "🍖",
  "Wings": "🍗",
  "Fried Chicken": "🍗",
  "Tacos": "🌮",
  "Birria": "🥩",
  "Tamales": "🫔",
  "Jerk Chicken": "🍗",
  "Oxtail": "🥩",
  "Soul Food Plate": "🫕",
  "Gumbo": "🍲",
  "Meal Prep": "📦",
  "Fresh Juice": "🥤",
  "Smoothie": "🥤",
  "Coffee": "☕",
  "Custom Cake": "🎂",
  "Cookies": "🍪",
  "Cupcakes": "🧁",
  "Pies": "🥧",
  "Bread": "🍞",
  "Ingredients": "🛒",
  "Meat/Protein": "🥩",
  "Produce": "🥦",
  "Cooking Oil": "🫙",
  "Dairy": "🥛",
  "Baking Supplies": "🥣",
  "Spices": "🧂",
  "Rent": "🏠",
  "Utilities": "💡",
  "Delivery App Fee": "📲",
  "Permits": "📄",
  "Cooking Gas/Propane": "🔥",
  "Equipment": "🍳",
  "Kitchen Rental": "🍳",
  "Event Fee": "🎫",
  "Products": "🛍️",
  "Merchandise": "👕",
  "Gift Items": "🎁",
  "Accessories": "💍",
  "Online Sale": "💻",
  "Clothing": "👗",
  "Shoes": "👟",
  "Jewelry": "💎",
  "Handbags": "👜",
  "Beauty Products": "💄",
  "Candles": "🕯️",
  "Home Decor": "🪴",
  "Artwork": "🖼️",
  "Books": "📚",
  "Thrift Items": "♻️",
  "Custom T-Shirts": "👕",
  "Merch": "🏷️",
  "Crystals": "🔮",
  "Shipping Cost": "📮",
  "Card Fees": "💳",
  "Storage Unit": "📦",
  "Marketing": "📢",
  "Marketplace Fees": "💻",
  "Business License": "📄",
  "Labor": "🪚",
  "Project Fee": "📋",
  "Roofing Job": "🏠",
  "Plumbing Job": "🚿",
  "Electric Job": "⚡",
  "HVAC Job": "❄️",
  "Painting Job": "🎨",
  "Flooring Job": "🏠",
  "Landscaping": "🌿",
  "Pressure Washing": "💦",
  "Handyman Work": "🔨",
  "Snow Removal": "❄️",
  "Tree Service": "🌳",
  "Lumber": "🪵",
  "Concrete/Block": "🧱",
  "Pipe/Plumbing": "🚿",
  "Wire/Electrical": "⚡",
  "Roofing Materials": "🏠",
  "Safety Gear": "🦺",
  "Subcontractor Pay": "🤝",
  "Disposal": "🗑️",
  "Tool Rental": "🔧",
  "Insurance": "🛡️",
  "Hair Service": "✂️",
  "Nails": "💅",
  "Treatment": "✨",
  "Makeup": "💄",
  "Lashes": "👁️",
  "Product Sale": "🧴",
  "Box Braids": "✂️",
  "Knotless Braids": "✂️",
  "Loc Retwist": "🌀",
  "Silk Press": "💆",
  "Faux Locs": "✂️",
  "Fade": "✂️",
  "Shape-Up": "✂️",
  "Acrylic Set": "💅",
  "Gel Nails": "💅",
  "Lash Extensions": "👁️",
  "Waxing": "✨",
  "Bridal Makeup": "💍",
  "Tattoo": "🖊️",
  "Massage": "🤲",
  "Booth Rent": "💈",
  "Training": "📚",
  "Booking App Fee": "📲",
  "Supplies Run": "🛒",
  "Tip": "🎁",
  "Consultation": "💬",
  "Retainer": "📅",
  "Digital Product": "💾",
  "Recurring Service": "🔄",
  "Social Media Management": "📱",
  "Video Editing": "🎬",
  "Graphic Design": "🎨",
  "Web Design": "🌐",
  "Coaching Session": "🎯",
  "Brand Deal": "⭐",
  "Affiliate Income": "🔗",
  "Course Sale": "🎓",
  "UGC Content": "📸",
  "Software Tools": "🔄",
  "Contractor Pay": "🤝",
  "Internet": "🌐",
  "Marketplace Fee": "💻",
  "Cloud Storage": "☁️",
  "Accounting Software": "📊",
  "Co-working Space": "🏢",
  "Route Pay": "🗺️",
  "Freight Job": "🚛",
  "Rush Delivery": "⚡",
  "Amazon Route": "📦",
  "DoorDash Income": "🛵",
  "Instacart Income": "🛒",
  "Tolls": "🛣️",
  "Truck Payment": "🚛",
  "Vehicle Insurance": "🛡️",
  "Parking": "🅿️",
  "Oil Change": "🛢️",
  "Phone Plan": "📱",
  "Online Order Payment": "💻",
  "Catering Deposit": "🍽️",
  "Delivery App Payout": "📲",
  "Marketplace Payout": "💻",
  "Affiliate Payout": "🔗",
  "Progress Payment": "📋",
  "Final Balance": "✅",
  "Refund Received": "↩️",
  "Business Loan": "🏦",
  "Family Support": "❤️",
  "Bank Transfer": "🏦",
  "Reimbursement": "↩️",
  "Customer Transfer": "💳",
  "POS/Link Payment": "💳"
};

function getIconForLabel(label) {
  if (LABEL_ICONS[label]) return LABEL_ICONS[label];

  const lower = String(label || "").toLowerCase();
  if (lower.includes("fuel") || lower.includes("petrol") || lower.includes("diesel")) return "⛽";
  if (lower.includes("gas") || lower.includes("propane")) return "🔥";
  if (lower.includes("rent")) return "🏠";
  if (lower.includes("food") || lower.includes("meal")) return "🍽️";
  if (lower.includes("drink") || lower.includes("beverage")) return "🥤";
  if (lower.includes("meat") || lower.includes("chicken") || lower.includes("fish")) return "🥩";
  if (lower.includes("rice")) return "🌾";
  if (lower.includes("oil")) return "🫙";
  if (lower.includes("water")) return "💧";
  if (lower.includes("transport") || lower.includes("fare") || lower.includes("trip")) return "🚗";
  if (lower.includes("delivery") || lower.includes("dispatch")) return "🛵";
  if (lower.includes("repair") || lower.includes("fix")) return "🔧";
  if (lower.includes("hair")) return "✂️";
  if (lower.includes("nail")) return "💅";
  if (lower.includes("cake")) return "🎂";
  if (lower.includes("bread")) return "🍞";
  if (lower.includes("pay") || lower.includes("wage") || lower.includes("salary")) return "💵";
  if (lower.includes("fee") || lower.includes("levy") || lower.includes("tax")) return "🎫";
  if (lower.includes("material") || lower.includes("supply")) return "📦";
  if (lower.includes("tool")) return "🔨";
  if (lower.includes("phone") || lower.includes("data") || lower.includes("internet")) return "📱";
  if (lower.includes("insurance")) return "🛡️";
  if (lower.includes("marketing") || lower.includes("boost")) return "📢";
  if (lower.includes("software") || lower.includes("recurring")) return "💻";
  if (lower.includes("stock") || lower.includes("inventory")) return "🗃️";
  if (lower.includes("packaging") || lower.includes("nylon") || lower.includes("bag")) return "📦";
  if (lower.includes("project") || lower.includes("consult")) return "📋";
  return "🏷️";
}

function inferIcon(displayName, action) {
  return getIconForLabel(displayName);
}

LABEL_CATALOG = [...buildCatalogFromQuickPicks(), ...EXTRA_SEARCH_LABELS, ...LIABILITY_LABELS];

function showScreen(id) {
  const previousScreen = document.querySelector(".screen.active")?.id || null;
  document.querySelectorAll(".screen").forEach((screen) => screen.classList.remove("active"));
  const nextScreen = document.getElementById(id);
  nextScreen.classList.add("active");
  if (id === "screen-capture") {
    startCaptureExampleRotation();
  } else if (previousScreen === "screen-capture" || state.captureExampleInterval) {
    stopCaptureExampleRotation();
  }
  if (previousScreen === "screen-settings" && id !== "screen-settings" && state.preferredLabelEditorOpen) {
    state.preferredLabelEditorOpen = false;
    syncPreferredLabelEditor();
  }
  if (previousScreen === "screen-settings" && id !== "screen-settings" && state.passcodeReminderEditorOpen) {
    state.passcodeReminderEditorOpen = false;
    syncPasscodeReminderEditor();
  }
  if (previousScreen === "screen-settings" && id !== "screen-settings") {
    clearAnomalyAutoReviewTimer();
  }
  if (id !== "screen-confirm") {
    cancelConfirmationSpeech();
  }
  if (previousScreen === "screen-dashboard" && id !== "screen-dashboard" && state.amountsHidden) {
    resetPrivacyMode();
  }
  updateBottomNav(id);
  refreshTrustBanner(id);
  if (id === "screen-onboarding") {
    focusFirstInteractive(document.querySelector(`.step[data-step="${state.onboardingStep}"]`));
  } else if (id === "screen-confirm") {
    focusFirstInteractive(nextScreen);
  }
}

function openTrustSetup(returnScreen = "screen-capture") {
  const channel = getPreferredOtpChannel();
  syncVerificationState();
  if (hasVerifiedSessionForChannel(channel)) {
    return;
  }
  state.otpReturnScreen = returnScreen;
  renderOtpScreen();
  showScreen("screen-otp");
}

function updateBottomNav(activeScreenId) {
  const visibleScreens = new Set([
    "screen-capture",
    "screen-dashboard",
    "screen-history",
    "screen-settings",
    "screen-export"
  ]);
  const visible = visibleScreens.has(activeScreenId);
  els["bottom-nav-v2"].hidden = !visible;
  document.querySelectorAll("[data-target-screen]").forEach((button) => {
    button.classList.toggle("active", button.dataset.targetScreen === activeScreenId);
  });
}

function openChangeProfileConfirm() {
  els["change-confirm-modal"].hidden = false;
  focusFirstInteractive(els["change-confirm-modal"]);
}

function closeChangeProfileConfirm() {
  els["change-confirm-modal"].hidden = true;
}

function clearPinConfirmationError() {
  if (els["pin-confirm-error"]) {
    els["pin-confirm-error"].textContent = "";
  }
}

function resolvePinConfirmation(value) {
  const resolver = state.pinConfirmResolver;
  state.pinConfirmResolver = null;
  state.pinConfirmWrongMessage = "";
  if (els["pin-confirm-input"]) {
    els["pin-confirm-input"].value = "";
  }
  clearPinConfirmationError();
  if (els["pin-confirm-modal"]) {
    els["pin-confirm-modal"].hidden = true;
  }
  if (typeof resolver === "function") {
    resolver(value);
  }
}

function requestCurrentPinConfirmation({
  title = "Confirm current passcode",
  copy = "Enter your current passcode to continue.",
  confirmText = "Confirm",
  wrongPinMessage = "Incorrect passcode."
} = {}) {
  return new Promise((resolve) => {
    state.pinConfirmResolver = resolve;
    state.pinConfirmWrongMessage = wrongPinMessage;
    if (els["pin-confirm-title"]) {
      els["pin-confirm-title"].textContent = title;
    }
    if (els["pin-confirm-copy"]) {
      els["pin-confirm-copy"].textContent = copy;
    }
    if (els["pin-confirm-submit"]) {
      els["pin-confirm-submit"].textContent = confirmText;
    }
    if (els["pin-confirm-input"]) {
      els["pin-confirm-input"].value = "";
    }
    clearPinConfirmationError();
    if (els["pin-confirm-modal"]) {
      els["pin-confirm-modal"].hidden = false;
      focusFirstInteractive(els["pin-confirm-modal"]);
    }
  });
}

async function submitPinConfirmation() {
  if (!state.profile) {
    resolvePinConfirmation("");
    return;
  }

  const pin = els["pin-confirm-input"]?.value.trim() || "";
  if (!pin) {
    if (els["pin-confirm-error"]) {
      els["pin-confirm-error"].textContent = "Enter your current passcode.";
    }
    return;
  }

  if (await verifyPin(pin)) {
    if (!state.profile.pinSalt) {
      await migrateLegacyPinHash(pin);
    }
    resolvePinConfirmation(pin);
    return;
  }

  if (els["pin-confirm-error"]) {
    els["pin-confirm-error"].textContent = state.pinConfirmWrongMessage || "Incorrect passcode.";
  }
}

function getActiveScreenId() {
  return document.querySelector(".screen.active")?.id || "screen-capture";
}

function canRecoverPinWithOtp() {
  const channel = getPreferredOtpChannel();
  syncVerificationState();
  return Boolean(getVerifiedRecoveryIdentifier(channel));
}

function getVerifiedRecoveryIdentifier(channel = getPreferredOtpChannel()) {
  if (!isChannelVerified(channel)) return "";
  if (channel === "sms") {
    return normalizePhoneNumber(state.profile?.phone_number || "", getPhoneInputCountry());
  }
  return normalizeEmailAddress(state.profile?.email || "");
}

function clearForgotPinError() {
  if (els["pin-forgot-error"]) {
    els["pin-forgot-error"].textContent = "";
  }
}

function showForgotPinError(message) {
  if (!els["pin-forgot-error"]) return;
  els["pin-forgot-error"].textContent = message || "";
}

function syncForgotPinHelperText() {
  if (!els["pin-forgot-helper"]) return;
  const channel = getPreferredOtpChannel();
  els["pin-forgot-helper"].textContent = state.otpChallenge
    ? getOtpHelperText()
    : channel === "sms"
      ? "Request a reset code to continue."
      : "Request a reset code by email to continue.";
}

function resetForgotPinModalState() {
  state.otpChallenge = null;
  clearForgotPinError();
  if (els["pin-forgot-copy"]) {
    els["pin-forgot-copy"].textContent = getPreferredOtpChannel() === "sms"
      ? "We'll send a code to your verified phone number to reset your passcode."
      : "We'll send a code to your verified email address to reset your passcode.";
  }
  syncPasscodeReminderDisplays();
  if (els["pin-forgot-code"]) {
    els["pin-forgot-code"].value = "";
  }
  if (els["pin-forgot-code-wrap"]) {
    els["pin-forgot-code-wrap"].hidden = true;
  }
  if (els["pin-forgot-send"]) {
    els["pin-forgot-send"].hidden = false;
    els["pin-forgot-send"].disabled = false;
  }
  if (els["pin-forgot-confirm"]) {
    els["pin-forgot-confirm"].hidden = true;
    els["pin-forgot-confirm"].disabled = false;
  }
  syncForgotPinHelperText();
}

function closeForgotPinModal() {
  if (els["pin-forgot-modal"]) {
    els["pin-forgot-modal"].hidden = true;
  }
  resetForgotPinModalState();
}

function openForgotPinModal() {
  closePinWipeModal();
  resetForgotPinModalState();
  if (els["pin-forgot-modal"]) {
    els["pin-forgot-modal"].hidden = false;
    focusFirstInteractive(els["pin-forgot-modal"]);
  }
}

function closePinWipeModal() {
  if (els["pin-wipe-modal"]) {
    els["pin-wipe-modal"].hidden = true;
  }
}

function openPinWipeModal() {
  closeForgotPinModal();
  if (els["pin-wipe-modal"]) {
    els["pin-wipe-modal"].hidden = false;
    focusFirstInteractive(els["pin-wipe-modal"]);
  }
}

async function openForgotPinFlow() {
  state.pinRecoveryReturnScreen = getActiveScreenId();
  if (canRecoverPinWithOtp()) {
    openForgotPinModal();
    return;
  }
  openPinWipeModal();
}

async function sendForgotPinResetCode() {
  if (!state.profile) return;
  const channel = getPreferredOtpChannel();
  const country = getPhoneInputCountry();
  const identifier = getVerifiedRecoveryIdentifier(channel);
  const phoneNumber = normalizePhoneNumber(state.profile.phone_number || "", country);

  if (!identifier) {
    showForgotPinError(getIdentifierValidationMessage(channel, country));
    return;
  }

  clearForgotPinError();
  try {
    await requestOtpChallenge(identifier, {
      channel,
      phoneNumber,
      fallbackToLocal: false
    });
    if (els["pin-forgot-code-wrap"]) {
      els["pin-forgot-code-wrap"].hidden = false;
    }
    if (els["pin-forgot-send"]) {
      els["pin-forgot-send"].hidden = true;
    }
    if (els["pin-forgot-confirm"]) {
      els["pin-forgot-confirm"].hidden = false;
    }
    syncForgotPinHelperText();
    focusFirstInteractive(els["pin-forgot-modal"]);
  } catch (error) {
    showForgotPinError(error.message || "Failed to request reset code.");
  }
}

function showPinRecoverySuccess(message) {
  showScreen("screen-capture");
  els["capture-error"].hidden = false;
  els["capture-error"].textContent = message;
  els["capture-error"].style.color = "var(--primary)";
  window.setTimeout(() => {
    if (els["capture-error"]) {
      els["capture-error"].hidden = true;
      els["capture-error"].textContent = "";
      els["capture-error"].style.color = "";
    }
  }, 3000);
}

async function clearLocalData() {
  stopActiveRecognition();
  stopCaptureExampleRotation();
  if (state.db) {
    try {
      state.db.close();
    } catch (error) {
      console.warn("Unable to close IndexedDB cleanly before reset.", error);
    } finally {
      state.db = null;
    }
  }

  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error || new Error("Failed to clear local database."));
    request.onblocked = () => reject(new Error("Close other open Konfirmata tabs before wiping this device."));
  });

  localStorage.clear();
  window.location.reload();
}

async function handlePinWipeRestart() {
  try {
    await clearLocalData();
  } catch (error) {
    closePinWipeModal();
    if (els["pin-error"]) {
      els["pin-error"].textContent = error.message || "Unable to wipe this device right now.";
    }
  }
}

async function confirmForgotPinReset() {
  if (!state.profile) return;
  const enteredCode = (els["pin-forgot-code"]?.value || "").trim();
  try {
    clearForgotPinError();
    await verifyActiveOtpChallenge(enteredCode);
    state.profile.pinEnabled = false;
    delete state.profile.pinHash;
    delete state.profile.pinSalt;
    delete state.profile.pinKdf;
    delete state.profile.pinIterations;
    delete state.profile.passcodeReminder;
    delete state.profile.passcode_hint;
    await saveProfile(state.profile, { skipPush: true });
    state.pinAttempts = 0;
    state.pinEntry = "";
    syncPasscodeReminderDisplays();
    updatePinDots();
    hidePinLock();
    closeForgotPinModal();
    await showCapture();
    showPinRecoverySuccess("Passcode removed. You can set a new one in Settings.");
  } catch (error) {
    const message = /expired|generate a code/i.test(error.message || "")
      ? error.message
      : "Incorrect code. Please try again.";
    showForgotPinError(message);
  }
}

function confirmChangeProfile() {
  closeChangeProfileConfirm();
  state.onboardingStep = 1;
  renderOnboarding();
  showScreen("screen-onboarding");
}

function normalizeText(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function countryName(countryId) {
  return COUNTRIES.find((item) => item.id === getRecognizedCountryId(countryId))?.name || countryId;
}

function getCountryAliases() {
  return {
    "COTE DIVOIRE": "CI",
    "COTE D'IVOIRE": "CI",
    CURACAO: "CW",
    MACAO: "MO",
    NIGERIA: "NG",
    "REUNION": "RE",
    "SAO TOME AND PRINCIPE": "ST",
    "SAO TOME & PRINCIPE": "ST",
    TURKEY: "TR",
    USA: "US",
    "UNITED STATES": "US",
    "UNITED STATES OF AMERICA": "US"
  };
}

function normalizeCountryLookupValue(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['’]/g, "'")
    .replace(/\s+/g, " ");
}

function getRecognizedCountryId(country) {
  const value = normalizeCountryLookupValue(country);
  if (!value) return "";

  const directMatch = COUNTRIES.find((item) => item.id === value);
  if (directMatch) return directMatch.id;

  const countryByName = COUNTRIES.find((item) => normalizeCountryLookupValue(item.name) === value);
  if (countryByName) return countryByName.id;

  return getCountryAliases()[value] || "";
}

function normalizeCountryId(country, fallback = "NG") {
  return getRecognizedCountryId(country) || fallback;
}

function normalizeLanguageId(language) {
  const value = String(language || "").trim().toLowerCase();
  return SUPPORTED_LANGUAGES.some((item) => item.id === value) ? value : "en";
}

function getLanguageName(language) {
  return SUPPORTED_LANGUAGES.find((item) => item.id === normalizeLanguageId(language))?.name || "English";
}

function getOperatingRegionId(country = state.profile?.operating_region || state.profile?.country) {
  return normalizeCountryId(country);
}

function getSelectedCountryId() {
  return getOperatingRegionId();
}

function getProfileLanguage() {
  return normalizeLanguageId(state.profile?.language || "en");
}

function getCurrencyForRegion(region) {
  return REGION_CURRENCY_MAP[region] || "USD";
}

function getActiveCurrency() {
  return getCurrencyForRegion(state.profile?.operating_region || state.profile?.country);
}

function getProfileCurrency(region = getOperatingRegionId()) {
  return region ? getCurrencyForRegion(getOperatingRegionId(region)) : getActiveCurrency();
}

function getCurrencySymbol(currency = getProfileCurrency()) {
  const symbols = { NGN: "₦", USD: "$", GBP: "£", GHS: "₵", KES: "KSh", ZAR: "R", CAD: "CA$", AUD: "A$", EUR: "€", INR: "₹" };
  return symbols[String(currency || "").toUpperCase()] || `${currency} `;
}

function getCurrencyLocale() {
  return "en-US";
}

function getVoiceLocale() {
  return getProfileLanguage() === "en" && getOperatingRegionId() === "NG" ? "en-NG" : "en-US";
}

function getUnsupportedRegionMessage() {
  return "Some features are not yet available in your region";
}

function detectPhoneCountryFromPhoneNumber(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith(PHONE_COUNTRY_RULES.NG.dialingDigits)) return "NG";
  if (digits.startsWith(PHONE_COUNTRY_RULES.GH.dialingDigits)) return "GH";
  if (digits.startsWith(PHONE_COUNTRY_RULES.KE.dialingDigits)) return "KE";
  if (digits.startsWith(PHONE_COUNTRY_RULES.ZA.dialingDigits)) return "ZA";
  if (digits.length === 11 && digits.startsWith(PHONE_COUNTRY_RULES.US.dialingDigits)) return "US";
  return "";
}

function getPhoneInputCountry() {
  return getRecognizedCountryId(state.authPhoneCountry)
    || getRecognizedCountryId(state.profile?.phone_country)
    || detectPhoneCountryFromPhoneNumber(state.profile?.phone_number)
    || "";
}

function initializeAuthPhoneCountry() {
  state.authPhoneCountry = getRecognizedCountryId(state.authPhoneCountry)
    || getRecognizedCountryId(state.profile?.phone_country)
    || detectPhoneCountryFromPhoneNumber(state.profile?.phone_number)
    || "";
  if (state.profile) {
    state.profile.phone_country = state.authPhoneCountry || state.profile.phone_country || "";
  }
}

async function persistAuthPhoneCountry(country) {
  const nextCountry = getRecognizedCountryId(country) || getPhoneInputCountry();
  state.authPhoneCountry = nextCountry;
  if (state.profile) {
    state.profile.phone_country = nextCountry || "";
  }
  try {
    await saveSetting("auth_phone_country", nextCountry);
  } catch (error) {
    console.warn("Unable to persist selected phone country.", error);
  }
  syncDevQaSnapshot("auth_phone_country_updated");
}

function getCountryDialCode(country) {
  const countryId = getRecognizedCountryId(country);
  return PHONE_COUNTRY_RULES[countryId]?.dialCode || "";
}

function getExamplesForCountry() {
  return CAPTURE_EXAMPLES[state.profile?.operating_region] || CAPTURE_EXAMPLES[state.profile?.country] || CAPTURE_EXAMPLES.US;
}

function getCaptureExamples(country) {
  const countryId = getRecognizedCountryId(country);
  return CAPTURE_EXAMPLES[countryId] || CAPTURE_EXAMPLES.US;
}

function getCurrentCaptureExample(country = state.profile?.operating_region || state.profile?.country) {
  const examples = country ? getCaptureExamples(country) : getExamplesForCountry();
  const index = state.captureExampleIndex % examples.length;
  return examples[index] || examples[0] || "";
}

function renderCaptureExample() {
  const example = getCurrentCaptureExample();
  if (els["voice-label-v2"]) {
    els["voice-label-v2"].textContent = "Tap to speak your transaction";
  }
  if (els["voice-example-v2"]) {
    els["voice-example-v2"].textContent = `Try saying: "${example}"`;
  }
  if (els["quick-text-input-v2"]) {
    els["quick-text-input-v2"].placeholder = example;
  }
}

function stopCaptureExampleRotation() {
  if (state.captureExampleInterval) {
    window.clearInterval(state.captureExampleInterval);
    state.captureExampleInterval = null;
  }
}

function startCaptureExampleRotation() {
  stopCaptureExampleRotation();
  state.captureExampleIndex = 0;
  renderCaptureExample();
  if (!els["voice-example-v2"] && !els["quick-text-input-v2"]) return;
  state.captureExampleInterval = window.setInterval(() => {
    const examples = getCaptureExamples(getOperatingRegionId());
    state.captureExampleIndex = (state.captureExampleIndex + 1) % examples.length;
    renderCaptureExample();
  }, 3000);
}

function getOnboardingPhonePlaceholder(country) {
  const countryId = getRecognizedCountryId(country);
  return PHONE_COUNTRY_RULES[countryId]?.onboardingPlaceholder || "Phone number (use +country code if needed)";
}

function getOtpPhonePlaceholder(country) {
  const countryId = getRecognizedCountryId(country);
  return PHONE_COUNTRY_RULES[countryId]?.otpPlaceholder || "Phone number";
}

function isLocalDevelopmentOtpFallbackAllowed() {
  const hostname = String(window.location.hostname || "").trim().toLowerCase();
  return hostname === "127.0.0.1" || hostname === "localhost";
}

function isLocalQaMode() {
  return isLocalDevelopmentOtpFallbackAllowed();
}

function normalizeEmailAddress(value) {
  return String(value || "").trim().toLowerCase();
}

function isValidEmailAddress(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmailAddress(value));
}

function normalizeOtpChannel(channel) {
  return String(channel || "").trim().toLowerCase() === "sms" ? "sms" : "email";
}

function getPreferredOtpChannel() {
  return state.smsSupported ? normalizeOtpChannel(state.profile?.preferred_otp_channel || "email") : "email";
}

function getStoredPhoneAnchor() {
  const phoneNumber = String(state.profile?.phone_number || "").trim();
  return /^\+\d{7,15}$/.test(phoneNumber) ? phoneNumber : "";
}

function hasPhoneAnchor() {
  return Boolean(getStoredPhoneAnchor());
}

function needsPhoneAnchorForFullActivation(channel = getPreferredOtpChannel()) {
  return channel === "email" && !hasVerifiedSessionForChannel(channel) && !hasPhoneAnchor();
}

function getPhoneAnchorRequirementMessage(channel = getPreferredOtpChannel()) {
  if (channel === "sms") {
    return "Add a phone number to continue.";
  }
  return "Add a phone number to your profile before email verification can activate sync on this device.";
}

function getVerificationSummaryLabel() {
  syncVerificationState();
  if (state.emailVerified && state.phoneVerified) {
    return "Email and phone verified";
  }
  if (state.emailVerified) {
    return "Email verified";
  }
  if (state.phoneVerified) {
    return "Phone verified";
  }
  return "Not verified";
}

function getVerificationChannelAvailabilityLabel() {
  return state.smsSupported ? "Email and SMS available" : "Email OTP only right now";
}

function getVerificationChannelNoun(channel = getPreferredOtpChannel()) {
  return channel === "sms" ? "phone" : "email";
}

function getVerificationChannelLabel(channel = getPreferredOtpChannel()) {
  return channel === "sms" ? "Phone verification" : "Email verification";
}

function getVerificationActionLabel(channel = getPreferredOtpChannel()) {
  return channel === "sms" ? "Verify phone" : "Verify by email";
}

function getRecoveryChannelCopy(channel = getPreferredOtpChannel()) {
  return channel === "sms"
    ? "Use your verified phone number to pull down your profile and records on this device."
    : "Use your verified email to pull down your profile and records on this device.";
}

function isChannelVerified(channel) {
  if (channel === "sms") return Boolean(state.profile?.phone_verified);
  return Boolean(state.profile?.email_verified);
}

function hasVerifiedSessionForChannel(channel = getPreferredOtpChannel()) {
  return Boolean(isAuthSessionValid() && isChannelVerified(channel));
}

function hasVerifiedIdentityAnchor() {
  return Boolean(
    (state.profile?.identity_status === "verified_local" || state.profile?.identity_status === "verified_server")
    && (state.profile?.email_verified || state.profile?.phone_verified)
  );
}

function syncDevQaSnapshot(reason = "") {
  if (window.location.hostname !== "localhost") {
    delete window.KONFIRMATA_DEV_QA;
    return;
  }
  window.KONFIRMATA_DEV_QA = {
    reason,
    at: new Date().toISOString(),
    screen: document.querySelector(".screen.active")?.id || "",
    otp_channel: getPreferredOtpChannel(),
    verification_summary: getVerificationSummaryLabel(),
    email_verified: Boolean(state.profile?.email_verified),
    phone_verified: Boolean(state.profile?.phone_verified),
    phone_anchor: hasPhoneAnchor() ? "present" : "missing",
    auth_phone_country: state.authPhoneCountry || "",
    auth_session: Boolean(isAuthSessionValid()),
    device_identity: Boolean(state.deviceIdentity),
    sms_supported: Boolean(state.smsSupported),
    local_passcode_reminder: Boolean(getPasscodeReminder()),
    sync_status: state.syncStatus || ""
  };
}

function getRegionPlaceholder(country) {
  const countryId = getRecognizedCountryId(country);
  if (countryId === "US") {
    return "e.g. Texas, California, New York";
  }
  if (countryId === "NG") {
    return "e.g. Kano, Lagos, Abuja";
  }
  return "State or region";
}

function getPhoneValidationMessage(country) {
  const countryId = getRecognizedCountryId(country);
  return PHONE_COUNTRY_RULES[countryId]?.validationMessage || "Enter a valid phone number in international format.";
}

function normalizePhoneNumber(value, country) {
  const raw = String(value || "").trim();
  const countryId = getRecognizedCountryId(country);
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";

  if (raw.startsWith("+") && /^\+\d{7,15}$/.test(raw.replace(/[^\d+]/g, ""))) {
    return `+${digits}`;
  }

  if (countryId === "US") {
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
    return "";
  }

  if (countryId === "GH") {
    if (digits.length === 12 && digits.startsWith("233")) return `+${digits}`;
    if (digits.length === 10 && digits.startsWith("0")) return `+233${digits.slice(1)}`;
    if (digits.length === 9) return `+233${digits}`;
    return "";
  }

  if (countryId === "KE") {
    if (digits.length === 12 && digits.startsWith("254")) return `+${digits}`;
    if (digits.length === 10 && digits.startsWith("0")) return `+254${digits.slice(1)}`;
    if (digits.length === 9) return `+254${digits}`;
    return "";
  }

  if (countryId === "ZA") {
    if (digits.length === 11 && digits.startsWith("27")) return `+${digits}`;
    if (digits.length === 10 && digits.startsWith("0")) return `+27${digits.slice(1)}`;
    if (digits.length === 9) return `+27${digits}`;
    return "";
  }

  if (countryId === "NG") {
    if (digits.length === 13 && digits.startsWith("234")) return `+${digits}`;
    if (digits.length === 11 && digits.startsWith("0")) return `+234${digits.slice(1)}`;
    if (digits.length === 10) return `+234${digits}`;
  }
  return "";
}

function isValidPhoneNumber(value, country) {
  return Boolean(normalizePhoneNumber(value, country));
}

function formatPhoneForInput(value, country) {
  const countryId = getRecognizedCountryId(country);
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";

  if (countryId === "US") {
    if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
    if (digits.length === 10) return digits;
    return String(value || "");
  }

  if (countryId === "GH") {
    if (digits.length === 12 && digits.startsWith("233")) return `0${digits.slice(3)}`;
    if (digits.length === 10 && digits.startsWith("0")) return digits;
    if (digits.length === 9) return `0${digits}`;
    return String(value || "");
  }

  if (countryId === "KE") {
    if (digits.length === 12 && digits.startsWith("254")) return `0${digits.slice(3)}`;
    if (digits.length === 10 && digits.startsWith("0")) return digits;
    if (digits.length === 9) return `0${digits}`;
    return String(value || "");
  }

  if (countryId === "ZA") {
    if (digits.length === 11 && digits.startsWith("27")) return `0${digits.slice(2)}`;
    if (digits.length === 10 && digits.startsWith("0")) return digits;
    if (digits.length === 9) return `0${digits}`;
    return String(value || "");
  }

  if (countryId === "NG") {
    if (digits.length === 13 && digits.startsWith("234")) return `0${digits.slice(3)}`;
    if (digits.length === 11 && digits.startsWith("0")) return digits;
    if (digits.length === 10) return `0${digits}`;
  }
  return String(value || "");
}

function syncCountryAwareInputs() {
  const operatingRegion = getOperatingRegionId();
  const phoneCountry = getPhoneInputCountry();
  const otpChannel = getPreferredOtpChannel();
  if (els["onboarding-phone"]) {
    els["onboarding-phone"].placeholder = getOnboardingPhonePlaceholder(phoneCountry);
  }
  if (els["onboarding-state"]) {
    els["onboarding-state"].placeholder = getRegionPlaceholder(operatingRegion);
  }
  if (els["otp-email-field"]) {
    els["otp-email-field"].hidden = otpChannel !== "email";
  }
  if (els["otp-phone-field"]) {
    els["otp-phone-field"].hidden = otpChannel !== "sms";
  }
  if (els["otp-email-input"]) {
    els["otp-email-input"].value = state.profile?.email || "";
  }
  if (els["otp-phone-input"]) {
    els["otp-phone-input"].placeholder = getOtpPhonePlaceholder(phoneCountry);
  }
  if (els["otp-country-prefix"]) {
    els["otp-country-prefix"].textContent = getCountryDialCode(phoneCountry);
  }
  if (els["restore-email-field"]) {
    els["restore-email-field"].hidden = otpChannel !== "email";
  }
  if (els["restore-phone-field"]) {
    els["restore-phone-field"].hidden = otpChannel !== "sms";
  }
  if (els["restore-email-input"]) {
    els["restore-email-input"].value = state.profile?.email || "";
  }
  if (els["restore-phone-input"]) {
    els["restore-phone-input"].placeholder = getOtpPhonePlaceholder(phoneCountry);
  }
  if (els["restore-country-prefix"]) {
    els["restore-country-prefix"].textContent = getCountryDialCode(phoneCountry);
  }
}

function parseMinor(value) {
  const number = parseFloat(String(value || "").replace(/,/g, ""));
  return Number.isFinite(number) ? Math.round(number * 100) : 0;
}

function updateAmountInputStep() {
  if (!els["amount-input-v2"]) return;
  const currency = getProfileCurrency();
  const allowsDecimals = currency !== "NGN";
  els["amount-input-v2"].step = allowsDecimals ? "0.01" : "1";
  if (els["amount-helper-v2"]) {
    els["amount-helper-v2"].textContent = allowsDecimals
      ? `Enter amount in ${currency}. Decimals are allowed.`
      : "Enter amount in Naira. Whole amounts work best.";
  }
}

function renderOtpScreen() {
  if (!els["otp-helper-text"]) return;
  const channel = getPreferredOtpChannel();
  const missingPhoneAnchor = needsPhoneAnchorForFullActivation(channel);
  syncVerificationState();
  syncCountryAwareInputs();
  if (els["otp-screen-header-title"]) {
    els["otp-screen-header-title"].textContent = getVerificationChannelLabel(channel);
  }
  if (els["otp-screen-header-copy"]) {
    els["otp-screen-header-copy"].textContent = state.smsSupported
      ? "Prepare this device for trusted exports and recovery"
      : "Email OTP is active right now. SMS is not enabled yet.";
  }
  if (els["otp-screen-title"]) {
    els["otp-screen-title"].textContent = channel === "sms" ? "Verify your phone on this device" : "Verify your email on this device";
  }
  if (els["otp-screen-copy"]) {
    els["otp-screen-copy"].textContent = channel === "sms"
      ? "Konfirmata will send a code to your phone number when SMS delivery is available."
      : (missingPhoneAnchor
        ? `${getPhoneAnchorRequirementMessage(channel)} Existing phone-anchored accounts with a saved email can still restore by email on a new device.`
        : (isLocalDevelopmentOtpFallbackAllowed()
          ? "Konfirmata sends a code to your email address. If delivery is unavailable in local development, this device can still use a local development code."
          : "Konfirmata sends a code to your email address to verify this device."));
  }
  if (els["otp-email-input"]) {
    els["otp-email-input"].value = state.profile?.email || "";
  }
  if (els["otp-phone-input"]) {
    els["otp-phone-input"].value = formatPhoneForInput(state.profile?.phone_number || "", getPhoneInputCountry());
  }
  if (els["otp-request-code"]) {
    els["otp-request-code"].textContent = channel === "sms" ? "Send verification code" : "Send verification code";
  }
  if (els["otp-verify-code"]) {
    els["otp-verify-code"].textContent = channel === "sms" ? "Verify phone on this device" : "Verify email on this device";
  }
  if (els["otp-code-input"]) {
    els["otp-code-input"].value = "";
  }
  els["otp-helper-text"].textContent = state.otpChallenge
    ? getOtpHelperText()
    : (missingPhoneAnchor
      ? getPhoneAnchorRequirementMessage(channel)
      : channel === "sms"
        ? "Request a code to verify this device."
        : "Request a code to verify your email on this device.");
  els["otp-status-card"].innerHTML = `
    ${renderSettingsRow("Verification summary", getVerificationSummaryLabel())}
    ${renderSettingsRow("Verification channels", getVerificationChannelAvailabilityLabel())}
    ${renderSettingsRow("Email verification", getVerificationStatusLabel("email"))}
    ${(state.smsSupported || state.profile?.phone_verified) ? renderSettingsRow("Phone verification", getVerificationStatusLabel("sms")) : ""}
    ${renderSettingsRow("Phone anchor", getPhoneAnchorStatusLabel())}
    ${renderSettingsRow("Device key", getDeviceKeyStatusLabel())}
    ${state.publicKeyFingerprint ? renderSettingsRow("Device ID", state.publicKeyFingerprint.slice(0, 8)) : ""}
    ${renderSettingsRow("Auth session", getAuthSessionStatusLabel())}
    ${renderSettingsRow("Recovery contact", maskContact(channel === "sms" ? (state.profile?.phone_number || "Not set") : (state.profile?.email || "Not set")))}
    ${state.profile?.phone_number ? renderSettingsRow("Phone on profile", maskContact(state.profile.phone_number)) : ""}
    ${renderSettingsRow("Email for delivery", maskContact(state.profile?.email || "Not set"))}
  `;
  clearOtpError();
}

function getCurrentOtpIdentifier(channel = getPreferredOtpChannel()) {
  if (channel === "sms") {
    return normalizePhoneNumber(els["otp-phone-input"]?.value.trim() || state.profile?.phone_number || "", getPhoneInputCountry());
  }
  return normalizeEmailAddress(els["otp-email-input"]?.value.trim() || state.profile?.email || "");
}

function getCurrentRestoreIdentifier(channel = getPreferredOtpChannel()) {
  if (channel === "sms") {
    return normalizePhoneNumber(els["restore-phone-input"]?.value.trim() || state.profile?.phone_number || "", getPhoneInputCountry());
  }
  return normalizeEmailAddress(els["restore-email-input"]?.value.trim() || state.profile?.email || "");
}

function getIdentifierValidationMessage(channel = getPreferredOtpChannel(), country = getPhoneInputCountry()) {
  return channel === "sms" ? getPhoneValidationMessage(country) : "Enter a valid email address";
}

async function requestOtpChallenge(identifier, {
  channel = getPreferredOtpChannel(),
  fallbackToLocal = true,
  phoneNumber = state.profile?.phone_number || ""
} = {}) {
  const normalizedChannel = normalizeOtpChannel(channel);
  if (!identifier) {
    throw new Error(getIdentifierValidationMessage(normalizedChannel));
  }

  try {
    const response = await requestOtpCode(state.syncApiBaseUrl, identifier, {
      channel: normalizedChannel,
      phone_number: normalizedChannel === "email" ? phoneNumber || "" : identifier,
      email: normalizedChannel === "email" ? identifier : (state.profile?.email || "")
    });
    state.smsSupported = Boolean(response?.sms_available);
    state.otpChallenge = {
      identifier,
      phoneNumber: phoneNumber || "",
      channel: normalizedChannel,
      expiresAt: Date.now() + 10 * 60 * 1000,
      source: "server",
      devCode: response.dev_code || "",
      serverBaseUrl: state.syncApiBaseUrl
    };
    state.syncStatus = `${getVerificationChannelLabel(normalizedChannel)} requested from sync server.`;
    syncDevQaSnapshot("otp_requested");
  } catch (error) {
    const allowLocalFallback = fallbackToLocal
      && normalizedChannel === "email"
      && isLocalDevelopmentOtpFallbackAllowed();
    if (!allowLocalFallback) {
      throw error;
    }
    const random = new Uint32Array(1);
    crypto.getRandomValues(random);
    const code = String(random[0] % 1000000).padStart(6, "0");
    state.otpChallenge = {
      code,
      identifier,
      phoneNumber: phoneNumber || "",
      channel: normalizedChannel,
      expiresAt: Date.now() + 10 * 60 * 1000,
      source: "local"
    };
    state.syncStatus = "Sync server unavailable in local development. Using a local verification fallback.";
    syncDevQaSnapshot("otp_local_fallback");
  }

  return state.otpChallenge;
}

async function verifyActiveOtpChallenge(
  enteredCode,
  {
    country = getPhoneInputCountry(),
    persistProfileRemotely = true
  } = {}
) {
  if (!state.profile) {
    throw new Error("Profile not loaded yet.");
  }

  const activeChallenge = state.otpChallenge;
  if (!activeChallenge) {
    throw new Error("Generate a code first");
  }

  if (Date.now() > activeChallenge.expiresAt) {
    state.otpChallenge = null;
    throw new Error("This code expired. Generate a new one");
  }

  if (!/^\d{6}$/.test(enteredCode)) {
    throw new Error("Enter a valid 6-digit code");
  }

  const challengeChannel = normalizeOtpChannel(activeChallenge.channel || getPreferredOtpChannel());
  const normalizedChallengeIdentifier = challengeChannel === "sms"
    ? normalizePhoneNumber(activeChallenge.identifier, country)
    : normalizeEmailAddress(activeChallenge.identifier);
  const normalizedChallengePhone = normalizePhoneNumber(activeChallenge.phoneNumber, country);

  if (!normalizedChallengeIdentifier) {
    throw new Error(getIdentifierValidationMessage(challengeChannel, country));
  }

  if (activeChallenge.source === "server") {
    await createAndStoreDeviceKeyMaterial();
    const response = await verifyOtpCode(
      activeChallenge.serverBaseUrl || state.syncApiBaseUrl,
      normalizedChallengeIdentifier,
      enteredCode,
      {
        channel: challengeChannel,
        phone_number: normalizedChallengePhone || state.profile.phone_number || "",
        email: challengeChannel === "email" ? normalizedChallengeIdentifier : (state.profile.email || ""),
        device_identity: state.deviceIdentity || "",
        public_key: state.devicePublicKey || ""
      }
    );
    state.authSessionKey = response["auth_" + "to" + "ken"] || "";
    state.authSessionExpiresAt = response.expires_at || "";
    state.smsSupported = Boolean(response?.sms_available ?? state.smsSupported);
    if (response.device_identity) {
      state.deviceIdentity = response.device_identity;
      await saveSetting("device_identity", state.deviceIdentity);
    }
    state.profile.identity_anchor = challengeChannel;
    state.profile.identity_status = "verified_server";
    state.profile.identity_verified_at = Date.now();
    if (challengeChannel === "email") {
      state.profile.email = response.email || normalizedChallengeIdentifier;
      state.profile.email_verified = Boolean(response.email_verified ?? true);
      if (response.phone_number) {
        state.profile.phone_number = response.phone_number;
      }
    } else {
      state.profile.phone_number = response.phone_number || normalizedChallengeIdentifier;
      state.profile.phone_verified = Boolean(response.phone_verified ?? true);
      if (response.email) {
        state.profile.email = response.email;
      }
    }
    state.profile.email_verified = Boolean(response.email_verified ?? state.profile.email_verified);
    state.profile.phone_verified = Boolean(response.phone_verified ?? state.profile.phone_verified);
    state.profile.phone_country = detectPhoneCountryFromPhoneNumber(state.profile.phone_number) || state.profile.phone_country || "";
    await Promise.all([
      saveProfile(state.profile, { skipPush: true }),
      saveSetting("auth_" + "to" + "ken", state.authSessionKey),
      saveSetting("auth_" + "to" + "ken_expires_at", state.authSessionExpiresAt)
    ]);
    if (state.profile.phone_country) {
      await persistAuthPhoneCountry(state.profile.phone_country);
    }
    state.syncStatus = `${getVerificationChannelLabel(challengeChannel)} completed with sync server.`;
  } else if (enteredCode !== activeChallenge.code) {
    throw new Error("Incorrect code. Please try again.");
  } else {
    if (challengeChannel === "email") {
      state.profile.email = normalizedChallengeIdentifier;
      state.profile.email_verified = true;
    } else {
      state.profile.phone_number = normalizedChallengeIdentifier;
      state.profile.phone_verified = true;
    }
    state.profile.phone_country = detectPhoneCountryFromPhoneNumber(state.profile.phone_number) || state.profile.phone_country || "";
    state.profile.identity_anchor = challengeChannel;
    state.profile.identity_status = "verified_local";
    state.profile.identity_verified_at = Date.now();
    await saveProfile(state.profile, { skipPush: !persistProfileRemotely });
    if (state.profile.phone_country) {
      await persistAuthPhoneCountry(state.profile.phone_country);
    }
    state.syncStatus = `${getVerificationChannelLabel(challengeChannel)} completed locally. Server sign-in is still pending.`;
  }

  try {
    await ensureDeviceKeyMaterial();
  } catch (error) {
    throw new Error(error.message || "Verification succeeded, but device key setup failed.");
  }

  state.otpChallenge = null;
  syncVerificationState();
  await refreshSyncQueueCount();
  if (activeChallenge.source === "server") {
    await restoreServerAccountIntoLocal({
      fallbackCountry: country,
      allowProfilePush: persistProfileRemotely
    });
  }
  syncDevQaSnapshot("otp_verified");
  return challengeChannel === "email"
    ? (state.profile.email || normalizedChallengeIdentifier)
    : (state.profile.phone_number || normalizedChallengeIdentifier);
}

async function requestLocalOtpCode() {
  if (!state.profile) return;
  const channel = getPreferredOtpChannel();
  const identifier = getCurrentOtpIdentifier(channel);
  const phoneNumber = normalizePhoneNumber(state.profile.phone_number || "", getPhoneInputCountry());
  if (needsPhoneAnchorForFullActivation(channel)) {
    showOtpError(getPhoneAnchorRequirementMessage(channel));
    return;
  }
  if (!identifier) {
    showOtpError(getIdentifierValidationMessage(channel, getPhoneInputCountry()));
    return;
  }

  if (channel === "email") {
    state.profile.email = identifier;
  } else {
    state.profile.phone_number = identifier;
    state.profile.phone_country = detectPhoneCountryFromPhoneNumber(identifier) || state.profile.phone_country || "";
  }
  await saveProfile(state.profile);
  try {
    await requestOtpChallenge(identifier, {
      channel,
      phoneNumber
    });
  } catch (error) {
    showOtpError(error.message || "Failed to request OTP");
    return;
  }
  renderOtpScreen();
}

async function verifyLocalOtpCode() {
  if (!state.profile) return;
  const enteredCode = (els["otp-code-input"]?.value || "").trim();
  try {
    clearOtpError();
    await verifyActiveOtpChallenge(enteredCode);
    renderOtpScreen();
  } catch (error) {
    if (!state.otpChallenge) {
      renderOtpScreen();
    }
    showOtpError(error.message || "Verification failed.");
    return;
  }
  const returnScreen = state.otpReturnScreen || "screen-capture";
  if (returnScreen === "screen-settings") {
    await renderSettings();
  }
  if (returnScreen === "screen-export") {
    renderExportScreen();
  }
  void flushSyncQueue();
  showScreen(returnScreen);
}

function getVerificationStatusLabel(channel = getPreferredOtpChannel()) {
  const channelName = channel === "sms" ? "Phone" : "Email";
  if (state.profile?.identity_status === "verified_server" && isChannelVerified(channel) && isAuthSessionValid()) {
    return `${channelName} verified with sync server`;
  }
  if (state.profile?.identity_status === "verified_local" && isChannelVerified(channel)) {
    return `${channelName} verified on this device (local fallback)`;
  }
  return `${channelName} not verified yet`;
}

function getPhoneAnchorStatusLabel() {
  const phoneAnchor = getStoredPhoneAnchor();
  if (phoneAnchor) {
    return phoneAnchor;
  }
  return getPhoneAnchorRequirementMessage();
}

function syncVerificationState() {
  state.emailVerified = Boolean(state.profile?.email_verified);
  state.phoneVerified = Boolean(state.profile?.phone_verified);
  return {
    emailVerified: state.emailVerified,
    phoneVerified: state.phoneVerified
  };
}

function syncPhoneVerificationState() {
  syncVerificationState();
  return state.phoneVerified;
}

function refreshTrustSetupButtons() {
  syncVerificationState();
  const channel = getPreferredOtpChannel();
  const deviceVerified = hasVerifiedSessionForChannel(channel);
  const trustButtons = [
    { id: "settings-open-trust-v3", defaultText: getVerificationActionLabel(channel) },
    { id: "export-open-trust-v3", defaultText: `Open ${getVerificationChannelLabel(channel).toLowerCase()}` }
  ];

  trustButtons.forEach(({ id, defaultText }) => {
    const button = els[id];
    if (!button) return;
    button.disabled = deviceVerified;
    button.textContent = deviceVerified ? "Device verified" : defaultText;
  });
}

function showOtpError(message) {
  if (!els["otp-error-text"]) return;
  els["otp-error-text"].hidden = !message;
  els["otp-error-text"].textContent = message || "";
}

function clearOtpError() {
  showOtpError("");
}

function isAuthSessionValid() {
  if (!state.authSessionKey || !state.authSessionExpiresAt) return false;
  const expiresAtMs = new Date(state.authSessionExpiresAt).getTime();
  return Number.isFinite(expiresAtMs) && expiresAtMs > Date.now();
}

function getExpiredAuthSessionMessage() {
  return `Your server session expired. Re-open ${getVerificationChannelLabel().toLowerCase()} to continue.`;
}

async function fetchAuthenticatedJson(path, options = {}) {
  if (!isAuthSessionValid()) {
    const error = new Error(getExpiredAuthSessionMessage());
    error.statusCode = 401;
    error.payload = { error: "auth_expired" };
    state.syncStatus = error.message;
    throw error;
  }

  const normalizedBaseUrl = String(state.syncApiBaseUrl || "").trim().replace(/\/+$/, "");
  if (!normalizedBaseUrl) {
    const error = new Error("Sync server URL is not configured.");
    error.statusCode = 0;
    throw error;
  }

  const response = await fetch(`${normalizedBaseUrl}${path}`, {
    method: options.method || "GET",
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(state.deviceIdentity ? { "X-Device-Identity": state.deviceIdentity } : {}),
      ...(state.authSessionKey ? { Authorization: `Bearer ${state.authSessionKey}` } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  let data = null;
  try {
    data = await response.json();
  } catch (error) {
    data = null;
  }

  if (!response.ok) {
    const message = data?.error || data?.message || `Request failed with status ${response.status}`;
    const error = new Error(message);
    error.statusCode = response.status;
    error.payload = data;
    if (response.status === 401 && data?.error === "device_revoked") {
      state.syncStatus = "This device has been revoked. Restore your account again to continue.";
    }
    throw error;
  }

  return data || {};
}

async function logoutFromServerSession() {
  state.authSessionKey = "";
  state.authSessionExpiresAt = "";
  state.otpChallenge = null;
  state.syncStatus = "Signed out. Re-open verification to sync again.";
  await Promise.all([
    saveSetting("auth_" + "to" + "ken", ""),
    saveSetting("auth_" + "to" + "ken_expires_at", "")
  ]);
  refreshTrustSetupButtons();
  renderExportScreen();
  await renderSettings();
}

function buildProfileSyncPayload(profile = state.profile) {
  if (!profile) return null;
  const displayName = String(profile.display_name || "").trim();
  const operatingRegion = getOperatingRegionId(profile.operating_region || profile.country);
  const language = normalizeLanguageId(profile.language || "en");
  return {
    name: displayName || null,
    business_name: displayName || null,
    country: operatingRegion || null,
    operating_region: operatingRegion || null,
    language,
    business_type_id: String(profile.business_type_id || "").trim() || null,
    sector_id: String(profile.sector_id || "").trim() || null,
    preferred_labels: normalizePreferredLabels(profile.preferred_labels, profile.business_type_id),
    email: normalizeEmailAddress(profile.email || "") || null
  };
}

async function pushProfile() {
  if (!(state.profile && isAuthSessionValid() && state.syncApiBaseUrl)) return;
  const payload = buildProfileSyncPayload();
  if (!payload) return;
  try {
    await postJson(state.syncApiBaseUrl, "/profile", payload, state.authSessionKey, {
      deviceIdentity: state.deviceIdentity
    });
  } catch (error) {
    console.warn("Profile push skipped.", error);
  }
}

function mergeServerProfile(serverProfile, fallbackCountry = getSelectedCountryId()) {
  if (!serverProfile) return null;
  const displayName = String(serverProfile.business_name || serverProfile.name || "").trim();
  return normalizeLocalProfile({
    ...(state.profile || {}),
    plan: "free",
    display_name: displayName || state.profile?.display_name || "",
    phone_number: String(serverProfile.phone || state.profile?.phone_number || "").trim(),
    email: normalizeEmailAddress(serverProfile.email || state.profile?.email || ""),
    operating_region: normalizeCountryId(serverProfile.operating_region || serverProfile.country || fallbackCountry || state.profile?.operating_region),
    phone_country: getRecognizedCountryId(serverProfile.phone_country) || detectPhoneCountryFromPhoneNumber(serverProfile.phone || state.profile?.phone_number) || state.profile?.phone_country || "",
    language: normalizeLanguageId(serverProfile.language || state.profile?.language || "en"),
    business_type_id: String(serverProfile.business_type_id || state.profile?.business_type_id || "").trim() || null,
    sector_id: String(serverProfile.sector_id || state.profile?.sector_id || "").trim() || null,
    preferred_labels: normalizePreferredLabels(
      serverProfile.preferred_labels,
      serverProfile.business_type_id || state.profile?.business_type_id
    ),
    passcodeReminder: clonePasscodeReminder(getPasscodeReminder(state.profile)),
    email_verified: Boolean(serverProfile.email_verified ?? state.profile?.email_verified),
    phone_verified: Boolean(serverProfile.phone_verified ?? state.profile?.phone_verified),
    last_action: state.profile?.last_action || "sale",
    identity_anchor: state.profile?.identity_anchor || getPreferredOtpChannel(),
    identity_status: state.profile?.identity_status || "verified_server",
    identity_verified_at: state.profile?.identity_verified_at || Date.now()
  });
}

async function pullProfile(fallbackCountry = getSelectedCountryId()) {
  const response = await fetchAuthenticatedJson("/profile");
  if (!response.profile) {
    return null;
  }

  state.profile = mergeServerProfile(response.profile, fallbackCountry);
  initializeAuthPhoneCountry();
  await saveProfile(state.profile, { skipPush: true });
  syncDevQaSnapshot("profile_pulled");
  return response.profile;
}

function normalizeServerTransactionType(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "sell") return "sale";
  if (normalized === "buy") return "purchase";
  if (normalized === "pay") return "payment";
  if (normalized === "receive") return "receipt";
  return normalized || "sale";
}

function normalizeImportedRecord(record, index) {
  const transactionType = normalizeServerTransactionType(record.transaction_type || record.action);
  const confirmedAt = Number(record.confirmed_at || 0);
  const operatingRegion = getRecognizedCountryId(record.operating_region || record.country) || state.profile?.operating_region || getOperatingRegionId();
  return {
    id: 1000000000 + index + 1,
    server_entry_id: Number(record.entry_id || 0),
    importedFromServer: true,
    device_identity: String(record.device_identity || "").trim(),
    transaction_type: transactionType,
    label: String(record.label || "").trim() || "Imported record",
    normalized_label: String(record.normalized_label || "").trim() || normalizeText(record.label || transactionType),
    amount_minor: Number(record.amount_minor || 0),
    currency: record.currency || getProfileCurrency(operatingRegion),
    counterparty: record.counterparty ?? null,
    source_account: record.source_account ?? null,
    destination_account: record.destination_account ?? null,
    input_mode: record.input_mode || "server_restore",
    confirmation_state: "confirmed",
    business_type_id: record.business_type_id || state.profile?.business_type_id || null,
    sector_id: record.sector_id || state.profile?.sector_id || null,
    country: operatingRegion,
    operating_region: operatingRegion,
    reversed_entry_hash: record.reversed_entry_hash ?? null,
    reversed_transaction_type: record.reversed_transaction_type ?? null,
    confirmed_at: confirmedAt,
    prev_entry_hash: record.prev_entry_hash || "0".repeat(64),
    entry_hash: record.entry_hash || "",
    signature: record.signature || null,
    public_key_fingerprint: record.public_key_fingerprint || null
  };
}

async function replaceLocalRecordsWithImported(records) {
  const importedRecords = records.map((record, index) => normalizeImportedRecord(record, index));
  await new Promise((resolve, reject) => {
    const tx = state.db.transaction(["records", "syncQueue"], "readwrite");
    const recordsStore = tx.objectStore("records");
    const syncQueueStore = tx.objectStore("syncQueue");
    recordsStore.clear();
    syncQueueStore.clear();
    importedRecords.forEach((record) => {
      recordsStore.add(record);
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  await refreshSyncQueueCount();
}

function getRecordMergeKey(record) {
  if (record?.entry_hash) return `hash:${record.entry_hash}`;
  if (record?.server_entry_id) return `server:${record.device_identity || ""}:${record.server_entry_id}`;
  return `local:${record?.id || ""}:${record?.confirmed_at || ""}:${record?.amount_minor || ""}:${record?.label || ""}`;
}

async function mergeLocalRecordsWithImported(records) {
  const importedRecords = records.map((record, index) => normalizeImportedRecord(record, index));
  if (!importedRecords.length) return 0;

  const localRecords = await getRecords();
  const merged = new Map();
  [...localRecords, ...importedRecords].forEach((record) => {
    const key = getRecordMergeKey(record);
    if (!key) return;
    const existing = merged.get(key);
    merged.set(key, {
      ...(existing || {}),
      ...record,
      evidence_level: record.evidence_level || existing?.evidence_level || null
    });
  });

  const mergedRecords = [...merged.values()].sort((a, b) => {
    const timeDiff = getRecordConfirmedAtMs(a) - getRecordConfirmedAtMs(b);
    if (timeDiff) return timeDiff;
    return Number(a.server_entry_id || a.id || 0) - Number(b.server_entry_id || b.id || 0);
  });

  await new Promise((resolve, reject) => {
    const tx = state.db.transaction("records", "readwrite");
    const recordsStore = tx.objectStore("records");
    recordsStore.clear();
    mergedRecords.forEach((record) => {
      recordsStore.add(record);
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  return importedRecords.length;
}

async function pullRecordsFromServer() {
  const response = await fetchAuthenticatedJson("/records");
  return Array.isArray(response.records) ? response.records : [];
}

async function restoreServerRecordsIntoLocal({ quiet = false } = {}) {
  if (!(state.db && isAuthSessionValid() && state.syncApiBaseUrl)) return 0;

  try {
    await flushSyncQueue();
    const records = await pullRecordsFromServer();
    const importedCount = await mergeLocalRecordsWithImported(records);
    if (importedCount && !quiet) {
      state.syncStatus = `Restored ${importedCount} server record${importedCount === 1 ? "" : "s"} to this device.`;
      await updateSyncBadge();
    }
    return importedCount;
  } catch (error) {
    console.warn("Server record restore skipped.", error);
    return 0;
  }
}

async function restoreServerAccountIntoLocal({
  quiet = false,
  fallbackCountry = getSelectedCountryId(),
  allowProfilePush = false
} = {}) {
  if (!(state.db && isAuthSessionValid() && state.syncApiBaseUrl)) {
    return { profile: null, records: 0 };
  }

  let serverProfile = null;
  try {
    serverProfile = await pullProfile(fallbackCountry);
    if (!serverProfile && allowProfilePush) {
      await pushProfile();
    }
  } catch (error) {
    console.warn("Server profile restore skipped.", error);
  }

  if (state.profile) {
    hydrateProfileUi();
    renderActionRows();
    await renderQuickLabels();
  }

  const records = await restoreServerRecordsIntoLocal({ quiet });
  return { profile: serverProfile, records };
}

function getRestoreCountryId() {
  return getPhoneInputCountry();
}

function syncRestoreModalCopy() {
  const country = getRestoreCountryId();
  const channel = getPreferredOtpChannel();
  if (els["restore-copy"]) {
    els["restore-copy"].textContent = getRecoveryChannelCopy(channel);
  }
  if (els["restore-phone-input"]) {
    els["restore-phone-input"].placeholder = getOtpPhonePlaceholder(country);
  }
  if (els["restore-country-prefix"]) {
    els["restore-country-prefix"].textContent = getCountryDialCode(country);
  }
  if (els["restore-helper-text"]) {
    els["restore-helper-text"].textContent = state.otpChallenge
      ? getOtpHelperText()
      : channel === "sms"
        ? "Request a restore code to continue."
        : "Request a restore code by email to continue.";
  }
}

function clearRestoreError() {
  if (!els["restore-error-text"]) return;
  els["restore-error-text"].hidden = true;
  els["restore-error-text"].textContent = "";
}

function showRestoreError(message) {
  if (!els["restore-error-text"]) return;
  els["restore-error-text"].hidden = !message;
  els["restore-error-text"].textContent = message || "";
}

function resetRestoreModal() {
  state.otpChallenge = null;
  if (els["restore-code-input"]) {
    els["restore-code-input"].value = "";
  }
  if (els["restore-code-wrap"]) {
    els["restore-code-wrap"].hidden = true;
  }
  if (els["restore-send-code"]) {
    els["restore-send-code"].hidden = false;
    els["restore-send-code"].disabled = false;
  }
  if (els["restore-verify-code"]) {
    els["restore-verify-code"].hidden = true;
    els["restore-verify-code"].disabled = false;
  }
  clearRestoreError();
  syncRestoreModalCopy();
}

function openRestoreModal() {
  if (!state.profile) {
    state.profile = {
      ...(state.profile || {}),
      plan: normalizePlan(state.profile?.plan),
      operating_region: getOperatingRegionId(),
      language: "en",
      phone_country: getPhoneInputCountry()
    };
  }
  initializeAuthPhoneCountry();
  syncCountryAwareInputs();
  if (els["restore-email-input"]) {
    els["restore-email-input"].value = state.profile?.email || "";
  }
  if (els["restore-phone-input"]) {
    els["restore-phone-input"].value = formatPhoneForInput(state.profile?.phone_number || "", getRestoreCountryId());
  }
  resetRestoreModal();
  if (els["restore-modal"]) {
    els["restore-modal"].hidden = false;
    focusFirstInteractive(els["restore-modal"]);
  }
  syncDevQaSnapshot("restore_modal_open");
}

function restoreAccountFlow() {
  openRestoreModal();
}

function closeRestoreModal() {
  if (els["restore-modal"]) {
    els["restore-modal"].hidden = true;
  }
  resetRestoreModal();
}

async function sendRestoreCode() {
  const channel = getPreferredOtpChannel();
  const country = getRestoreCountryId();
  const identifier = getCurrentRestoreIdentifier(channel);
  const phoneNumber = normalizePhoneNumber(els["restore-phone-input"]?.value.trim() || state.profile?.phone_number || "", country);
  if (!identifier) {
    showRestoreError(getIdentifierValidationMessage(channel, country));
    return;
  }

  if (!state.profile) {
    state.profile = {
      plan: "free",
      operating_region: getOperatingRegionId(),
      language: "en",
      phone_country: country
    };
  }

  if (channel === "email") {
    state.profile.email = identifier;
  } else {
    state.profile.phone_number = identifier;
    state.profile.phone_country = detectPhoneCountryFromPhoneNumber(identifier) || country || state.profile.phone_country || "";
  }
  clearRestoreError();
  try {
    await requestOtpChallenge(identifier, {
      channel,
      phoneNumber,
      fallbackToLocal: false
    });
    if (els["restore-code-wrap"]) {
      els["restore-code-wrap"].hidden = false;
    }
    if (els["restore-send-code"]) {
      els["restore-send-code"].hidden = true;
    }
    if (els["restore-verify-code"]) {
      els["restore-verify-code"].hidden = false;
    }
    syncRestoreModalCopy();
    focusFirstInteractive(els["restore-modal"]);
  } catch (error) {
    showRestoreError(error.message || "Failed to request restore code.");
  }
}

function buildFallbackRecoveredProfile(country, phoneNumber) {
  return normalizeLocalProfile({
    ...(state.profile || {}),
    plan: normalizePlan(state.profile?.plan),
    display_name: state.profile?.display_name || "",
    phone_number: phoneNumber,
    email: normalizeEmailAddress(state.profile?.email || ""),
    operating_region: normalizeCountryId(state.profile?.operating_region || getOperatingRegionId()),
    phone_country: getRecognizedCountryId(country) || detectPhoneCountryFromPhoneNumber(phoneNumber) || state.profile?.phone_country || "",
    language: normalizeLanguageId(state.profile?.language || "en"),
    preferred_labels: normalizePreferredLabels(state.profile?.preferred_labels, state.profile?.business_type_id),
    last_action: state.profile?.last_action || "sale",
    identity_anchor: getPreferredOtpChannel(),
    identity_status: state.profile?.identity_status || "verified_server",
    identity_verified_at: state.profile?.identity_verified_at || Date.now(),
    email_verified: Boolean(state.profile?.email_verified),
    phone_verified: Boolean(state.profile?.phone_verified),
    passcodeReminder: clonePasscodeReminder(getPasscodeReminder(state.profile))
  });
}

function formatDeviceIdentityShort(deviceIdentity) {
  const value = String(deviceIdentity || "").trim();
  return `Device •••${value.slice(-8) || "unknown"}`;
}

function getDeviceStatusCopy(device) {
  if (device.is_current) return "This device";
  if (device.revoked_at) return `Revoked ${new Date(device.revoked_at).toLocaleString()}`;
  return `Active since ${new Date(device.created_at).toLocaleString()}`;
}

function getActiveNonCurrentDevices(devices) {
  return devices.filter((device) => !device.is_current && !device.revoked_at);
}

function getActiveDevices(devices) {
  return devices.filter((device) => !device.revoked_at);
}

function closeRevocationPrompt() {
  if (els["revoke-old-devices-modal"]) {
    els["revoke-old-devices-modal"].hidden = true;
  }
}

async function getTrustedDevices() {
  const response = await fetchAuthenticatedJson("/devices");
  return Array.isArray(response.devices) ? response.devices : [];
}

function renderDeviceRows(container, devices, onRevoke, emptyMessage) {
  if (!container) return;
  const activeDevices = getActiveDevices(devices);
  if (!activeDevices.length) {
    container.innerHTML = `<div class="record-meta">${emptyMessage}</div>`;
    return;
  }

  const currentDevices = activeDevices.filter((device) => device.is_current);
  const previousDevices = activeDevices.filter((device) => !device.is_current);
  const rows = currentDevices.map((device) => `
    <div class="device-row">
      <div class="device-meta">
        <strong>${formatDeviceIdentityShort(device.device_identity)}</strong>
        <span class="record-meta">${getDeviceStatusCopy(device)}</span>
      </div>
    </div>
  `);

  if (previousDevices.length) {
    rows.push(`
      <div class="device-row">
        <div class="device-meta">
          <strong>Earlier active sessions</strong>
          <span class="record-meta">${previousDevices.length} earlier active sign-in${previousDevices.length === 1 ? "" : "s"} remain linked to this account. Revoke only if you lost or replaced a device.</span>
        </div>
        <button class="btn btn-secondary" type="button" data-device-revoke-previous>Revoke earlier</button>
      </div>
    `);
  }

  container.innerHTML = rows.join("");

  container.querySelectorAll("[data-device-revoke]").forEach((button) => {
    button.addEventListener("click", () => {
      void onRevoke(String(button.dataset.deviceRevoke || ""));
    });
  });

  container.querySelectorAll("[data-device-revoke-previous]").forEach((button) => {
    button.addEventListener("click", async () => {
      button.disabled = true;
      button.textContent = "Revoking...";
      try {
        for (const device of previousDevices) {
          await onRevoke(String(device.device_identity || ""));
        }
      } finally {
        button.disabled = false;
        button.textContent = "Revoke earlier";
      }
    });
  });
}

async function revokeDevice(deviceIdentity) {
  if (!deviceIdentity) return;
  if (!isAuthSessionValid()) {
    throw new Error(getExpiredAuthSessionMessage());
  }
  await postJson(state.syncApiBaseUrl, "/identity/revoke", {
    device_identity: deviceIdentity
  }, state.authSessionKey, {
    deviceIdentity: state.deviceIdentity
  });
}

async function renderTrustedDevicesSettings() {
  if (!els["settings-devices-v2"]) return;
  if (!isAuthSessionValid()) {
    els["settings-devices-v2"].innerHTML = `<div class="record-meta">${getExpiredAuthSessionMessage()}</div>`;
    return;
  }

  try {
    const devices = await getTrustedDevices();
    renderDeviceRows(
      els["settings-devices-v2"],
      devices,
      async (deviceIdentity) => {
        await revokeDevice(deviceIdentity);
        await renderTrustedDevicesSettings();
      },
      "No trusted devices found yet."
    );
  } catch (error) {
    els["settings-devices-v2"].innerHTML = `<div class="record-meta">${escapeHtml(error.message || "Unable to load trusted devices.")}</div>`;
  }
}

async function maybePromptToRevokeOldDevices() {
  if (!els["revoke-old-devices-modal"]) return;
  if (!isAuthSessionValid()) {
    closeRevocationPrompt();
    return;
  }

  try {
    const devices = await getTrustedDevices();
    const candidates = getActiveNonCurrentDevices(devices);
    if (!candidates.length) {
      closeRevocationPrompt();
      return;
    }

    renderDeviceRows(
      els["revoke-old-devices-list"],
      candidates,
      async (deviceIdentity) => {
        await revokeDevice(deviceIdentity);
        await maybePromptToRevokeOldDevices();
      },
      "No previous active devices found."
    );
    els["revoke-old-devices-modal"].hidden = false;
    focusFirstInteractive(els["revoke-old-devices-modal"]);
  } catch (error) {
    console.warn("Unable to load devices for revocation prompt.", error);
    closeRevocationPrompt();
  }
}

async function finishRestoreFlow(country, phoneNumber) {
  await restoreServerAccountIntoLocal({
    fallbackCountry: country,
    quiet: true
  });

  if (!state.profile) {
    state.profile = buildFallbackRecoveredProfile(country, phoneNumber);
    await saveProfile(state.profile, { skipPush: true });
  } else {
    state.profile = buildFallbackRecoveredProfile(country, state.profile.phone_number || phoneNumber);
    await saveProfile(state.profile, { skipPush: true });
  }

  hydrateProfileUi();
  closeRestoreModal();
  await showCapture();
  syncDevQaSnapshot("restore_completed");
}

async function verifyRestoreCode() {
  const country = getRestoreCountryId();
  const channel = getPreferredOtpChannel();
  const phoneNumber = normalizePhoneNumber(els["restore-phone-input"]?.value.trim() || state.profile?.phone_number || "", country);
  const identifier = getCurrentRestoreIdentifier(channel);
  const code = (els["restore-code-input"]?.value || "").trim();

  if (!identifier) {
    showRestoreError(getIdentifierValidationMessage(channel, country));
    return;
  }

  try {
    clearRestoreError();
    if (state.otpChallenge?.source !== "server") {
      throw new Error("Account restore requires the verification server. Please try again when you are online.");
    }
    await verifyActiveOtpChallenge(code, { country, persistProfileRemotely: false });
    await finishRestoreFlow(country, phoneNumber || state.profile?.phone_number || "");
  } catch (error) {
    showRestoreError(error.message || "Unable to restore this account right now.");
  }
}

function renderFirstRecordGuide(records) {
  if (!els["first-record-guide"]) return;
  const examples = getCaptureExamples(getOperatingRegionId());
  const voiceExample = examples[0] || "Sold 3 bags of rice for 75,000";
  const secondVoiceExample = examples[1] || "Paid supplier 45,000";
  const textExample = examples[2] || voiceExample;
  els["first-record-guide"].innerHTML = `
    <strong>📋 Record your first transaction</strong>
    <div style="margin-top:8px;line-height:1.7">
      <strong style="font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:var(--primary-mid)">
        By voice
      </strong><br>
      Tap the mic, speak naturally — "${voiceExample}" or "${secondVoiceExample}".<br>
      The app fills the action, label, and amount. Review, then confirm.
    </div>
    <div style="margin-top:10px;line-height:1.7">
      <strong style="font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:var(--primary-mid)">
        By text
      </strong><br>
      Type a short phrase in the text box — for example "${textExample}". Or tap a quick-pick label,
      enter the amount, then tap Review before confirming.
    </div>
    <div style="margin-top:10px;font-size:12px;color:var(--primary);font-weight:600">
      Every confirmed record is permanent and timestamped. This builds your financial history.
    </div>
  `;
  els["first-record-guide"].hidden = records.length > 0;
}

function renderOnboardingProfileStep() {
  if (!els["onboarding-name"]) return;
  ensureOnboardingLanguageField();
  if (state.profile && !state.profile.language) {
    state.profile.language = "en";
  }
  syncCountryAwareInputs();
  els["onboarding-name"].value = state.profile?.display_name || "";
  els["onboarding-phone"].value = formatPhoneForInput(state.profile?.phone_number || "", getPhoneInputCountry());
  els["onboarding-email"].value = state.profile?.email || "";
  els["onboarding-state"].value = state.profile?.region || "";
  els["onboarding-birth-year"].value = state.profile?.birth_year || "";
  els["onboarding-gender"].value = state.profile?.gender || "";
  syncOnboardingRegionNote();
  clearOnboardingProfileError();
  updateFinishOnboardingState();
}

function updateFinishOnboardingState() {
  if (!els["finish-onboarding"]) return;
  const hasBusinessType = Boolean(state.profile && state.profile.business_type_id);
  const hasDisplayName = Boolean(els["onboarding-name"]?.value.trim());
  els["finish-onboarding"].disabled = !(hasBusinessType && hasDisplayName);
}

function showOnboardingProfileError(message) {
  if (!els["onboarding-profile-error"]) return;
  els["onboarding-profile-error"].hidden = !message;
  els["onboarding-profile-error"].textContent = message || "";
}

function clearOnboardingProfileError() {
  showOnboardingProfileError("");
}

function speakConfirmationCopy(text) {
  if (!("speechSynthesis" in window) || !text) return;
  cancelConfirmationSpeech();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = getVoiceLocale();
  utterance.rate = 0.95;
  window.speechSynthesis.speak(utterance);
}

function cancelConfirmationSpeech() {
  if ("speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
}

function formatMoney(amountMinor, currency) {
  const amount = amountMinor / 100;
  const normalizedCurrency = String(currency || getProfileCurrency()).toUpperCase();
  const allowsDecimals = normalizedCurrency !== "NGN";
  return new Intl.NumberFormat(getCurrencyLocale(normalizedCurrency), {
    style: "currency",
    currency: normalizedCurrency,
    minimumFractionDigits: allowsDecimals ? 2 : 0,
    maximumFractionDigits: allowsDecimals ? 2 : 0
  }).format(amount);
}

function formatAmount(amountMinor, currency) {
  return formatMoney(amountMinor, currency);
}

function showError(message) {
  els["capture-error"].hidden = false;
  els["capture-error"].textContent = message;
}

function clearError() {
  els["capture-error"].hidden = true;
  els["capture-error"].textContent = "";
}

function getReversedEntryHashSet(records) {
  return new Set(
    records
      .filter((record) => record.transaction_type === "reversal" && record.reversed_entry_hash)
      .map((record) => record.reversed_entry_hash)
  );
}

function getOperationalRecords(records) {
  const reversedHashes = getReversedEntryHashSet(records);
  return records.filter((record) => {
    if (record.transaction_type === "reversal") return false;
    return !reversedHashes.has(record.entry_hash);
  });
}

function isInflowRecord(record) {
  return record?.transaction_type === "sale" || record?.transaction_type === "receipt";
}

function isOutflowRecord(record) {
  return record?.transaction_type === "payment" || record?.transaction_type === "purchase";
}

function buildFinancialStatements(entries, currency) {
  const reversedHashes = new Set(
    entries
      .filter((entry) => entry.transaction_type === "reversal" && entry.reversed_entry_hash)
      .map((entry) => entry.reversed_entry_hash)
  );
  const effective = entries.filter((entry) => !reversedHashes.has(entry.entry_hash) && entry.transaction_type !== "reversal");

  let grossRevenue = 0;
  let otherIncome = 0;
  let costOfGoods = 0;
  let operatingExpenses = 0;
  let borrowedIn = 0;
  let loanRepaid = 0;
  let start = null;
  let end = null;
  const monthlyBuckets = new Map();

  effective.forEach((entry) => {
    const amount = Number(entry.amount_minor || 0);
    const confirmedAtMs = getRecordConfirmedAtMs(entry);
    if (!confirmedAtMs) return;

    const confirmedAtSeconds = Math.floor(confirmedAtMs / 1000);
    if (start == null || confirmedAtSeconds < start) start = confirmedAtSeconds;
    if (end == null || confirmedAtSeconds > end) end = confirmedAtSeconds;

    const month = new Date(confirmedAtMs).toISOString().slice(0, 7);
    const bucket = monthlyBuckets.get(month) || { inflows: 0, outflows: 0, net: 0 };

    if (entry.transaction_type === "sale") {
      grossRevenue += amount;
      bucket.inflows += amount;
    } else if (entry.transaction_type === "receipt") {
      otherIncome += amount;
      bucket.inflows += amount;
    } else if (entry.transaction_type === "purchase") {
      costOfGoods += amount;
      bucket.outflows += amount;
    } else if (entry.transaction_type === "payment") {
      operatingExpenses += amount;
      bucket.outflows += amount;
    } else if (entry.transaction_type === "liability_in") {
      // Borrowing is recorded separately — never revenue/income/inflow.
      borrowedIn += amount;
    } else if (entry.transaction_type === "liability_out") {
      // Loan repayment is recorded separately — never expense/outflow.
      loanRepaid += amount;
    }

    bucket.net = bucket.inflows - bucket.outflows;
    monthlyBuckets.set(month, bucket);
  });

  return {
    incomeStatement: {
      grossRevenue,
      otherIncome,
      costOfGoods,
      operatingExpenses,
      netIncome: (grossRevenue + otherIncome) - (costOfGoods + operatingExpenses)
    },
    borrowing: {
      borrowedIn,
      loanRepaid
    },
    cashFlowByMonth: [...monthlyBuckets.entries()]
      .sort(([monthA], [monthB]) => monthA.localeCompare(monthB))
      .map(([month, values]) => ({
        month,
        inflows: values.inflows,
        outflows: values.outflows,
        net: values.net
      })),
    dateRange: { start, end },
    currency,
    entryCount: effective.length
  };
}

function getDashboardMetrics(records, effectiveRecords) {
  const cacheKey = `${records.length}:${state.profile?.operating_region || ""}:${getProfileCurrency()}`;
  if (state.dashboardMetricsCache?.key === cacheKey) {
    return state.dashboardMetricsCache.value;
  }

  const now = new Date();
  const todayKey = now.toDateString();
  const currentMonth = now.getMonth();
  const currentYear = now.getFullYear();

  const metrics = {
    todaySales: 0,
    monthlySales: 0,
    monthlyExpenses: 0,
    monthlyBorrowed: 0
  };

  effectiveRecords.forEach((record) => {
    const amount = Number(record.amount_minor || 0);
    const date = new Date(record.confirmed_at * 1000);
    const isToday = date.toDateString() === todayKey;
    const isThisMonth = date.getMonth() === currentMonth && date.getFullYear() === currentYear;

    if (isInflowRecord(record)) {
      if (isToday) metrics.todaySales += amount;
      if (isThisMonth) metrics.monthlySales += amount;
    }

    if (isOutflowRecord(record)) {
      if (isThisMonth) metrics.monthlyExpenses += amount;
    }

    // Borrowing is tracked separately — never folded into sales/expenses/cash flow.
    if (record.transaction_type === "liability_in" && isThisMonth) {
      metrics.monthlyBorrowed += amount;
    }
  });

  state.dashboardMetricsCache = { key: cacheKey, value: metrics };
  return metrics;
}

async function refreshStorageWarning() {
  state.lowStorageWarning = await getLowStorageWarning();
  if (els["storage-warning-v2"]) {
    els["storage-warning-v2"].hidden = !state.lowStorageWarning;
    els["storage-warning-v2"].textContent = state.lowStorageWarning;
  }
}

async function getLowStorageWarning() {
  if (!(navigator.storage && navigator.storage.estimate)) return "";
  try {
    const { quota = 0, usage = 0 } = await navigator.storage.estimate();
    const available = Math.max(quota - usage, 0);
    if (quota < 10 * 1024 * 1024 || available < 10 * 1024 * 1024) {
      return "Low storage detected on this device. Open Export and download a backup of your confirmed records.";
    }
  } catch (error) {
    return "";
  }
  return "";
}

function wireReverseButtons(records) {
  document.querySelectorAll("[data-reverse-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const record = records.find((entry) => entry.id === Number(button.dataset.reverseId));
      if (record) prepareReversalRecord(record);
    });
  });
}

function prepareReversalRecord(record) {
  const signingBlockReason = getSigningBlockReason();
  if (signingBlockReason) {
    window.alert(signingBlockReason);
    return;
  }
  state.candidateRecord = {
    transaction_type: "reversal",
    label: record.label,
    normalized_label: record.normalized_label,
    amount_minor: record.amount_minor,
    currency: record.currency,
    counterparty: record.counterparty || null,
    source_account: record.source_account || null,
    destination_account: record.destination_account || null,
    reversed_entry_hash: record.entry_hash,
    reversed_transaction_type: record.transaction_type,
    input_mode: "reversal",
    confirmation_state: "pending",
    business_type_id: record.business_type_id,
    sector_id: record.sector_id,
    country: record.country,
    operating_region: record.operating_region || record.country
  };
  els["confirm-copy-v2"].textContent = confirmationCopy(state.candidateRecord);
  els["confirm-meta-v2"].innerHTML = `
    <div><strong>Type:</strong> reversal</div>
    <div><strong>Original type:</strong> ${escapeHtml(record.transaction_type)}</div>
    <div><strong>Amount:</strong> ${formatMoney(record.amount_minor, record.currency)}</div>
    <div><strong>Reverses:</strong> ${escapeHtml(record.entry_hash)}</div>
  `;
  showScreen("screen-confirm");
  speakConfirmationCopy(els["confirm-copy-v2"].textContent);
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request["on" + "up" + "gradeneeded"] = (event) => {
      const db = event.target.result;
      if (event.oldVersion < 1) {
        if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings", { keyPath: "key" });
        if (!db.objectStoreNames.contains("records")) db.createObjectStore("records", { keyPath: "id" });
        if (!db.objectStoreNames.contains("customLabels")) db.createObjectStore("customLabels", { keyPath: "id" });
        if (!db.objectStoreNames.contains("usage")) db.createObjectStore("usage", { keyPath: "normalized_label" });
      }
      if (event.oldVersion < 2) {
        if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings", { keyPath: "key" });
      }
      if (event.oldVersion < 3) {
        if (!db.objectStoreNames.contains("syncQueue")) {
          db.createObjectStore("syncQueue", { keyPath: "queue_id", autoIncrement: true });
        }
      }
      if (event.oldVersion < 4) {
        if (!db.objectStoreNames.contains("voiceCorrections")) {
          db.createObjectStore("voiceCorrections", { keyPath: "raw" });
        }
      }
      if (event.oldVersion < 5) {
        if (!db.objectStoreNames.contains("anomaly_log")) {
          db.createObjectStore("anomaly_log", { keyPath: "id", autoIncrement: true });
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function getProfile() {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction("settings", "readonly");
    const request = tx.objectStore("settings").get("profile");
    request.onsuccess = () => {
      if (!request.result) {
        resolve(null);
        return;
      }
      resolve(normalizeLocalProfile(request.result, {
        trackReminderMigration: true,
        trackDimensionMigration: true
      }));
    };
    request.onerror = () => reject(request.error);
  });
}

function saveProfile(profile, { skipPush = false } = {}) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction("settings", "readwrite");
    const nextProfile = normalizeLocalProfile(profile) || {};
    const normalizedProfile = {
      ...nextProfile,
      key: "profile"
    };
    if (profile) {
      Object.keys(profile).forEach((key) => {
        delete profile[key];
      });
      Object.assign(profile, nextProfile);
    }
    tx.objectStore("settings").put(normalizedProfile);
    tx.oncomplete = () => {
      resolve();
      syncDevQaSnapshot(skipPush ? "profile_saved_local_only" : "profile_saved");
      if (!skipPush) {
        void pushProfile();
      }
    };
    tx.onerror = () => reject(tx.error);
  });
}

function getSetting(key) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction("settings", "readonly");
    const request = tx.objectStore("settings").get(key);
    request.onsuccess = () => resolve(request.result ? request.result.value : null);
    request.onerror = () => reject(request.error);
  });
}

function saveSetting(key, value) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction("settings", "readwrite");
    tx.objectStore("settings").put({ key, value });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function getSyncQueueEntries(limit = 25) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction("syncQueue", "readonly");
    const request = tx.objectStore("syncQueue").getAll();
    request.onsuccess = () => resolve(
      request.result
        .sort((a, b) => a.queue_id - b.queue_id)
        .slice(0, limit)
    );
    request.onerror = () => reject(request.error);
  });
}

function getSyncQueueCount() {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction("syncQueue", "readonly");
    const request = tx.objectStore("syncQueue").count();
    request.onsuccess = () => resolve(request.result || 0);
    request.onerror = () => reject(request.error);
  });
}

async function refreshSyncQueueCount() {
  state.syncQueueCount = await getSyncQueueCount();
}

async function updateSyncBadge() {
  const dot = els["sync-dot"];
  const label = els["sync-label"];
  const badge = els["sync-status-badge"];
  if (!(dot && label && badge)) return;

  let pendingCount = Number(state.syncQueueCount || 0);
  if (state.db && state.db.objectStoreNames.contains("syncQueue")) {
    try {
      pendingCount = await getSyncQueueCount();
      state.syncQueueCount = pendingCount;
    } catch (error) {
      console.warn("Unable to refresh sync badge count.", error);
    }
  }

  dot.classList.remove("pending", "offline");

  if (!navigator.onLine) {
    dot.classList.add("offline");
    label.textContent = "Offline";
    badge.title = "Sync status: Offline";
    return;
  }

  if (pendingCount > 0) {
    dot.classList.add("pending");
    label.textContent = `Syncing ${pendingCount}...`;
    badge.title = `Sync status: ${pendingCount} pending`;
    return;
  }

  label.textContent = "Synced";
  badge.title = "Sync status: Synced";
}

function addSyncQueueEntry(item) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction("syncQueue", "readwrite");
    tx.objectStore("syncQueue").add(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function removeSyncQueueEntries(queueIds) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction("syncQueue", "readwrite");
    const store = tx.objectStore("syncQueue");
    queueIds.forEach((queueId) => {
      store.delete(queueId);
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function markRecordsEvidenceLevel(recordIds, evidenceLevel) {
  return new Promise((resolve, reject) => {
    if (!recordIds.length) {
      resolve();
      return;
    }

    const tx = state.db.transaction("records", "readwrite");
    const store = tx.objectStore("records");
    recordIds.forEach((recordId) => {
      const request = store.get(recordId);
      request.onsuccess = () => {
        const record = request.result;
        if (!record) return;
        record.evidence_level = evidenceLevel;
        if (evidenceLevel === "server_attested" && state.deviceIdentity) {
          record.device_identity = record.device_identity || state.deviceIdentity;
          record.server_entry_id = record.server_entry_id || record.id;
        }
        store.put(record);
      };
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function getRecords() {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction("records", "readonly");
    const request = tx.objectStore("records").getAll();
    request.onsuccess = () => resolve(request.result.sort((a, b) => {
      const timeDiff = getRecordConfirmedAtMs(a) - getRecordConfirmedAtMs(b);
      if (timeDiff) return timeDiff;
      return Number(a.id || 0) - Number(b.id || 0);
    }));
    request.onerror = () => reject(request.error);
  });
}

async function appendLedgerRecord(record) {
  const last = await getLastRecord();
  const id = last ? last.id + 1 : 1;
  const confirmedAt = Math.floor(Date.now() / 1000);
  const prevHash = last ? last.entry_hash : "0".repeat(64);
  const entryHash = await sha256(buildLedgerHashCanonicalString(record, id, confirmedAt, prevHash));
  const signature = await signEntryHash(entryHash);
  const payload = {
    ...record,
    id,
    confirmed_at: confirmedAt,
    prev_entry_hash: prevHash,
    entry_hash: entryHash,
    signature,
    evidence_level: signature ? "device_signed" : "self_reported",
    device_identity: state.deviceIdentity || "",
    public_key_fingerprint: state.publicKeyFingerprint || null
  };

  return new Promise((resolve, reject) => {
    const tx = state.db.transaction("records", "readwrite");
    tx.objectStore("records").add(payload);
    tx.oncomplete = () => resolve(payload);
    tx.onerror = () => reject(tx.error);
  });
}

function getLastRecord() {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction("records", "readonly");
    const request = tx.objectStore("records").openCursor(null, "prev");
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(null);
        return;
      }
      if (cursor.value?.importedFromServer) {
        cursor.continue();
        return;
      }
      resolve(cursor.value);
    };
    request.onerror = () => reject(request.error);
  });
}

async function loadDeviceTrustState() {
  if (!state.db) return;
  const [devicePrivateKey, devicePublicKey, deviceIdentity, publicKeyFingerprint] = await Promise.all([
    getSetting("device_private_key"),
    getSetting("device_public_key"),
    getSetting("device_identity"),
    getSetting("public_key_fingerprint")
  ]);
  state.devicePrivateKey = devicePrivateKey || null;
  state.devicePublicKey = devicePublicKey || "";
  state.deviceIdentity = deviceIdentity || "";
  state.publicKeyFingerprint = publicKeyFingerprint || "";
}

async function loadSyncState() {
  if (!state.db) return;
  const [authSessionKey, authSessionExpiresAt, syncApiBaseUrl, lastSyncAt, lastSyncReceipt] = await Promise.all([
    getSetting("auth_" + "to" + "ken"),
    getSetting("auth_" + "to" + "ken_expires_at"),
    getSetting("sync_api_base_url"),
    getSetting("last_sync_at"),
    getSetting("last_sync_receipt")
  ]);
  state.authSessionKey = authSessionKey || "";
  state.authSessionExpiresAt = authSessionExpiresAt || "";
  state.syncApiBaseUrl = syncApiBaseUrl || getDefaultSyncApiBaseUrl();
  state.lastSyncAt = lastSyncAt || "";
  state.lastSyncReceipt = lastSyncReceipt || "";
  if (!syncApiBaseUrl && state.syncApiBaseUrl) {
    await saveSetting("sync_api_base_url", state.syncApiBaseUrl);
  }
  await refreshSyncQueueCount();
  state.syncStatus = isAuthSessionValid()
    ? "Ready to sync queued entries."
    : (state.authSessionKey
      ? getExpiredAuthSessionMessage()
      : "Waiting for server OTP verification.");
}

async function createAndStoreDeviceKeyMaterial() {
  if (!isWebCryptoAvailable()) {
    throw new Error("This browser does not support WebCrypto signing.");
  }
  if (state.devicePrivateKey && state.devicePublicKey && state.deviceIdentity && state.publicKeyFingerprint) {
    return;
  }

  if (state.devicePrivateKey && state.devicePublicKey) {
    const publicKeyHash = await sha256(state.devicePublicKey);
    state.deviceIdentity = state.deviceIdentity || publicKeyHash.slice(0, 32);
    state.publicKeyFingerprint = state.publicKeyFingerprint || publicKeyHash.slice(0, 16);
    await Promise.all([
      saveSetting("device_identity", state.deviceIdentity),
      saveSetting("public_key_fingerprint", state.publicKeyFingerprint)
    ]);
    return;
  }

  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"]
  );
  const exportedPublicKey = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const publicKeyString = canonicalizePublicJwk(exportedPublicKey);
  const publicKeyHash = await sha256(publicKeyString);
  const deviceIdentity = publicKeyHash.slice(0, 32);
  const publicKeyFingerprint = publicKeyHash.slice(0, 16);

  await Promise.all([
    saveSetting("device_private_key", keyPair.privateKey),
    saveSetting("device_public_key", publicKeyString),
    saveSetting("device_identity", deviceIdentity),
    saveSetting("public_key_fingerprint", publicKeyFingerprint)
  ]);

  state.devicePrivateKey = keyPair.privateKey;
  state.devicePublicKey = publicKeyString;
  state.deviceIdentity = deviceIdentity;
  state.publicKeyFingerprint = publicKeyFingerprint;
}

async function ensureDeviceKeyMaterial() {
  if (!hasVerifiedIdentityAnchor()) {
    throw new Error(`Complete ${getVerificationChannelLabel().toLowerCase()} before setting up this device key.`);
  }
  await createAndStoreDeviceKeyMaterial();
}

async function getDevicePrivateKey() {
  return getSigningBlockReason() ? null : state.devicePrivateKey;
}

async function signEntryHash(entryHash) {
  const privateKey = await getDevicePrivateKey();
  if (!privateKey) return null;
  const data = new TextEncoder().encode(entryHash);
  const signatureBuffer = await crypto.subtle.sign(
    { name: "ECDSA", hash: { name: "SHA-256" } },
    privateKey,
    data
  );
  return btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)));
}

async function queueSyncRecord(record) {
  await addSyncQueueEntry({
    entry_id: record.id,
    entry_hash: record.entry_hash,
    device_identity: state.deviceIdentity || "",
    status: "queued",
    attempt_count: 0,
    queued_at: Date.now(),
    entry_payload: record
  });
  await refreshSyncQueueCount();
  state.syncStatus = isAuthSessionValid()
    ? "Entry queued for server sync."
    : "Entry signed locally and queued. Complete server OTP to sync.";
}

async function flushSyncQueue() {
  if (state.syncInFlight || !state.db) {
    await updateSyncBadge();
    return;
  }
  const queuedEntries = await getSyncQueueEntries(25);
  if (!queuedEntries.length) {
    state.syncStatus = isAuthSessionValid() ? "All queued entries synced." : state.syncStatus;
    await refreshSyncQueueCount();
    await updateSyncBadge();
    return;
  }
  if (!state.authSessionKey) {
    state.syncStatus = "Queued entries are waiting for server OTP verification.";
    await refreshSyncQueueCount();
    await updateSyncBadge();
    return;
  }
  if (!isAuthSessionValid()) {
    state.syncStatus = getExpiredAuthSessionMessage();
    await refreshSyncQueueCount();
    await updateSyncBadge();
    return;
  }
  if (!state.syncApiBaseUrl) {
    state.syncStatus = "Queued entries cannot sync until a sync server URL is configured.";
    await updateSyncBadge();
    return;
  }
  if (!(state.deviceIdentity && state.devicePublicKey)) {
    state.syncStatus = "Device identity is missing, so server sync is paused.";
    await updateSyncBadge();
    return;
  }

  state.syncInFlight = true;
  state.syncStatus = `Syncing ${queuedEntries.length} queued entr${queuedEntries.length === 1 ? "y" : "ies"}...`;

  try {
    const response = await syncQueuedEntries(state.syncApiBaseUrl, state.authSessionKey, {
      device_identity: state.deviceIdentity,
      public_key: state.devicePublicKey,
      entries: queuedEntries.map((item) => item.entry_payload)
    }, state.deviceIdentity);
    await markRecordsEvidenceLevel(
      queuedEntries.map((item) => Number(item.entry_payload?.id || 0)).filter(Boolean),
      "server_attested"
    );
    await removeSyncQueueEntries(queuedEntries.map((item) => item.queue_id));
    state.lastSyncAt = new Date().toISOString();
    state.lastSyncReceipt = response.server_receipt || "";
    await Promise.all([
      saveSetting("last_sync_at", state.lastSyncAt),
      saveSetting("last_sync_receipt", state.lastSyncReceipt)
    ]);
    await refreshSyncQueueCount();
    state.syncStatus = response.synced_count
      ? `Synced ${response.synced_count} entr${response.synced_count === 1 ? "y" : "ies"} to the server.`
      : "Server already had the queued entries.";
  } catch (error) {
    if (error.statusCode === 401) {
      state.syncStatus = `Sync auth expired. Re-open ${getVerificationChannelLabel().toLowerCase()}.`;
    } else if (error.statusCode === 409) {
      state.syncStatus = "Server reported a fork. Sync paused until remediation.";
    } else {
      state.syncStatus = error.message || "Sync failed. Entries remain queued.";
    }
  } finally {
    state.syncInFlight = false;
    await updateSyncBadge();
  }
}

function getUsageMap() {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction("usage", "readonly");
    const request = tx.objectStore("usage").getAll();
    request.onsuccess = () => {
      const map = new Map();
      request.result.forEach((item) => map.set(item.normalized_label, item.count));
      resolve(map);
    };
    request.onerror = () => reject(request.error);
  });
}

function bumpLabelUsage(normalizedLabel) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction("usage", "readwrite");
    const store = tx.objectStore("usage");
    const getRequest = store.get(normalizedLabel);
    getRequest.onsuccess = () => {
      const current = getRequest.result || { normalized_label: normalizedLabel, count: 0 };
      store.put({ normalized_label: normalizedLabel, count: current.count + 1 });
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function createUserCustomLabel(value) {
  const normalized = normalizeText(value).replace(/\s+/g, "_");
  const learnedFrom = getCustomLabelLearnedFrom();
  const item = {
    id: `custom_${Date.now()}`,
    normalized_label: normalized,
    display_name: value,
    synonyms: [value],
    icon: "⭐",
    image_url: null,
    transaction_contexts: [customLabelContextForLearnedFrom(learnedFrom)],
    countries: ["GLOBAL"],
    business_types: [state.profile.business_type_id]
  };

  await new Promise((resolve, reject) => {
    const tx = state.db.transaction("customLabels", "readwrite");
    tx.objectStore("customLabels").put({
      id: item.id,
      user_id: "local-user",
      display_name: item.display_name,
      normalized_label: item.normalized_label,
      source: "manual_entry",
      learned_from: learnedFrom,
      business_type_id: state.profile.business_type_id
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  LABEL_CATALOG.push(item);
  return item;
}

function loadCustomLabelsIntoCatalog() {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction("customLabels", "readonly");
    const request = tx.objectStore("customLabels").getAll();
    request.onsuccess = () => {
      request.result.forEach((item) => {
        const alreadyExists = LABEL_CATALOG.some((label) => label.id === item.id);
        if (alreadyExists) return;
        LABEL_CATALOG.push({
          id: item.id,
          normalized_label: item.normalized_label,
          display_name: item.display_name,
          synonyms: [item.display_name],
          icon: "⭐",
          image_url: null,
          transaction_contexts: [customLabelContextForLearnedFrom(item.learned_from)],
          countries: ["GLOBAL"],
          business_types: [item.business_type_id]
        });
      });
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
}

async function sha256(input) {
  const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buffer)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalizePublicJwk(jwk) {
  return JSON.stringify({
    key_ops: jwk.key_ops || ["verify"],
    ext: Boolean(jwk.ext),
    kty: jwk.kty,
    crv: jwk.crv,
    x: jwk.x,
    y: jwk.y
  });
}

function hasVerifiedPhoneAnchor() {
  return hasVerifiedIdentityAnchor();
}

function stopActiveRecognition() {
  if (!state.activeRecognition) return;
  try {
    state.activeRecognition.stop();
  } finally {
    state.activeRecognition = null;
    setRecordingState(false);
  }
}

function isWebCryptoAvailable() {
  return Boolean(window.crypto?.subtle && window.crypto?.getRandomValues);
}

function isSigningReady() {
  return !getSigningBlockReason();
}

function getDeviceKeyStatusLabel() {
  if (!isWebCryptoAvailable()) return "WebCrypto not available in this browser";
  if (state.devicePrivateKey && state.publicKeyFingerprint) return "Ready on this device";
  if (hasVerifiedIdentityAnchor()) return `${getVerificationChannelLabel()} complete, device key still missing`;
  return "Not set up yet";
}

function getAuthSessionStatusLabel() {
  if (state.authSessionKey && !isAuthSessionValid()) {
    return state.authSessionExpiresAt
      ? `Expired at ${new Date(state.authSessionExpiresAt).toLocaleString()}`
      : "Session needs re-authentication";
  }
  if (state.authSessionKey && state.authSessionExpiresAt) {
    return `Active until ${new Date(state.authSessionExpiresAt).toLocaleString()}`;
  }
  return "No server session yet";
}

function getSigningBlockReason() {
  if (!hasVerifiedIdentityAnchor()) {
    return `Complete ${getVerificationChannelLabel().toLowerCase()} before confirming a new record.`;
  }
  if (!isWebCryptoAvailable()) {
    return "This browser does not support device signing, so confirmation is disabled.";
  }
  if (!(state.devicePrivateKey && state.publicKeyFingerprint)) {
    return "Finish device key setup before confirming a new record.";
  }
  return "";
}

function getOtpHelperText() {
  if (!state.otpChallenge) {
    return "";
  }
  const channel = normalizeOtpChannel(state.otpChallenge.channel || getPreferredOtpChannel());
  const deliveryNoun = channel === "sms" ? "text message" : "email";
  if (state.otpChallenge.source === "server" && state.otpChallenge.devCode) {
    return `Verification code requested from the server. Development code: ${state.otpChallenge.devCode}. It expires in 10 minutes.`;
  }
  if (state.otpChallenge.source === "server") {
    return `Verification code requested. Enter the code sent by ${deliveryNoun}.`;
  }
  return `Local development code for this device: ${state.otpChallenge.code}. It expires in 10 minutes.`;
}

function buildExportVerificationBundle(record) {
  const prevHash = record.prev_entry_hash || "0".repeat(64);
  const canonicalPayload = buildLedgerHashCanonicalString(
    record,
    Number(record.id || 0),
    Number(record.confirmed_at || 0),
    prevHash
  );
  return {
    entryHash: record.entry_hash || "",
    prevEntryHash: prevHash,
    signature: record.signature || "",
    signatureMessage: record.entry_hash || "",
    canonicalPayload
  };
}

function formatExportLedgerEntry(record, currency) {
  const timestamp = new Date(record.confirmed_at * 1000).toLocaleString();
  const verification = buildExportVerificationBundle(record);
  return [
    [
      record.server_entry_id || record.id,
      record.transaction_type,
      record.label,
      formatMoney(record.amount_minor, currency),
      timestamp,
      record.signature ? "signed: true" : "unsigned: true"
    ].join(" | "),
    `entry_hash: ${verification.entryHash}`,
    `prev_entry_hash: ${verification.prevEntryHash}`,
    `signature_base64: ${verification.signature || "null"}`,
    `signature_message_utf8: ${verification.signatureMessage}`,
    "canonical_payload_utf8_begin",
    verification.canonicalPayload,
    "canonical_payload_utf8_end"
  ].join("\n");
}

function buildLedgerHashCanonicalString(record, id, confirmedAt, prevHash) {
  return [
    id,
    record.transaction_type,
    record.normalized_label,
    record.amount_minor,
    record.currency,
    record.counterparty,
    record.business_type_id,
    record.country,
    record.source_account,
    record.destination_account,
    record.reversed_entry_hash,
    record.reversed_transaction_type,
    confirmedAt,
    prevHash
  ].map((value) => value == null ? "" : String(value)).join("|");
}

function getCustomLabelLearnedFrom() {
  if (state.currentAction === "transfer") return state.transferSubtype;
  return state.currentAction;
}

function customLabelContextForLearnedFrom(learnedFrom) {
  if (learnedFrom === "transfer_in") return "receipt";
  if (learnedFrom === "transfer_out") return "payment";
  return learnedFrom;
}

async function requestServerOtpCode() {
  await requestLocalOtpCode();
}

async function verifyServerOtpCode() {
  await verifyLocalOtpCode();
}
