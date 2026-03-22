import { renderAdSlot } from "/app/ads.js";

const DB_NAME = "confirma-db";
const DB_VERSION = 1;
const APP_FILES = ["./", "./index.html", "./app.css", "./app.js", "./manifest.json", "./ads.js"];

const LANGUAGES = {
  NG: [
    ["en", "English"],
    ["pcm", "Pidgin"],
    ["ha", "Hausa / هَوْسَ"],
    ["yo", "Yoruba"],
    ["fr", "French"]
  ],
  US: [
    ["en", "English"],
    ["es", "Spanish"],
    ["fr", "French"]
  ]
};

const COPY = {
  en: {
    record: "Record",
    dashboard: "Dashboard",
    history: "History",
    settings: "Settings",
    export: "Export",
    tap: "Tap to speak your transaction",
    confirm: "Do you confirm?"
  },
  pcm: {
    record: "Record",
    dashboard: "Dashboard",
    history: "History",
    settings: "Settings",
    export: "Export",
    tap: "Talk your transaction",
    confirm: "You sure?"
  },
  ha: {
    record: "Rubuta",
    dashboard: "Dashboard",
    history: "Tarihi",
    settings: "Saiti",
    export: "Fitar",
    tap: "Faɗa cinikin ka",
    confirm: "Kana tabbata?"
  },
  yo: {
    record: "Gbasilẹ",
    dashboard: "Pẹpẹ",
    history: "Ìtàn",
    settings: "Ètò",
    export: "Yọ jade",
    tap: "Sọ iṣowo rẹ",
    confirm: "Ṣe o dájú?"
  },
  fr: {
    record: "Enregistrer",
    dashboard: "Tableau",
    history: "Historique",
    settings: "Paramètres",
    export: "Exporter",
    tap: "Parlez votre transaction",
    confirm: "Confirmez-vous ?"
  },
  es: {
    record: "Registrar",
    dashboard: "Panel",
    history: "Historial",
    settings: "Ajustes",
    export: "Exportar",
    tap: "Habla tu transacción",
    confirm: "¿Confirmas?"
  }
};

const PRESETS = {
  NG: {
    market_trader: {
      label: "🛒 Market Trader",
      sales: ["Rice", "Beans", "Palm Oil", "Tomatoes", "Pepper", "Garri"],
      expenses: ["Transport", "Wholesale purchase", "Market fees", "Packaging"],
      rec: "Track staple goods and your biggest operating costs like transport and wholesale purchase."
    },
    food_vendor: {
      label: "🍲 Food Vendor",
      sales: ["Jollof Rice", "Soup", "Drinks", "Snacks", "Fish"],
      expenses: ["Ingredients", "Gas/Firewood", "Packaging", "Transport"],
      rec: "Food vendors usually benefit from separating dishes and ingredients clearly."
    },
    artisan: {
      label: "🔧 Artisan",
      sales: ["Repair", "Installation", "Labour"],
      expenses: ["Materials", "Tools", "Transport", "Spare parts"],
      rec: "Artisans usually need to show both labour income and material costs."
    },
    transport: {
      label: "🚌 Transport",
      sales: ["Trip fare", "Delivery fee", "Charter"],
      expenses: ["Fuel", "Repairs", "Tyres", "Parking fee"],
      rec: "Transport operators often need clear fuel and repairs history."
    },
    small_shop: {
      label: "🏪 Small Shop",
      sales: ["Provisions", "Drinks", "Toiletries", "Stationery"],
      expenses: ["Wholesale purchase", "Rent", "Electricity", "Transport"],
      rec: "Small shops often build trust by showing consistency across inventory and overhead."
    },
    service: {
      label: "💼 Service Provider",
      sales: ["Consultation", "Project fee", "Service fee"],
      expenses: ["Data/Internet", "Transport", "Materials", "Equipment"],
      rec: "Service providers often track fees by job type or service delivered."
    }
  },
  US: {
    retail: {
      label: "🛍️ Retail",
      sales: ["Products", "Merchandise", "Gift items"],
      expenses: ["Supplies", "Shipping", "Packaging", "Storage"],
      rec: "Retailers often benefit from separating products and fulfillment costs."
    },
    food_service: {
      label: "🍔 Food Service",
      sales: ["Meals", "Catering", "Delivery"],
      expenses: ["Ingredients", "Equipment", "Permits", "Packaging"],
      rec: "Food service records usually become clearer when meal revenue and ingredient costs are separated."
    },
    freelancer: {
      label: "💻 Freelancer",
      sales: ["Project fee", "Consultation", "Retainer"],
      expenses: ["Software", "Equipment", "Travel", "Subscriptions"],
      rec: "Freelancers usually track by project and software costs."
    },
    contractor: {
      label: "🔨 Contractor",
      sales: ["Labour", "Project completion", "Inspection"],
      expenses: ["Materials", "Equipment rental", "Permits", "Subcontractors"],
      rec: "Contractors often need a clear relationship between project income and job costs."
    },
    beauty: {
      label: "💇 Beauty",
      sales: ["Service", "Treatment", "Products"],
      expenses: ["Supplies", "Rent", "Equipment", "Training"],
      rec: "Beauty businesses often record by service type and recurring supply costs."
    },
    ecommerce: {
      label: "📦 E-commerce",
      sales: ["Products", "Shipping charged"],
      expenses: ["Inventory", "Shipping costs", "Platform fees", "Packaging"],
      rec: "E-commerce businesses often benefit from separating inventory and fee-heavy costs."
    }
  }
};

