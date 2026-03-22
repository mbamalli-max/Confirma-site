const DB_NAME = "confirma-v2-db";
const DB_VERSION = 1;
const FEATURE_TRANSFER_PRIMARY = false;

const SECTORS = [
  { id: "trade_retail", name: "Trade & Retail", icon: "🛍️" },
  { id: "food_hospitality", name: "Food & Hospitality", icon: "🍲" },
  { id: "transport_logistics", name: "Transport & Logistics", icon: "🚌" },
  { id: "skilled_construction", name: "Skilled Work & Construction", icon: "🔧" },
  { id: "personal_professional", name: "Personal & Professional Services", icon: "💼" },
  { id: "digital_online", name: "Digital & Online Business", icon: "💻" }
];

const COUNTRIES = [
  { id: "NG", name: "Nigeria", icon: "🇳🇬" },
  { id: "US", name: "United States", icon: "🇺🇸" }
];

const BUSINESS_TYPES = [
  { id: "ng_market_trader", country: "NG", sector_id: "trade_retail", name: "Market Trader", icon: "🧺" },
  { id: "ng_provision_shop", country: "NG", sector_id: "trade_retail", name: "Provision Shop", icon: "🏪" },
  { id: "ng_food_vendor", country: "NG", sector_id: "food_hospitality", name: "Food Vendor", icon: "🍛" },
  { id: "ng_transport_operator", country: "NG", sector_id: "transport_logistics", name: "Transport Operator", icon: "🛺" },
  { id: "ng_artisan", country: "NG", sector_id: "skilled_construction", name: "Artisan", icon: "🛠️" },
  { id: "ng_service_provider", country: "NG", sector_id: "personal_professional", name: "Service Provider", icon: "🧾" },
  { id: "ng_online_seller", country: "NG", sector_id: "digital_online", name: "Online Seller", icon: "📱" },
  { id: "us_retail", country: "US", sector_id: "trade_retail", name: "Retail", icon: "🛍️" },
  { id: "us_food_service", country: "US", sector_id: "food_hospitality", name: "Food Service", icon: "🍔" },
  { id: "us_logistics", country: "US", sector_id: "transport_logistics", name: "Logistics", icon: "🚚" },
  { id: "us_contractor", country: "US", sector_id: "skilled_construction", name: "Contractor", icon: "🔨" },
  { id: "us_beauty_services", country: "US", sector_id: "personal_professional", name: "Beauty Services", icon: "💇" },
  { id: "us_digital_business", country: "US", sector_id: "digital_online", name: "Digital Business", icon: "🧑‍💻" }
];

