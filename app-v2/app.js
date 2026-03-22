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
  { id: "ng_kiosk_phone_business", country: "NG", sector_id: "digital_online", name: "Kiosk / Phone Business", icon: "📞" },
  { id: "ng_fashion_tailor", country: "NG", sector_id: "personal_professional", name: "Fashion / Tailor", icon: "🧵" },
  { id: "ng_okada_keke_operator", country: "NG", sector_id: "transport_logistics", name: "Okada / Keke Operator", icon: "🛵" },
  { id: "us_retail", country: "US", sector_id: "trade_retail", name: "Retail", icon: "🛍️" },
  { id: "us_food_service", country: "US", sector_id: "food_hospitality", name: "Food Service", icon: "🍔" },
  { id: "us_logistics", country: "US", sector_id: "transport_logistics", name: "Logistics", icon: "🚚" },
  { id: "us_contractor", country: "US", sector_id: "skilled_construction", name: "Contractor", icon: "🔨" },
  { id: "us_beauty_services", country: "US", sector_id: "personal_professional", name: "Beauty Services", icon: "💇" },
  { id: "us_digital_business", country: "US", sector_id: "digital_online", name: "Digital Business", icon: "🧑‍💻" },
  { id: "us_personal_services_side_hustle", country: "US", sector_id: "personal_professional", name: "Personal Services / Side Hustle", icon: "🧹" }
];