const state = {
  db: null,
  profile: null,
  candidate: null,
  historyFilter: "ALL",
  historySearch: "",
  chartMode: "weekly",
  deferredPrompt: null,
  currentScreen: "screen-record"
};

const els = {};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  cacheElements();
  state.db = await openDb();
  state.profile = await loadProfile();
  wireStaticEvents();
  renderAdSlot();
  registerPwaFeatures();

  if (state.profile) {
    applyLanguage(state.profile.language || "en");
    renderSettingsOptions();
    await showMainApp();
  } else {
    renderLanguageChoices("NG");
    renderBusinessChoices("NG");
    showScreen("screen-onboarding");
  }
}

function cacheElements() {
  [
    "onboarding-step-label", "language-options", "business-options", "category-recommendation",
    "sales-categories", "expense-categories", "finish-onboarding", "bottom-nav", "voice-label",
    "confirm-question", "item-input", "amount-input", "category-select", "quick-pills",
    "recent-list", "today-sales", "today-expenses", "record-error", "voice-error", "transfer-toggle",
    "confirm-summary", "history-search", "history-list", "sales-chart", "dash-today-sales",
    "dash-monthly-sales", "dash-monthly-expenses", "dash-cash-flow", "streak-count", "trust-tier",
    "trust-copy", "settings-country", "settings-language", "settings-business", "settings-status",
    "export-status", "install-button", "ios-banner", "ios-dismiss", "record-subtitle"
  ].forEach((id) => {
    els[id] = document.getElementById(id);
  });
}