const LABEL_CATALOG = [
  buildLabel("inventory_rice", "Rice", "🌾", ["bag of rice", "rice stock"], ["sale", "purchase"], ["NG"], ["ng_market_trader", "ng_provision_shop"]),
  buildLabel("inventory_beans", "Beans", "🫘", ["bean", "beans stock"], ["sale", "purchase"], ["NG"], ["ng_market_trader", "ng_provision_shop"]),
  buildLabel("inventory_palm_oil", "Palm Oil", "🫒", ["red oil", "palm kernel oil"], ["sale", "purchase"], ["NG"], ["ng_market_trader"]),
  buildLabel("inventory_provisions", "Provisions", "🧴", ["shop items", "provision"], ["sale", "purchase"], ["NG"], ["ng_provision_shop"]),
  buildLabel("meal_jollof", "Jollof Rice", "🍚", ["jollof", "rice plate"], ["sale"], ["NG"], ["ng_food_vendor"]),
  buildLabel("meal_soup", "Soup", "🥣", ["pepper soup", "soup bowl"], ["sale"], ["NG"], ["ng_food_vendor"]),
  buildLabel("ingredient_purchase", "Ingredients", "🧄", ["ingredient", "food stuff"], ["purchase", "payment"], ["NG", "US"], ["ng_food_vendor", "us_food_service"]),
  buildLabel("cooking_gas", "Cooking Gas", "🔥", ["gas refill", "cylinder gas"], ["payment"], ["NG", "US"], ["ng_food_vendor", "us_food_service"]),
  buildLabel("trip_fare", "Trip Fare", "🚌", ["transport fare", "ride fare"], ["sale", "receipt"], ["NG"], ["ng_transport_operator"]),
  buildLabel("delivery_fee", "Delivery Fee", "📦", ["dispatch fee", "delivery charge"], ["sale", "receipt"], ["NG", "US"], ["ng_transport_operator", "us_logistics", "us_digital_business"]),
  buildLabel("vehicle_fuel", "Vehicle Fuel", "⛽", ["petrol", "diesel", "gas for car"], ["payment"], ["NG", "US"], ["ng_transport_operator", "us_logistics"]),
  buildLabel("vehicle_repairs", "Vehicle Repairs", "🛞", ["repair", "mechanic"], ["payment"], ["NG", "US"], ["ng_transport_operator", "us_logistics"]),
  buildLabel("labour_income", "Labour", "🪚", ["hand work", "job labour"], ["sale", "receipt"], ["NG", "US"], ["ng_artisan", "us_contractor"]),
  buildLabel("materials_purchase", "Materials", "🧱", ["building materials", "raw materials"], ["purchase", "payment"], ["NG", "US"], ["ng_artisan", "us_contractor"]),
  buildLabel("tools_purchase", "Tools", "🧰", ["tool", "equipment tool"], ["purchase", "payment"], ["NG", "US"], ["ng_artisan", "us_contractor"]),
  buildLabel("consultation_fee", "Consultation", "🗂️", ["consulting", "advice fee"], ["sale", "receipt"], ["NG", "US"], ["ng_service_provider", "us_beauty_services", "us_digital_business"]),
  buildLabel("data_internet", "Data / Internet", "📶", ["data", "internet"], ["payment"], ["NG", "US"], ["ng_service_provider", "ng_online_seller", "us_digital_business"]),
  buildLabel("online_products", "Products", "📦", ["items", "online goods"], ["sale", "purchase"], ["NG", "US"], ["ng_online_seller", "us_digital_business"]),
  buildLabel("online_packaging", "Packaging", "📮", ["package", "wrap"], ["purchase", "payment"], ["NG", "US"], ["ng_online_seller", "us_retail", "us_digital_business"]),
  buildLabel("online_ads", "Ads", "📣", ["advert", "promotion"], ["payment"], ["NG", "US"], ["ng_online_seller", "us_digital_business"]),
  buildLabel("online_delivery", "Shipping Charged", "🛵", ["delivery charged", "shipping fee"], ["sale", "receipt"], ["NG", "US"], ["ng_online_seller", "us_digital_business"]),
  buildLabel("online_shipping_cost", "Shipping Cost", "🚚", ["dispatch cost", "courier cost"], ["payment", "purchase"], ["NG", "US"], ["ng_online_seller", "us_logistics", "us_digital_business"]),
  buildLabel("online_platform_fees", "Platform Fees", "🧾", ["marketplace fee", "listing fee"], ["payment"], ["NG", "US"], ["ng_online_seller", "us_digital_business"]),
  buildLabel("products", "Products", "🛒", ["items", "goods"], ["sale", "purchase"], ["US"], ["us_retail", "us_digital_business"]),
  buildLabel("shipping_costs", "Shipping Costs", "🚚", ["postage", "courier"], ["payment", "purchase"], ["US"], ["us_retail", "us_logistics", "us_digital_business"]),
  buildLabel("software_subscription", "Software", "💻", ["software subscription", "saas"], ["payment"], ["US"], ["us_digital_business"]),
  buildLabel("platform_fees", "Platform Fees", "🧾", ["marketplace fee", "listing fee"], ["payment"], ["US"], ["us_digital_business"]),
  buildLabel("service_treatment", "Treatment", "✨", ["service treatment", "beauty treatment"], ["sale", "receipt"], ["US"], ["us_beauty_services"]),
  buildLabel("inventory_purchase", "Wholesale Purchase", "📦", ["stock purchase", "inventory"], ["purchase"], ["NG"], ["ng_market_trader", "ng_provision_shop"]),
  buildLabel("cash_receipt", "Cash Received", "💵", ["money received", "cash in"], ["receipt"], ["NG", "US"], ["ng_service_provider", "us_retail", "us_food_service"]),
  buildLabel("rent_payment", "Rent", "🏠", ["shop rent", "stall rent"], ["payment"], ["NG", "US"], ["ng_provision_shop", "ng_service_provider", "us_retail"]),
  buildLabel("transfer_between_accounts", "Transfer", "🔁", ["move money", "internal transfer"], ["transfer"], ["NG", "US"], BUSINESS_TYPES.map((item) => item.id))
];