const QUICK_PICKS = {
  ng_market_trader: {
    sell: ["Rice", "Beans", "Garri", "Tomatoes", "Pepper", "Palm Oil", "Yam", "Onion"],
    purchase: ["Rice Stock", "Beans Stock", "Palm Oil Stock", "Tomato Crate", "Pepper Bag", "Nylon Bags"],
    payment: ["Transport", "Market Fee", "Stall Rent", "Packaging", "Helper Pay", "Mobile Data"],
    receipt: ["Customer Payment", "POS Payment", "Debt Collected", "Esusu Payout"]
  },
  ng_provision_shop: {
    sell: ["Drinks", "Biscuits", "Noodles", "Sugar", "Bread", "Water", "Airtime", "Toiletries"],
    purchase: ["Drinks Stock", "Biscuit Carton", "Noodles Carton", "Sugar Stock", "Bread Stock", "Airtime Float"],
    payment: ["Shop Rent", "Electricity", "Transport", "Generator Fuel", "Staff Pay", "Packaging"],
    receipt: ["Customer Payment", "POS Payment", "Debt Collected", "Supplier Refund"]
  },
  ng_food_vendor: {
    sell: ["Rice Meal", "Soup", "Swallow", "Snacks", "Drinks", "Fish", "Chicken", "Catering", "Eba", "Tuwo"],
    purchase: ["Rice (Cooking)", "Cooking Oil", "Tomatoes", "Pepper", "Meat/Fish", "Gas", "Firewood", "Seasoning"],
    payment: ["Stall Rent", "Helper Pay", "Transport", "Packaging", "Electricity", "Water Supply", "Waste Disposal", "Cooking Gas"],
    receipt: ["Customer Payment", "Bulk Order Payment", "Catering Deposit", "Debt Collected"]
  },
  ng_transport_operator: {
    sell: ["Trip Fare", "Delivery Fee", "Charter", "Interstate Fare", "Loading Fee", "Haulage"],
    purchase: ["Fuel", "Engine Oil", "Spare Parts", "Tyres", "Battery", "Tools"],
    payment: ["Fuel", "Repair", "Park Levy", "Tyre Repair", "Driver Pay", "Car Wash", "Insurance", "Road Toll"],
    receipt: ["Passenger Payment", "Delivery Payment", "Charter Payment", "Debt Collected"]
  },
  ng_artisan: {
    sell: ["Repair Job", "Installation", "Labour", "Fabrication", "Maintenance", "Inspection"],
    purchase: ["Materials", "Spare Parts", "Tools", "Paint", "Fittings", "Safety Gear"],
    payment: ["Transport", "Helper Pay", "Generator Fuel", "Phone/Data", "Workshop Rent", "Tool Repair"],
    receipt: ["Job Payment", "Deposit", "Balance Payment", "Refund Received"]
  },
  ng_service_provider: {
    sell: ["Consultation", "Service Fee", "Project Fee", "Training", "Retainer", "Admin Service"],
    purchase: ["Materials", "Data Bundle", "Airtime", "Office Supplies"],
    payment: ["Transport", "Data/Internet", "Rent", "Assistant Pay", "Power", "Marketing"],
    receipt: ["Client Payment", "Deposit", "Balance", "Refund Received"]
  },
  ng_online_seller: {
    sell: ["Product Sale", "Delivery Charged", "Wholesale Order", "Social Media Sale", "Custom Order", "Bulk Order"],
    purchase: ["Inventory", "Packaging", "Data Bundle", "Product Photos", "Labels/Tags", "Storage"],
    payment: ["Shipping Cost", "Platform Fee", "Ad Boost", "Data/Internet", "Packaging", "Rider Payment", "Dispatch Fee", "Printing"],
    receipt: ["Customer Transfer", "POS/Link Payment", "Deposit", "Refund Received"]
  },
  ng_kiosk_phone_business: {
    sell: ["Airtime", "Data Bundle", "Transfer Fee", "Electricity Token", "Cable Sub", "Print/Photocopy"],
    purchase: ["Airtime Float", "Data Float", "Printer Paper", "POS Paper", "Ink", "Accessories"],
    payment: ["Kiosk Rent", "POS Charge", "Airtime Float", "Electricity", "Mobile Data"],
    receipt: ["Customer Payment", "POS Payment", "Transfer Receipt"]
  },
  ng_fashion_tailor: {
    sell: ["Sewing Job", "Aso-Ebi", "Fabric", "Alteration", "Ready-to-Wear", "Embroidery"],
    purchase: ["Fabric Stock", "Thread/Trimmings", "Machine Parts"],
    payment: ["Workshop Rent", "Electricity", "Helper Wage"],
    receipt: ["Client Payment", "Deposit", "Balance Payment"]
  },
  ng_okada_keke_operator: {
    sell: ["Passenger Fare", "Errand Trip", "Delivery Run"],
    purchase: ["Fuel", "Spare Parts", "Tyres"],
    payment: ["Fuel", "Union Levy", "Repair", "Tyre", "Bike Loan"],
    receipt: ["Passenger Payment", "Delivery Payment", "Debt Collected"]
  },
  us_retail: {
    sell: ["Products", "Merchandise", "Gift Items", "Accessories", "Custom Order", "Online Sale", "Bundle Sale", "Clearance"],
    purchase: ["Inventory", "Supplies", "Packaging", "Labels/Tags", "Display Items", "Thrift Haul"],
    payment: ["Rent", "Shipping Cost", "Utilities", "Staff Pay", "Card Fees", "Platform Fees", "Storage", "Ads"],
    receipt: ["Customer Payment", "Online Order Payment", "Deposit", "Supplier Refund"]
  },
  us_food_service: {
    sell: ["Meals", "Drinks", "Catering", "Delivery", "Baked Goods", "Wings", "Meal Prep", "Custom Cake", "BBQ", "Soul Food"],
    purchase: ["Ingredients", "Meat", "Produce", "Packaging", "Cooking Oil", "Baking Supplies", "Dairy", "Beverages"],
    payment: ["Rent", "Utilities", "Cooking Gas/Propane", "Staff Pay", "Delivery App Fee", "Packaging", "Permits", "Equipment"],
    receipt: ["Customer Payment", "Delivery App Payout", "Catering Deposit", "Supplier Refund"]
  },
  us_logistics: {
    sell: ["Delivery Job", "Route Pay", "Freight Job", "Rush Delivery", "Charter Trip", "Moving Job"],
    purchase: ["Vehicle Fuel", "Tires", "Parts", "Safety Gear"],
    payment: ["Fuel", "Repairs", "Insurance", "Tolls", "Truck Payment", "Parking", "Phone/Data", "Driver Pay"],
    receipt: ["Client Payment", "Platform Payout", "Tip", "Reimbursement"]
  },
  us_contractor: {
    sell: ["Labor", "Project Fee", "Installation", "Repair Job", "Inspection", "Emergency Call"],
    purchase: ["Materials", "Equipment Rental", "Tools", "Safety Gear", "Paint/Primer", "Fasteners"],
    payment: ["Materials", "Subcontractor Pay", "Permits", "Fuel", "Disposal/Dumpster", "Insurance", "Helper Pay", "Tool Rental"],
    receipt: ["Client Payment", "Deposit", "Progress Payment", "Final Balance"]
  },
  us_beauty_services: {
    sell: ["Hair Service", "Nails", "Braiding", "Locs/Retwist", "Silk Press", "Sew-In", "Treatment/Wax", "Makeup", "Lashes", "Product Sale"],
    purchase: ["Braiding Hair", "Supplies", "Products", "Lash Supplies", "Nail Supplies", "Color/Developer"],
    payment: ["Booth Rent", "Products Used", "Platform Fee", "Supplies Run", "Training", "Utilities"],
    receipt: ["Client Payment", "Deposit", "Tip", "Supplier Refund"]
  },
  us_digital_business: {
    sell: ["Project Fee", "Subscription", "Consultation", "Digital Product", "Coaching", "Course Sale", "Brand Deal", "UGC Content"],
    purchase: ["Software", "Equipment", "Domain/Hosting", "Stock Assets", "Content Props", "Merch Inventory"],
    payment: ["Subscriptions", "Ads", "Contractor Pay", "Internet", "Platform Fee", "Phone Plan", "Cloud Hosting", "Accounting"],
    receipt: ["Client Payment", "Platform Payout", "Affiliate Payout", "Deposit"]
  },
  us_personal_services_side_hustle: {
    sell: ["Cleaning Job", "Dog Walking", "Babysitting", "Tutoring", "Lawn Care", "Photography", "Car Detailing", "Rideshare", "Power Washing", "Moving Help"],
    purchase: ["Cleaning Supplies", "Equipment"],
    payment: ["Gas", "App Fee", "Equipment", "Background Check", "Cleaning Supplies"],
    receipt: ["Client Payment", "Tip", "Reimbursement", "App Payout"]
  }
};