function wireStaticEvents() {
  document.querySelectorAll("[data-country]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-country]").forEach((node) => node.classList.remove("selected"));
      btn.classList.add("selected");
      const country = btn.dataset.country;
      renderLanguageChoices(country);
      renderBusinessChoices(country);
      updateOnboardingStep(2);
    });
  });

  els["finish-onboarding"].addEventListener("click", finishOnboarding);
  document.getElementById("record-button").addEventListener("click", handleManualRecord);
  document.getElementById("confirm-button").addEventListener("click", confirmCandidate);
  document.getElementById("cancel-button").addEventListener("click", () => {
    state.candidate = null;
    showScreen("screen-record");
  });
  document.getElementById("edit-button").addEventListener("click", () => {
    if (!state.candidate) return;
    const fields = state.candidate.fields;
    applyTypeToUi(fields.type);
    els["item-input"].value = fields.item || "";
    els["amount-input"].value = ((parseInt(fields.amount || "0", 10) || 0) / 100).toString();
    updateCategorySelect();
    els["category-select"].value = fields.category || "Other";
    showScreen("screen-record");
  });

  document.querySelectorAll("#type-toggle .toggle-pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#type-toggle .toggle-pill").forEach((node) => node.classList.remove("active"));
      btn.classList.add("active");
      els["transfer-toggle"].hidden = btn.dataset.type !== "TRANSFER";
      updateCategorySelect();
      renderQuickPills();
    });
  });

  document.querySelectorAll("#transfer-toggle .toggle-pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#transfer-toggle .toggle-pill").forEach((node) => node.classList.remove("active"));
      btn.classList.add("active");
    });
  });

  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.addEventListener("click", async () => {
      document.querySelectorAll(".nav-item").forEach((node) => node.classList.remove("active"));
      btn.classList.add("active");
      const next = btn.dataset.screen;
      showScreen(next);
      if (next === "screen-dashboard") await renderDashboard();
      if (next === "screen-history") await renderHistory();
      if (next === "screen-record") await renderRecordSummary();
      if (next === "screen-settings") renderSettingsOptions();
    });
  });

  document.querySelectorAll("#chart-toggle .toggle-pill").forEach((btn) => {
    btn.addEventListener("click", async () => {
      document.querySelectorAll("#chart-toggle .toggle-pill").forEach((node) => node.classList.remove("active"));
      btn.classList.add("active");
      state.chartMode = btn.dataset.chart;
      await renderDashboard();
    });
  });

  document.querySelectorAll("#history-toggle .toggle-pill").forEach((btn) => {
    btn.addEventListener("click", async () => {
      document.querySelectorAll("#history-toggle .toggle-pill").forEach((node) => node.classList.remove("active"));
      btn.classList.add("active");
      state.historyFilter = btn.dataset.filter;
      await renderHistory();
    });
  });

  els["history-search"].addEventListener("input", async (event) => {
    state.historySearch = event.target.value || "";
    await renderHistory();
  });

  document.getElementById("save-settings").addEventListener("click", saveSettings);
  document.getElementById("export-button").addEventListener("click", exportLedger);
  document.getElementById("mic-button").addEventListener("click", startVoiceInput);
  document.getElementById("read-again-button").addEventListener("click", () => {
    if (!state.candidate) return;
    speakText(state.candidate.displayText, true);
  });
  els["ios-dismiss"].addEventListener("click", () => {
    els["ios-banner"].hidden = true;
  });
}

function registerPwaFeatures() {
  const standalone = isStandaloneMode();
  if (standalone) {
    els["install-button"].hidden = true;
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/app/sw.js");
  }

  window.addEventListener("beforeinstallprompt", (event) => {
    if (isStandaloneMode()) {
      els["install-button"].hidden = true;
      return;
    }
    event.preventDefault();
    state.deferredPrompt = event;
    els["install-button"].hidden = false;
  });

  els["install-button"].addEventListener("click", async () => {
    if (!state.deferredPrompt) return;
    await state.deferredPrompt.prompt();
  });

  window.addEventListener("appinstalled", () => {
    state.deferredPrompt = null;
    els["install-button"].hidden = true;
  });

  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  const isStandalone = window.navigator.standalone === true || standalone;
  if (isIos && !isStandalone) {
    els["ios-banner"].hidden = false;
  }
}

function isStandaloneMode() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function updateOnboardingStep(step) {
  document.querySelectorAll(".onboard-step").forEach((node) => {
    node.classList.toggle("active", node.dataset.step === String(step));
  });
  els["onboarding-step-label"].textContent = `Step ${step} of 4`;
}