const PRIMARY_ACTIONS = [
  { id: "sale", label: "Sell", icon: "🟢", help: "Business sells goods or services." },
  { id: "purchase", label: "Buy", icon: "🛒", help: "Business buys stock or inputs." },
  { id: "payment", label: "Pay", icon: "💸", help: "Business pays money out." },
  { id: "receipt", label: "Receive", icon: "💰", help: "Business receives money in." }
];

const TRANSFER_ACTIONS = [
  { id: "transfer_in", label: "Transfer In", icon: "⬇️", help: "Move money into this store of value." },
  { id: "transfer_out", label: "Transfer Out", icon: "⬆️", help: "Move money out to another store of value." }
];

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
  speechResults: []
};

const els = {};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  cacheElements();
  state.db = await openDb();
  await loadCustomLabelsIntoCatalog();
  state.profile = await getProfile();
  wireEvents();
  registerPwa();
  renderOnboarding();
  renderActionRows();

  if (state.profile) {
    hydrateProfileUi();
    await showCapture();
  } else {
    showScreen("screen-onboarding");
  }
}

function cacheElements() {
  [
    "country-grid", "sector-grid", "business-grid", "onboarding-step-copy", "finish-onboarding",
    "business-helper", "profile-summary", "primary-actions", "advanced-panel", "transfer-actions",
    "quick-label-grid", "selected-label-chip", "amount-input-v2", "counterparty-input-v2", "source-account-input",
    "destination-account-input", "transfer-details", "capture-error", "confirm-copy-v2", "confirm-meta-v2",
    "recent-records-v2", "history-records-v2", "selector-modal", "label-search-input", "search-results",
    "speech-results", "browse-results", "speech-status", "custom-label-input", "onboarding-back",
    "change-confirm-modal"
  ].forEach((id) => {
    els[id] = document.getElementById(id);
  });
}

function wireEvents() {
  document.getElementById("finish-onboarding").addEventListener("click", finishOnboarding);
  document.getElementById("change-profile").addEventListener("click", openChangeProfileConfirm);
  document.getElementById("confirm-change-profile").addEventListener("click", confirmChangeProfile);
  document.getElementById("cancel-change-profile").addEventListener("click", closeChangeProfileConfirm);
  document.getElementById("change-confirm-close").addEventListener("click", closeChangeProfileConfirm);
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
  document.getElementById("open-history").addEventListener("click", async () => {
    await renderHistory();
    showScreen("screen-history");
  });
  document.getElementById("back-home").addEventListener("click", () => showScreen("screen-capture"));
  document.getElementById("label-search-input").addEventListener("input", () => {
    handleSearch();
  });
  document.getElementById("speak-label-button").addEventListener("click", startSpeechMatch);
  document.getElementById("save-custom-label").addEventListener("click", saveCustomLabel);
  document.querySelectorAll("[data-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      setSelectorMode(button.dataset.mode);
    });
  });
}

function registerPwa() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/app-v2/sw.js");
  }
}

function renderOnboarding() {
  renderCountryGrid();
  renderSectorGrid();
  renderBusinessGrid();
  updateOnboardingStep(state.onboardingStep || 1);
}

function renderCountryGrid() {
  els["country-grid"].innerHTML = "";
  COUNTRIES.forEach((country) => {
    els["country-grid"].appendChild(buildVisualCard(country.icon, country.name, "Country", () => {
      state.profile = {
        country: country.id,
        sector_id: null,
        business_type_id: null,
        last_action: "sale"
      };
      renderSectorGrid();
      renderBusinessGrid();
      updateOnboardingStep(2);
    }, state.profile && state.profile.country === country.id));
  });
}