const EXTRA_SEARCH_LABELS = [
  buildLabel("tuwo_shinkafa_sale", "Tuwo Shinkafa", "🍲", ["tuwo", "rice tuwo"], ["sale"], ["NG"], ["ng_food_vendor"]),
  buildLabel("zobo_sale", "Zobo", "🥤", ["zobo drink"], ["sale"], ["NG"], ["ng_food_vendor"]),
  buildLabel("crayfish_sale", "Crayfish", "🦐", ["crayfish"], ["sale"], ["NG"], ["ng_market_trader"]),
  buildLabel("egusi_sale", "Egusi", "🥜", ["melon"], ["sale"], ["NG"], ["ng_market_trader"]),
  buildLabel("social_media_management_sale", "Social Media Mgmt", "📱", ["social media management"], ["sale"], ["US"], ["us_digital_business"]),
  buildLabel("video_editing_sale", "Video Editing", "🎬", ["editing"], ["sale"], ["US"], ["us_digital_business"]),
  buildLabel("box_braids_sale", "Box Braids", "💇", ["braids"], ["sale"], ["US"], ["us_beauty_services"]),
  buildLabel("car_detailing_sale", "Car Detailing", "🚗", ["detailing"], ["sale"], ["US"], ["us_personal_services_side_hustle"])
];

const LABEL_CATALOG = [...buildCatalogFromQuickPicks(), ...EXTRA_SEARCH_LABELS];

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
  const context = item.transaction_contexts[0] || "";
  return friendlyActionLabel(context);
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
  return `<button type="button" class="ranked-item" data-ranked-id="${item.id}"><strong>${item.icon || "🏷️"} ${item.display_name}</strong><span>${contextCopy(item)}</span><small>${item.reason || "Recommended label"}</small></button>`;
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

function friendlyActionLabel(action) {
  if (action === "sale") return "Sell";
  if (action === "purchase") return "Buy";
  if (action === "payment") return "Pay";
  if (action === "receipt") return "Receive";
  if (action === "transfer") return "Transfer";
  return action;
}

function inferIcon(displayName, action) {
  const text = normalizeText(displayName);
  if (text.includes("rice")) return "🌾";
  if (text.includes("beans")) return "🫘";
  if (text.includes("garri")) return "🥣";
  if (text.includes("tomato")) return "🍅";
  if (text.includes("pepper")) return "🌶️";
  if (text.includes("oil")) return "🛢️";
  if (text.includes("yam")) return "🍠";
  if (text.includes("onion")) return "🧅";
  if (text.includes("drink") || text.includes("water")) return "🥤";
  if (text.includes("airtime") || text.includes("data")) return "📱";
  if (text.includes("fuel") || text.includes("gas")) return "⛽";
  if (text.includes("rent")) return "🏠";
  if (text.includes("transport") || text.includes("trip") || text.includes("delivery")) return "🚚";
  if (text.includes("packag")) return "📦";
  if (text.includes("pay") || text.includes("wage")) return "👤";
  if (text.includes("tool")) return "🧰";
  if (text.includes("material")) return "🧱";
  if (text.includes("payment") || text.includes("deposit") || text.includes("refund")) return "💵";
  if (text.includes("platform") || text.includes("subscription")) return "🧾";
  if (text.includes("hair") || text.includes("braid") || text.includes("loc")) return "💇";
  if (text.includes("consult") || text.includes("project") || text.includes("service")) return "💼";
  if (action === "receipt") return "💰";
  if (action === "payment") return "💸";
  if (action === "purchase") return "🛒";
  return "🏷️";
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