function renderLanguageChoices(country) {
  const options = LANGUAGES[country] || LANGUAGES.NG;
  els["language-options"].innerHTML = "";
  options.forEach(([code, label]) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "choice-card";
    btn.textContent = label;
    btn.addEventListener("click", () => {
      document.querySelectorAll("#language-options .choice-card").forEach((node) => node.classList.remove("selected"));
      btn.classList.add("selected");
      renderBusinessChoices(country, code);
      updateOnboardingStep(3);
    });
    btn.dataset.language = code;
    els["language-options"].appendChild(btn);
  });
}

function renderBusinessChoices(country, language = "en") {
  const presets = PRESETS[country] || PRESETS.NG;
  els["business-options"].innerHTML = "";
  Object.entries(presets).forEach(([key, value]) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "choice-card";
    btn.innerHTML = `<strong>${value.label}</strong><span>${value.rec}</span>`;
    btn.addEventListener("click", () => {
      document.querySelectorAll("#business-options .choice-card").forEach((node) => node.classList.remove("selected"));
      btn.classList.add("selected");
      renderCategoryChoices(country, key, language);
      updateOnboardingStep(4);
    });
    btn.dataset.business = key;
    els["business-options"].appendChild(btn);
  });
}

function renderCategoryChoices(country, businessKey, language) {
  const selectedCountry = country;
  const preset = PRESETS[selectedCountry][businessKey];
  const countryButton = document.querySelector("[data-country].selected");
  const langButton = document.querySelector("#language-options .choice-card.selected");
  state.profile = {
    country: selectedCountry,
    language: langButton ? langButton.dataset.language : language,
    businessType: businessKey,
    currency: selectedCountry === "US" ? "USD" : "NGN",
    salesCategories: [...preset.sales],
    expenseCategories: [...preset.expenses],
    readbackEnabled: true
  };

  els["category-recommendation"].textContent = preset.rec;
  els["sales-categories"].innerHTML = "";
  els["expense-categories"].innerHTML = "";

  preset.sales.forEach((category) => els["sales-categories"].appendChild(buildPill(category, true, "salesCategories")));
  preset.expenses.forEach((category) => els["expense-categories"].appendChild(buildPill(category, true, "expenseCategories")));

  if (countryButton) countryButton.classList.add("selected");
}

function buildPill(label, selected, key) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `pill-option${selected ? " selected" : ""}`;
  btn.textContent = label;
  btn.addEventListener("click", () => {
    btn.classList.toggle("selected");
    const list = state.profile[key];
    if (btn.classList.contains("selected")) {
      if (!list.includes(label)) list.push(label);
    } else {
      state.profile[key] = list.filter((item) => item !== label);
    }
  });
  return btn;
}

async function finishOnboarding() {
  await saveProfile(state.profile);
  applyLanguage(state.profile.language || "en");
  renderSettingsOptions();
  await showMainApp();
}

async function showMainApp() {
  els["bottom-nav"].hidden = false;
  showScreen("screen-record");
  updateCategorySelect();
  renderQuickPills();
  await Promise.all([renderRecordSummary(), renderDashboard(), renderHistory()]);
}

function applyLanguage(language) {
  const copy = COPY[language] || COPY.en;
  const navLabels = {
    "screen-record": copy.record,
    "screen-dashboard": copy.dashboard,
    "screen-history": copy.history,
    "screen-settings": copy.settings,
    "screen-export": copy.export
  };

  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.textContent = navLabels[btn.dataset.screen];
  });

  els["voice-label"].textContent = copy.tap;
  els["confirm-question"].textContent = copy.confirm;
}

function updateCategorySelect() {
  const type = getSelectedType();
  const source = type === "EXPENSE" ? state.profile.expenseCategories : state.profile.salesCategories;
  els["category-select"].innerHTML = "";
  source.forEach((category) => {
    const option = document.createElement("option");
    option.value = category;
    option.textContent = category;
    els["category-select"].appendChild(option);
  });
  const other = document.createElement("option");
  other.value = "Other";
  other.textContent = "Other";
  els["category-select"].appendChild(other);
}