function renderSectorGrid() {
  els["sector-grid"].innerHTML = "";
  SECTORS.forEach((sector) => {
    els["sector-grid"].appendChild(buildVisualCard(sector.icon, sector.name, "Sector", () => {
      state.profile = {
        ...(state.profile || {}),
        sector_id: sector.id,
        business_type_id: null
      };
      renderBusinessGrid();
      updateOnboardingStep(3);
    }, state.profile && state.profile.sector_id === sector.id));
  });
}

function renderBusinessGrid() {
  els["business-grid"].innerHTML = "";
  const items = getAvailableBusinessTypes();
  const sectorName = state.profile && state.profile.sector_id
    ? SECTORS.find((item) => item.id === state.profile.sector_id)?.name
    : "your selected sector";
  els["business-helper"].textContent = state.profile && state.profile.country
    ? `Showing business types for ${countryName(state.profile.country)} in ${sectorName}.`
    : "Pick a country and sector first.";

  items.forEach((item) => {
    els["business-grid"].appendChild(buildVisualCard(item.icon, item.name, sectorName, () => {
      state.profile = {
        ...state.profile,
        business_type_id: item.id
      };
      renderBusinessGrid();
      updateOnboardingStep(3);
    }, state.profile && state.profile.business_type_id === item.id));
  });
}

function updateOnboardingStep(step) {
  state.onboardingStep = step;
  document.querySelectorAll(".step").forEach((node) => node.classList.remove("active"));
  document.querySelector(`.step[data-step="${state.onboardingStep}"]`).classList.add("active");
  els["onboarding-step-copy"].textContent = `Step ${state.onboardingStep} of 3`;
  els["onboarding-back"].hidden = state.onboardingStep <= 1;
  document.getElementById("finish-onboarding").disabled = !(state.profile && state.profile.business_type_id);
}

function goToPreviousOnboardingStep() {
  if (state.onboardingStep <= 1) return;
  updateOnboardingStep(state.onboardingStep - 1);
}

function buildVisualCard(icon, title, description, onClick, active) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `visual-card${active ? " active" : ""}`;
  button.innerHTML = `<span class="visual-icon">${icon}</span><strong>${title}</strong><span>${description}</span>`;
  button.addEventListener("click", onClick);
  return button;
}

async function finishOnboarding() {
  await saveProfile(state.profile);
  hydrateProfileUi();
  await showCapture();
}

function hydrateProfileUi() {
  const businessType = BUSINESS_TYPES.find((item) => item.id === state.profile.business_type_id);
  const sector = SECTORS.find((item) => item.id === state.profile.sector_id);
  els["profile-summary"].textContent = `${countryName(state.profile.country)} • ${sector?.name || ""} • ${businessType?.name || ""}`;
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
  showScreen("screen-capture");
}

function renderActionRows() {
  const primarySelected = state.currentAction === "transfer" ? null : state.currentAction;
  const transferSelected = state.currentAction === "transfer" ? state.transferSubtype : null;

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
  const ranked = await rankLabels("", { limit: 9 });
  ranked.forEach((item) => {
    els["quick-label-grid"].appendChild(buildRankedLabelButton(item));
  });
  await renderBrowseResults();
}

function buildRankedLabelButton(item) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `ranked-item${state.selectedLabel && state.selectedLabel.id === item.id ? " active" : ""}`;
  button.innerHTML = `<strong>${item.icon || "🏷️"} ${item.display_name}</strong><span>${contextCopy(item)}</span>`;
  button.addEventListener("click", () => selectLabel(item));
  return button;
}

function contextCopy(item) {
  const contexts = item.transaction_contexts.join(", ");
  return `${contexts} • ${item.normalized_label}`;
}

function selectLabel(item) {
  state.selectedLabel = item;
  els["selected-label-chip"].textContent = `${item.icon || "🏷️"} ${item.display_name} selected`;
  renderQuickLabels();
  closeSelector();
}

function clearSelectedLabel() {
  state.selectedLabel = null;
  els["selected-label-chip"].textContent = "No label selected yet.";
}

async function openSelector() {
  els["selector-modal"].hidden = false;
  setSelectorMode("search");
  await handleSearch();
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
  const results = await rankLabels(query, { limit: 12 });
  state.searchResults = results;
  els["search-results"].innerHTML = results.length
    ? results.map(renderRankedItemHtml).join("")
    : `<div class="record-card"><strong>No labels found</strong><div class="record-meta">Try speech, browse all, or add Other.</div></div>`;
  wireRankedButtons("search-results", results);
}

async function renderBrowseResults() {
  const results = await rankLabels("", { limit: 24, includeScore: false });
  state.browseResults = results;
  els["browse-results"].innerHTML = results.map(renderRankedItemHtml).join("");
  wireRankedButtons("browse-results", results);
}

function renderRankedItemHtml(item, index) {
  return `<button type="button" class="ranked-item" data-ranked-id="${item.id}"><strong>${item.icon || "🏷️"} ${item.display_name}</strong><span>${item.normalized_label}</span><small>${item.reason || contextCopy(item)}</small></button>`;
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
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRec) {
    els["speech-status"].textContent = "Speech recognition is not available in this browser.";
    return;
  }

  els["speech-status"].textContent = "Listening...";
  const recognition = new SpeechRec();
  recognition.lang = state.profile.country === "US" ? "en-US" : "en-NG";
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  recognition.onresult = (event) => {
    const utterance = event.results[0][0].transcript;
    rankLabels(utterance, { limit: 5, includeScore: true }).then((results) => {
      state.speechResults = results;
      renderSpeechResults(utterance, results);
    });
  };
  recognition.onerror = () => {
    els["speech-status"].textContent = "Speech capture failed. Try again or use search.";
  };
  recognition.start();
}