function renderQuickPills() {
  const type = getSelectedType();
  const source = type === "EXPENSE" ? state.profile.expenseCategories : state.profile.salesCategories;
  els["quick-pills"].innerHTML = "";
  source.slice(0, 6).forEach((category) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "quick-pill";
    btn.textContent = category;
    btn.addEventListener("click", () => {
      document.querySelectorAll(".quick-pill").forEach((node) => node.classList.remove("selected"));
      btn.classList.add("selected");
      els["item-input"].value = category;
      els["category-select"].value = category;
    });
    els["quick-pills"].appendChild(btn);
  });
}

function getSelectedType() {
  const active = document.querySelector("#type-toggle .toggle-pill.active");
  return active ? active.dataset.type : "SALE";
}

function getTransferDirection() {
  const active = document.querySelector("#transfer-toggle .toggle-pill.active");
  return active ? active.dataset.direction : "IN";
}

function handleManualRecord() {
  clearErrors();
  const type = getSelectedType();
  const item = els["item-input"].value.trim();
  const amount = parseMoneyToMinor(els["amount-input"].value);
  const category = els["category-select"].value || "Other";

  if (!item || !amount || amount <= 0) {
    showError("record-error", "Please enter both item and a valid amount.");
    return;
  }

  let finalType = type;
  if (type === "TRANSFER") {
    finalType = getTransferDirection() === "OUT" ? "TRANSFER_OUT" : "TRANSFER_IN";
  }

  const fields = { type: finalType, item, amount: String(amount), category };
  presentCandidate(fields, "text");
}

function parseTranscript(input) {
  const text = input.toLowerCase().trim().replace(/[₦$,]/g, "");
  let match = text.match(/^(?:sold|sale)\s+(.+?)\s+for\s+([0-9,.]+)/);
  if (match) return { type: "SALE", item: match[1].trim(), amount: String(parseMoneyToMinor(match[2])), category: "Other" };
  match = text.match(/^(?:bought|expense|paid)\s+(.+?)\s+(?:for\s+)?([0-9,.]+)/);
  if (match) return { type: "EXPENSE", item: match[1].trim(), amount: String(parseMoneyToMinor(match[2])), category: "Other" };
  match = text.match(/^received\s+([0-9,.]+)\s+from\s+(.+)/);
  if (match) return { type: "TRANSFER_IN", item: match[2].trim(), amount: String(parseMoneyToMinor(match[1])), category: "Other" };
  return null;
}

function startVoiceInput() {
  clearErrors();
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRec) {
    showError("voice-error", "Voice input is not available in this browser. Please use text input.");
    return;
  }

  const recognition = new SpeechRec();
  recognition.lang = state.profile.country === "US" ? "en-US" : "en-NG";
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript;
    const parsed = parseTranscript(transcript);
    if (!parsed || !parseInt(parsed.amount, 10)) {
      showError("voice-error", "Could not understand that. Try saying: Sold rice for 15000.");
      return;
    }
    presentCandidate(parsed, "voice");
  };

  recognition.onerror = () => {
    showError("voice-error", "Microphone error. Please try again or use text input.");
  };

  recognition.start();
}

function presentCandidate(fields, modality) {
  const displayText = makeDisplayText(fields);
  state.candidate = { fields, modality, displayText };
  els["confirm-summary"].textContent = displayText;
  speakText(displayText, false);
  showScreen("screen-confirm");
}

function speakText(text, fromUserAction) {
  if (!text || !("speechSynthesis" in window) || state.profile.readbackEnabled === false) return;

  const speakNow = () => {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = state.profile.country === "US" ? "en-US" : "en-NG";

    const voices = window.speechSynthesis.getVoices();
    const preferred = voices.find((voice) => voice.lang === utterance.lang)
      || voices.find((voice) => voice.lang.startsWith("en"))
      || voices[0];
    if (preferred) utterance.voice = preferred;

    utterance.rate = 0.96;
    utterance.pitch = 1;
    window.speechSynthesis.resume();
    window.speechSynthesis.speak(utterance);
  };

  if (fromUserAction) {
    speakNow();
    return;
  }

  window.speechSynthesis.getVoices();
  setTimeout(speakNow, 120);
}

async function confirmCandidate() {
  if (!state.candidate) return;
  await writeEntry(state.candidate);
  state.candidate = null;
  els["item-input"].value = "";
  els["amount-input"].value = "";
  await Promise.all([renderRecordSummary(), renderDashboard(), renderHistory()]);
  setActiveNav("screen-dashboard");
  showScreen("screen-dashboard");
}

function applyTypeToUi(type) {
  const baseType = type.startsWith("TRANSFER") ? "TRANSFER" : type;
  document.querySelectorAll("#type-toggle .toggle-pill").forEach((node) => {
    node.classList.toggle("active", node.dataset.type === baseType);
  });
  els["transfer-toggle"].hidden = baseType !== "TRANSFER";
  if (type === "TRANSFER_OUT") {
    document.querySelectorAll("#transfer-toggle .toggle-pill").forEach((node) => {
      node.classList.toggle("active", node.dataset.direction === "OUT");
    });
  } else {
    document.querySelectorAll("#transfer-toggle .toggle-pill").forEach((node) => {
      node.classList.toggle("active", node.dataset.direction === "IN");
    });
  }
}

async function renderRecordSummary() {
  const entries = await getAllEntries();
  const today = new Date().toDateString();
  let sales = 0;
  let expenses = 0;
  const recent = [...entries].reverse().slice(0, 5);

  entries.forEach((entry) => {
    const sameDay = new Date(entry.confirmed_at * 1000).toDateString() === today;
    if (!sameDay) return;
    const amount = parseInt(entry.fields.amount || "0", 10) || 0;
    if (entry.fields.type === "SALE") sales += amount;
    if (entry.fields.type === "EXPENSE") expenses += amount;
  });

  els["today-sales"].textContent = formatMoney(sales);
  els["today-expenses"].textContent = formatMoney(expenses);
  els["recent-list"].innerHTML = recent.length ? recent.map(renderTxItem).join("") : `<p class="subtle">No transactions yet.</p>`;
}

async function renderHistory() {
  const entries = await getAllEntries();
  const query = state.historySearch.toLowerCase().trim();
  const filtered = [...entries].reverse().filter((entry) => {
    if (state.historyFilter !== "ALL") {
      if (state.historyFilter === "TRANSFER" && !entry.fields.type.startsWith("TRANSFER")) return false;
      if (state.historyFilter !== "TRANSFER" && entry.fields.type !== state.historyFilter) return false;
    }
    if (query && !(entry.fields.item || "").toLowerCase().includes(query)) return false;
    return true;
  });
  els["history-list"].innerHTML = filtered.length ? filtered.map(renderTxItem).join("") : `<p class="subtle">No matching transactions.</p>`;
}

async function renderDashboard() {
  const entries = await getAllEntries();
  const now = new Date();
  const month = now.getMonth();
  const year = now.getFullYear();
  const today = now.toDateString();

  let todaySales = 0;
  let monthlySales = 0;
  let monthlyExpenses = 0;
  const activeDays = new Set();

  entries.forEach((entry) => {
    const date = new Date(entry.confirmed_at * 1000);
    const amount = parseInt(entry.fields.amount || "0", 10) || 0;
    activeDays.add(date.toDateString());
    if (entry.fields.type === "SALE" && date.toDateString() === today) todaySales += amount;
    if (date.getMonth() === month && date.getFullYear() === year) {
      if (entry.fields.type === "SALE") monthlySales += amount;
      if (entry.fields.type === "EXPENSE") monthlyExpenses += amount;
    }
  });

  els["dash-today-sales"].textContent = formatMoney(todaySales);
  els["dash-monthly-sales"].textContent = formatMoney(monthlySales);
  els["dash-monthly-expenses"].textContent = formatMoney(monthlyExpenses);
  els["dash-cash-flow"].textContent = formatMoney(monthlySales - monthlyExpenses);

  const streak = calculateStreak(activeDays);
  const totalDays = activeDays.size;
  const trust = getTrust(totalDays);
  els["streak-count"].textContent = `${streak} day${streak === 1 ? "" : "s"}`;
  els["trust-tier"].textContent = trust.tier;
  els["trust-copy"].textContent = trust.copy;
  renderChart(entries);
}