function renderSpeechResults(utterance, results) {
  if (!results.length) {
    els["speech-status"].textContent = `No strong match for "${utterance}". Try search, browse all, or Other.`;
    els["speech-results"].innerHTML = "";
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

  els["speech-results"].innerHTML = results.map(renderRankedItemHtml).join("");
  wireRankedButtons("speech-results", results);
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
  const amount = parseMinor(els["amount-input-v2"].value);
  if (!state.selectedLabel) {
    return showError("Pick a label first.");
  }
  if (!amount || amount <= 0) {
    return showError("Enter a valid amount before confirming.");
  }

  const transactionType = state.currentAction === "transfer" ? "transfer" : state.currentAction;
  const record = {
    transaction_type: transactionType,
    label: state.selectedLabel.display_name,
    normalized_label: state.selectedLabel.normalized_label,
    amount_minor: amount,
    currency: state.profile.country === "US" ? "USD" : "NGN",
    counterparty: els["counterparty-input-v2"].value.trim() || null,
    source_account: transactionType === "transfer" ? (els["source-account-input"].value.trim() || null) : null,
    destination_account: transactionType === "transfer" ? (els["destination-account-input"].value.trim() || null) : null,
    input_mode: "visual",
    confirmation_state: "pending",
    business_type_id: state.profile.business_type_id,
    sector_id: state.profile.sector_id,
    country: state.profile.country
  };

  state.candidateRecord = record;
  els["confirm-copy-v2"].textContent = confirmationCopy(record);
  els["confirm-meta-v2"].innerHTML = `
    <div><strong>Type:</strong> ${record.transaction_type}</div>
    <div><strong>Normalized label:</strong> ${record.normalized_label}</div>
    <div><strong>Amount:</strong> ${formatMoney(record.amount_minor, record.currency)}</div>
    <div><strong>Counterparty:</strong> ${record.counterparty || "Not provided"}</div>
  `;
  showScreen("screen-confirm");
}

async function confirmAppend() {
  if (!state.candidateRecord) return;
  const record = {
    ...state.candidateRecord,
    confirmation_state: "confirmed"
  };
  await appendLedgerRecord(record);
  await bumpLabelUsage(record.normalized_label);
  resetCaptureForm();
  await renderRecentRecords();
  showScreen("screen-capture");
}

function resetCaptureForm() {
  state.candidateRecord = null;
  clearSelectedLabel();
  els["amount-input-v2"].value = "";
  els["counterparty-input-v2"].value = "";
  els["source-account-input"].value = "";
  els["destination-account-input"].value = "";
}

async function renderRecentRecords() {
  const records = await getRecords();
  const recent = [...records].reverse().slice(0, 5);
  els["recent-records-v2"].innerHTML = recent.length
    ? recent.map(renderRecordCard).join("")
    : `<div class="record-card"><strong>No confirmed records yet.</strong><div class="record-meta">Start with a visual label, then confirm the transaction.</div></div>`;
}

async function renderHistory() {
  const records = await getRecords();
  els["history-records-v2"].innerHTML = records.length
    ? [...records].reverse().map(renderRecordCard).join("")
    : `<div class="record-card"><strong>No history yet.</strong><div class="record-meta">Nothing has been appended yet.</div></div>`;
}

function renderRecordCard(record) {
  return `
    <div class="record-card">
      <strong>${record.label} • ${record.transaction_type}</strong>
      <div class="record-meta">
        ${formatMoney(record.amount_minor, record.currency)} • ${new Date(record.confirmed_at * 1000).toLocaleString()}<br>
        ${record.normalized_label}${record.counterparty ? ` • ${record.counterparty}` : ""}
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
  return `You are transferring ${amount} for ${record.label}.`;
}

function rankLabels(query, options = {}) {
  const includeScore = options.includeScore !== false;
  const limit = options.limit || 12;
  const catalog = getCatalogForCurrentProfile();
  const usageMapPromise = getUsageMap();

  return usageMapPromise.then((usageMap) => {
    const normalizedQuery = normalizeText(query);
    const ranked = catalog.map((item) => {
      const exact = normalizedQuery && normalizeText(item.display_name) === normalizedQuery ? 1 : 0;
      const synonym = normalizedQuery && item.synonyms.some((synonym) => normalizeText(synonym) === normalizedQuery) ? 1 : 0;
      const partial = normalizedQuery && (normalizeText(item.display_name).includes(normalizedQuery) || item.synonyms.some((synonym) => normalizeText(synonym).includes(normalizedQuery))) ? 1 : 0;
      const businessMatch = item.business_types.includes(state.profile.business_type_id) ? 1 : 0;
      const sectorMatch = businessSectorMatch(item) ? 1 : 0;
      const countryMatch = item.countries.includes(state.profile.country) ? 1 : 0;
      const historyBoost = usageMap.get(item.normalized_label) || 0;
      const score = (exact * 40) + (synonym * 30) + (partial * 16) + (businessMatch * 12) + (sectorMatch * 8) + (countryMatch * 6) + Math.min(historyBoost, 8);
      const confidence = normalizedQuery
        ? Math.min(score / 50, 0.99)
        : Math.min((businessMatch * 0.55) + (sectorMatch * 0.2) + (countryMatch * 0.1) + Math.min(historyBoost, 3) / 10, 0.9);
      const reason = exact ? "Exact match" : synonym ? "Synonym match" : partial ? "Related match" : "Recommended for this business";
      return { ...item, score, confidence, reason };
    }).sort((a, b) => b.score - a.score || a.display_name.localeCompare(b.display_name));

    return ranked.slice(0, limit).map((item) => includeScore ? item : stripScore(item));
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

function getCatalogForCurrentProfile() {
  const context = state.currentAction === "transfer" ? "transfer" : state.currentAction;
  const exactBusinessMatches = LABEL_CATALOG.filter((item) => {
    return item.transaction_contexts.includes(context)
      && item.business_types.includes(state.profile.business_type_id);
  });

  if (exactBusinessMatches.length) return exactBusinessMatches;

  const sectorBusinessIds = BUSINESS_TYPES
    .filter((item) => item.country === state.profile.country && item.sector_id === state.profile.sector_id)
    .map((item) => item.id);

  const sectorMatches = LABEL_CATALOG.filter((item) => {
    return item.transaction_contexts.includes(context)
      && item.countries.includes(state.profile.country)
      && item.business_types.some((businessId) => sectorBusinessIds.includes(businessId));
  });

  if (sectorMatches.length) return sectorMatches;

  return LABEL_CATALOG.filter((item) => {
    return item.transaction_contexts.includes(context)
      && item.countries.includes(state.profile.country);
  });
}

function getAvailableBusinessTypes() {
  if (!state.profile || !state.profile.country || !state.profile.sector_id) return [];
  return BUSINESS_TYPES.filter((item) => item.country === state.profile.country && item.sector_id === state.profile.sector_id);
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

function showScreen(id) {
  document.querySelectorAll(".screen").forEach((screen) => screen.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

function openChangeProfileConfirm() {
  els["change-confirm-modal"].hidden = false;
}

function closeChangeProfileConfirm() {
  els["change-confirm-modal"].hidden = true;
}

function confirmChangeProfile() {
  closeChangeProfileConfirm();
  state.onboardingStep = 3;
  renderOnboarding();
  showScreen("screen-onboarding");
}

function normalizeText(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function countryName(countryId) {
  return COUNTRIES.find((item) => item.id === countryId)?.name || countryId;
}

function parseMinor(value) {
  const number = parseFloat(String(value || "").replace(/,/g, ""));
  return Number.isFinite(number) ? Math.round(number * 100) : 0;
}

function formatMoney(amountMinor, currency) {
  const amount = amountMinor / 100;
  if (currency === "USD") {
    return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return `₦${amount.toLocaleString("en-NG", { maximumFractionDigits: 0 })}`;
}

function showError(message) {
  els["capture-error"].hidden = false;
  els["capture-error"].textContent = message;
}

function clearError() {
  els["capture-error"].hidden = true;
  els["capture-error"].textContent = "";
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings", { keyPath: "key" });
      if (!db.objectStoreNames.contains("records")) db.createObjectStore("records", { keyPath: "id" });
      if (!db.objectStoreNames.contains("customLabels")) db.createObjectStore("customLabels", { keyPath: "id" });
      if (!db.objectStoreNames.contains("usage")) db.createObjectStore("usage", { keyPath: "normalized_label" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function getProfile() {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction("settings", "readonly");
    const request = tx.objectStore("settings").get("profile");
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

function saveProfile(profile) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction("settings", "readwrite");
    tx.objectStore("settings").put({ ...profile, key: "profile" });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function getRecords() {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction("records", "readonly");
    const request = tx.objectStore("records").getAll();
    request.onsuccess = () => resolve(request.result.sort((a, b) => a.id - b.id));
    request.onerror = () => reject(request.error);
  });
}

async function appendLedgerRecord(record) {
  const last = await getLastRecord();
  const id = last ? last.id + 1 : 1;
  const confirmedAt = Math.floor(Date.now() / 1000);
  const prevHash = last ? last.entry_hash : "0".repeat(64);
  const entryHash = await sha256(`${id}|${record.transaction_type}|${record.normalized_label}|${record.amount_minor}|${confirmedAt}|${prevHash}`);
  const payload = {
    ...record,
    id,
    confirmed_at: confirmedAt,
    prev_entry_hash: prevHash,
    entry_hash: entryHash
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
    request.onsuccess = () => resolve(request.result ? request.result.value : null);
    request.onerror = () => reject(request.error);
  });
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
  const item = {
    id: `custom_${Date.now()}`,
    normalized_label: normalized,
    display_name: value,
    synonyms: [value],
    icon: "⭐",
    image_url: null,
    transaction_contexts: [state.currentAction === "transfer" ? "transfer" : state.currentAction],
    countries: [state.profile.country],
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
      learned_from: state.currentAction,
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
          transaction_contexts: [item.learned_from === "transfer_in" || item.learned_from === "transfer_out" ? "transfer" : item.learned_from],
          countries: [state.profile?.country || "NG", "US"].filter((value, index, array) => array.indexOf(value) === index),
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