function renderChart(entries) {
  const now = new Date();
  const items = [];

  if (state.chartMode === "monthly") {
    for (let index = 5; index >= 0; index -= 1) {
      const date = new Date(now.getFullYear(), now.getMonth() - index, 1);
      const label = date.toLocaleDateString("en-US", { month: "short" });
      const total = entries
        .filter((entry) => entry.fields.type === "SALE")
        .filter((entry) => {
          const entryDate = new Date(entry.confirmed_at * 1000);
          return entryDate.getMonth() === date.getMonth() && entryDate.getFullYear() === date.getFullYear();
        })
        .reduce((sum, entry) => sum + (parseInt(entry.fields.amount || "0", 10) || 0), 0);
      items.push({ label, value: total / 100 });
    }
  } else {
    for (let index = 6; index >= 0; index -= 1) {
      const date = new Date();
      date.setDate(now.getDate() - index);
      const label = date.toLocaleDateString("en-US", { weekday: "short" });
      const total = entries
        .filter((entry) => entry.fields.type === "SALE")
        .filter((entry) => new Date(entry.confirmed_at * 1000).toDateString() === date.toDateString())
        .reduce((sum, entry) => sum + (parseInt(entry.fields.amount || "0", 10) || 0), 0);
      items.push({ label, value: total / 100 });
    }
  }

  const max = Math.max(...items.map((item) => item.value), 1);
  els["sales-chart"].innerHTML = items.map((item) => {
    const height = Math.max(6, Math.round((item.value / max) * 120));
    return `<div class="chart-bar-wrap"><div class="chart-bar" style="height:${height}px"></div><div class="chart-label">${item.label}</div></div>`;
  }).join("");
}

function renderSettingsOptions() {
  if (!state.profile) return;
  els["settings-country"].value = state.profile.country;

  const languageSelect = els["settings-language"];
  languageSelect.innerHTML = "";
  (LANGUAGES[state.profile.country] || LANGUAGES.NG).forEach(([value, label]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    languageSelect.appendChild(option);
  });
  languageSelect.value = state.profile.language;

  const businessSelect = els["settings-business"];
  businessSelect.innerHTML = "";
  Object.entries(PRESETS[state.profile.country] || PRESETS.NG).forEach(([value, preset]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = preset.label.replace(/^[^\s]+\s/, "");
    businessSelect.appendChild(option);
  });
  businessSelect.value = state.profile.businessType;
}

async function saveSettings() {
  const country = els["settings-country"].value;
  const language = els["settings-language"].value;
  const businessType = els["settings-business"].value;
  const preset = PRESETS[country][businessType];
  state.profile = {
    ...state.profile,
    country,
    language,
    businessType,
    currency: country === "US" ? "USD" : "NGN",
    salesCategories: preset.sales,
    expenseCategories: preset.expenses
  };
  await saveProfile(state.profile);
  applyLanguage(language);
  updateCategorySelect();
  renderQuickPills();
  els["settings-status"].textContent = "Saved.";
  setTimeout(() => {
    els["settings-status"].textContent = "";
  }, 2000);
}

async function exportLedger() {
  const entries = await getAllEntries();
  const cutoff = Math.floor(Date.now() / 1000) - (30 * 24 * 60 * 60);
  const filtered = entries.filter((entry) => entry.confirmed_at >= cutoff);
  if (!filtered.length) {
    els["export-status"].textContent = "No entries in the last 30 days.";
    return;
  }
  const lines = filtered.map((entry) => {
    const date = new Date(entry.confirmed_at * 1000).toLocaleString();
    return `${entry.id} | ${entry.fields.type} | ${entry.fields.item} | ${formatMoney(parseInt(entry.fields.amount, 10) || 0)} | ${date}`;
  });
  const rootHash = filtered[filtered.length - 1].entry_hash;
  const integrityCode = await sha256(filtered.map((entry) => entry.entry_hash).join("|"));
  const fileText = [
    "CONFIRMA FREE EXPORT",
    `Generated: ${new Date().toLocaleString()}`,
    `Entries: ${filtered.length}`,
    "---",
    ...lines,
    "---",
    `Ledger Root Hash: ${rootHash}`,
    `Integrity Code: ${integrityCode}`
  ].join("\n");
  const blob = new Blob([fileText], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `confirma-export-${Date.now()}.txt`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  els["export-status"].textContent = "Export downloaded.";
}

function renderTxItem(entry) {
  const date = new Date(entry.confirmed_at * 1000).toLocaleString();
  return `<div class="tx-item"><div><strong>${escapeHtml(entry.fields.item || entry.fields.type)}</strong><span>${escapeHtml(date)} • ${escapeHtml(entry.fields.type)}</span></div><div class="amount">${escapeHtml(formatMoney(parseInt(entry.fields.amount || "0", 10) || 0))}</div></div>`;
}

function makeDisplayText(fields) {
  const amount = formatMoney(parseInt(fields.amount || "0", 10) || 0);
  if (fields.type === "EXPENSE") return `You paid ${fields.item} for ${amount}.`;
  if (fields.type === "TRANSFER_IN") return `You received ${amount} from ${fields.item}.`;
  if (fields.type === "TRANSFER_OUT") return `You sent ${amount} to ${fields.item}.`;
  return `You sold ${fields.item} for ${amount}.`;
}

function parseMoneyToMinor(value) {
  const number = parseFloat(String(value).replace(/,/g, ""));
  return Number.isFinite(number) ? Math.round(number * 100) : 0;
}

function formatMoney(minor) {
  const amount = minor / 100;
  if (state.profile && state.profile.currency === "USD") {
    return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return `₦${amount.toLocaleString("en-NG", { maximumFractionDigits: 0 })}`;
}

function calculateStreak(activeDays) {
  let streak = 0;
  const date = new Date();
  while (activeDays.has(date.toDateString())) {
    streak += 1;
    date.setDate(date.getDate() - 1);
  }
  return streak;
}

function getTrust(totalDays) {
  if (totalDays >= 180) return { tier: "GOLD", copy: "Six months of confirmed history gives you GOLD trust tier." };
  if (totalDays >= 90) return { tier: "SILVER", copy: "Ninety days of history gives you SILVER trust tier." };
  if (totalDays >= 30) return { tier: "BRONZE", copy: "Thirty days of history gives you BRONZE trust tier." };
  return { tier: "NEW", copy: "Keep recording to move from NEW to BRONZE." };
}

function clearErrors() {
  ["record-error", "voice-error"].forEach((id) => {
    els[id].hidden = true;
    els[id].textContent = "";
  });
}

function showError(id, message) {
  els[id].hidden = false;
  els[id].textContent = message;
}

function showScreen(id) {
  document.querySelectorAll(".screen").forEach((screen) => {
    screen.classList.toggle("active", screen.id === id);
  });
  state.currentScreen = id;
}

function setActiveNav(screenId) {
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.screen === screenId);
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains("ledger")) db.createObjectStore("ledger", { keyPath: "id" });
      if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings", { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function getAllEntries() {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction("ledger", "readonly");
    const request = tx.objectStore("ledger").getAll();
    request.onsuccess = () => {
      resolve(request.result.sort((a, b) => a.id - b.id));
    };
    request.onerror = () => reject(request.error);
  });
}

function getLastEntry() {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction("ledger", "readonly");
    const request = tx.objectStore("ledger").openCursor(null, "prev");
    request.onsuccess = () => resolve(request.result ? request.result.value : null);
    request.onerror = () => reject(request.error);
  });
}

function loadProfile() {
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
    tx.objectStore("settings").put({ ...profile,