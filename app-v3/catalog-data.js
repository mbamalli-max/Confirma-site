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

export const SECTORS = [
  { id: "trade_retail", name: "Trade & Retail", icon: "🛍️" },
  { id: "food_hospitality", name: "Food & Hospitality", icon: "🍲" },
  { id: "transport_logistics", name: "Transport & Logistics", icon: "🚌" },
  { id: "skilled_construction", name: "Skilled Work & Construction", icon: "🔧" },
  { id: "personal_professional", name: "Personal & Professional Services", icon: "💼" },
  { id: "digital_online", name: "Digital & Online Business", icon: "💻" }
];

export const SUPPORTED_LANGUAGES = [
  { id: "en", name: "English" }
];

export const PHONE_COUNTRY_RULES = {
  GH: {
    dialCode: "+233",
    dialingDigits: "233",
    onboardingPlaceholder: "e.g. 0241234567",
    otpPlaceholder: "0241234567",
    validationMessage: "Enter a valid Ghanaian phone number."
  },
  KE: {
    dialCode: "+254",
    dialingDigits: "254",
    onboardingPlaceholder: "e.g. 0712345678",
    otpPlaceholder: "0712345678",
    validationMessage: "Enter a valid Kenyan phone number."
  },
  NG: {
    dialCode: "+234",
    dialingDigits: "234",
    onboardingPlaceholder: "e.g. 08031234567",
    otpPlaceholder: "08031234567",
    validationMessage: "Enter a valid Nigerian phone number."
  },
  US: {
    dialCode: "+1",
    dialingDigits: "1",
    onboardingPlaceholder: "e.g. 2125551234",
    otpPlaceholder: "2125551234",
    validationMessage: "Enter a valid US phone number."
  },
  ZA: {
    dialCode: "+27",
    dialingDigits: "27",
    onboardingPlaceholder: "e.g. 0821234567",
    otpPlaceholder: "0821234567",
    validationMessage: "Enter a valid South African phone number."
  }
};

export const COUNTRIES = [
  { id: "AF", name: "Afghanistan" },
  { id: "AX", name: "Åland Islands" },
  { id: "AL", name: "Albania" },
  { id: "DZ", name: "Algeria" },
  { id: "AS", name: "American Samoa" },
  { id: "AD", name: "Andorra" },
  { id: "AO", name: "Angola" },
  { id: "AI", name: "Anguilla" },
  { id: "AQ", name: "Antarctica" },
  { id: "AG", name: "Antigua & Barbuda" },
  { id: "AR", name: "Argentina" },
  { id: "AM", name: "Armenia" },
  { id: "AW", name: "Aruba" },
  { id: "AU", name: "Australia" },
  { id: "AT", name: "Austria" },
  { id: "AZ", name: "Azerbaijan" },
  { id: "BS", name: "Bahamas" },
  { id: "BH", name: "Bahrain" },
  { id: "BD", name: "Bangladesh" },
  { id: "BB", name: "Barbados" },
  { id: "BY", name: "Belarus" },
  { id: "BE", name: "Belgium" },
  { id: "BZ", name: "Belize" },
  { id: "BJ", name: "Benin" },
  { id: "BM", name: "Bermuda" },
  { id: "BT", name: "Bhutan" },
  { id: "BO", name: "Bolivia" },
  { id: "BA", name: "Bosnia & Herzegovina" },
  { id: "BW", name: "Botswana" },
  { id: "BV", name: "Bouvet Island" },
  { id: "BR", name: "Brazil" },
  { id: "IO", name: "British Indian Ocean Territory" },
  { id: "VG", name: "British Virgin Islands" },
  { id: "BN", name: "Brunei" },
  { id: "BG", name: "Bulgaria" },
  { id: "BF", name: "Burkina Faso" },
  { id: "BI", name: "Burundi" },
  { id: "KH", name: "Cambodia" },
  { id: "CM", name: "Cameroon" },
  { id: "CA", name: "Canada" },
  { id: "CV", name: "Cape Verde" },
  { id: "BQ", name: "Caribbean Netherlands" },
  { id: "KY", name: "Cayman Islands" },
  { id: "CF", name: "Central African Republic" },
  { id: "TD", name: "Chad" },
  { id: "CL", name: "Chile" },
  { id: "CN", name: "China" },
  { id: "CX", name: "Christmas Island" },
  { id: "CC", name: "Cocos (Keeling) Islands" },
  { id: "CO", name: "Colombia" },
  { id: "KM", name: "Comoros" },
  { id: "CG", name: "Congo - Brazzaville" },
  { id: "CD", name: "Congo - Kinshasa" },
  { id: "CK", name: "Cook Islands" },
  { id: "CR", name: "Costa Rica" },
  { id: "CI", name: "Côte d'Ivoire" },
  { id: "HR", name: "Croatia" },
  { id: "CU", name: "Cuba" },
  { id: "CW", name: "Curaçao" },
  { id: "CY", name: "Cyprus" },
  { id: "CZ", name: "Czechia" },
  { id: "DK", name: "Denmark" },
  { id: "DJ", name: "Djibouti" },
  { id: "DM", name: "Dominica" },
  { id: "DO", name: "Dominican Republic" },
  { id: "EC", name: "Ecuador" },
  { id: "EG", name: "Egypt" },
  { id: "SV", name: "El Salvador" },
  { id: "GQ", name: "Equatorial Guinea" },
  { id: "ER", name: "Eritrea" },
  { id: "EE", name: "Estonia" },
  { id: "SZ", name: "Eswatini" },
  { id: "ET", name: "Ethiopia" },
  { id: "FK", name: "Falkland Islands" },
  { id: "FO", name: "Faroe Islands" },
  { id: "FJ", name: "Fiji" },
  { id: "FI", name: "Finland" },
  { id: "FR", name: "France" },
  { id: "GF", name: "French Guiana" },
  { id: "PF", name: "French Polynesia" },
  { id: "TF", name: "French Southern Territories" },
  { id: "GA", name: "Gabon" },
  { id: "GM", name: "Gambia" },
  { id: "GE", name: "Georgia" },
  { id: "DE", name: "Germany" },
  { id: "GH", name: "Ghana" },
  { id: "GI", name: "Gibraltar" },
  { id: "GR", name: "Greece" },
  { id: "GL", name: "Greenland" },
  { id: "GD", name: "Grenada" },
  { id: "GP", name: "Guadeloupe" },
  { id: "GU", name: "Guam" },
  { id: "GT", name: "Guatemala" },
  { id: "GG", name: "Guernsey" },
  { id: "GN", name: "Guinea" },
  { id: "GW", name: "Guinea-Bissau" },
  { id: "GY", name: "Guyana" },
  { id: "HT", name: "Haiti" },
  { id: "HM", name: "Heard & McDonald Islands" },
  { id: "HN", name: "Honduras" },
  { id: "HK", name: "Hong Kong SAR China" },
  { id: "HU", name: "Hungary" },
  { id: "IS", name: "Iceland" },
  { id: "IN", name: "India" },
  { id: "ID", name: "Indonesia" },
  { id: "IR", name: "Iran" },
  { id: "IQ", name: "Iraq" },
  { id: "IE", name: "Ireland" },
  { id: "IM", name: "Isle of Man" },
  { id: "IL", name: "Israel" },
  { id: "IT", name: "Italy" },
  { id: "JM", name: "Jamaica" },
  { id: "JP", name: "Japan" },
  { id: "JE", name: "Jersey" },
  { id: "JO", name: "Jordan" },
  { id: "KZ", name: "Kazakhstan" },
  { id: "KE", name: "Kenya" },
  { id: "KI", name: "Kiribati" },
  { id: "KW", name: "Kuwait" },
  { id: "KG", name: "Kyrgyzstan" },
  { id: "LA", name: "Laos" },
  { id: "LV", name: "Latvia" },
  { id: "LB", name: "Lebanon" },
  { id: "LS", name: "Lesotho" },
  { id: "LR", name: "Liberia" },
  { id: "LY", name: "Libya" },
  { id: "LI", name: "Liechtenstein" },
  { id: "LT", name: "Lithuania" },
  { id: "LU", name: "Luxembourg" },
  { id: "MO", name: "Macao SAR China" },
  { id: "MG", name: "Madagascar" },
  { id: "MW", name: "Malawi" },
  { id: "MY", name: "Malaysia" },
  { id: "MV", name: "Maldives" },
  { id: "ML", name: "Mali" },
  { id: "MT", name: "Malta" },
  { id: "MH", name: "Marshall Islands" },
  { id: "MQ", name: "Martinique" },
  { id: "MR", name: "Mauritania" },
  { id: "MU", name: "Mauritius" },
  { id: "YT", name: "Mayotte" },
  { id: "MX", name: "Mexico" },
  { id: "FM", name: "Micronesia" },
  { id: "MD", name: "Moldova" },
  { id: "MC", name: "Monaco" },
  { id: "MN", name: "Mongolia" },
  { id: "ME", name: "Montenegro" },
  { id: "MS", name: "Montserrat" },
  { id: "MA", name: "Morocco" },
  { id: "MZ", name: "Mozambique" },
  { id: "MM", name: "Myanmar (Burma)" },
  { id: "NA", name: "Namibia" },
  { id: "NR", name: "Nauru" },
  { id: "NP", name: "Nepal" },
  { id: "NL", name: "Netherlands" },
  { id: "NC", name: "New Caledonia" },
  { id: "NZ", name: "New Zealand" },
  { id: "NI", name: "Nicaragua" },
  { id: "NE", name: "Niger" },
  { id: "NG", name: "Nigeria" },
  { id: "NU", name: "Niue" },
  { id: "NF", name: "Norfolk Island" },
  { id: "KP", name: "North Korea" },
  { id: "MK", name: "North Macedonia" },
  { id: "MP", name: "Northern Mariana Islands" },
  { id: "NO", name: "Norway" },
  { id: "OM", name: "Oman" },
  { id: "PK", name: "Pakistan" },
  { id: "PW", name: "Palau" },
  { id: "PS", name: "Palestinian Territories" },
  { id: "PA", name: "Panama" },
  { id: "PG", name: "Papua New Guinea" },
  { id: "PY", name: "Paraguay" },
  { id: "PE", name: "Peru" },
  { id: "PH", name: "Philippines" },
  { id: "PN", name: "Pitcairn Islands" },
  { id: "PL", name: "Poland" },
  { id: "PT", name: "Portugal" },
  { id: "PR", name: "Puerto Rico" },
  { id: "QA", name: "Qatar" },
  { id: "RE", name: "Réunion" },
  { id: "RO", name: "Romania" },
  { id: "RU", name: "Russia" },
  { id: "RW", name: "Rwanda" },
  { id: "WS", name: "Samoa" },
  { id: "SM", name: "San Marino" },
  { id: "ST", name: "São Tomé & Príncipe" },
  { id: "SA", name: "Saudi Arabia" },
  { id: "SN", name: "Senegal" },
  { id: "RS", name: "Serbia" },
  { id: "SC", name: "Seychelles" },
  { id: "SL", name: "Sierra Leone" },
  { id: "SG", name: "Singapore" },
  { id: "SX", name: "Sint Maarten" },
  { id: "SK", name: "Slovakia" },
  { id: "SI", name: "Slovenia" },
  { id: "SB", name: "Solomon Islands" },
  { id: "SO", name: "Somalia" },
  { id: "ZA", name: "South Africa" },
  { id: "GS", name: "South Georgia & South Sandwich Islands" },
  { id: "KR", name: "South Korea" },
  { id: "SS", name: "South Sudan" },
  { id: "ES", name: "Spain" },
  { id: "LK", name: "Sri Lanka" },
  { id: "BL", name: "St. Barthélemy" },
  { id: "SH", name: "St. Helena" },
  { id: "KN", name: "St. Kitts & Nevis" },
  { id: "LC", name: "St. Lucia" },
  { id: "MF", name: "St. Martin" },
  { id: "PM", name: "St. Pierre & Miquelon" },
  { id: "VC", name: "St. Vincent & Grenadines" },
  { id: "SD", name: "Sudan" },
  { id: "SR", name: "Suriname" },
  { id: "SJ", name: "Svalbard & Jan Mayen" },
  { id: "SE", name: "Sweden" },
  { id: "CH", name: "Switzerland" },
  { id: "SY", name: "Syria" },
  { id: "TW", name: "Taiwan" },
  { id: "TJ", name: "Tajikistan" },
  { id: "TZ", name: "Tanzania" },
  { id: "TH", name: "Thailand" },
  { id: "TL", name: "Timor-Leste" },
  { id: "TG", name: "Togo" },
  { id: "TK", name: "Tokelau" },
  { id: "TO", name: "Tonga" },
  { id: "TT", name: "Trinidad & Tobago" },
  { id: "TN", name: "Tunisia" },
  { id: "TR", name: "Türkiye" },
  { id: "TM", name: "Turkmenistan" },
  { id: "TC", name: "Turks & Caicos Islands" },
  { id: "TV", name: "Tuvalu" },
  { id: "UM", name: "U.S. Outlying Islands" },
  { id: "VI", name: "U.S. Virgin Islands" },
  { id: "UG", name: "Uganda" },
  { id: "UA", name: "Ukraine" },
  { id: "AE", name: "United Arab Emirates" },
  { id: "GB", name: "United Kingdom" },
  { id: "US", name: "United States" },
  { id: "UY", name: "Uruguay" },
  { id: "UZ", name: "Uzbekistan" },
  { id: "VU", name: "Vanuatu" },
  { id: "VA", name: "Vatican City" },
  { id: "VE", name: "Venezuela" },
  { id: "VN", name: "Vietnam" },
  { id: "WF", name: "Wallis & Futuna" },
  { id: "EH", name: "Western Sahara" },
  { id: "YE", name: "Yemen" },
  { id: "ZM", name: "Zambia" },
  { id: "ZW", name: "Zimbabwe" }
];

COUNTRIES.forEach((country) => {
  country.icon = "🌍";
});

export const REGION_CURRENCY_MAP = {
  NG: "NGN", US: "USD", GB: "GBP", GH: "GHS", KE: "KES", ZA: "ZAR",
  CA: "CAD", AU: "AUD", EU: "EUR", DE: "EUR", FR: "EUR", IN: "INR"
};

export const CAPTURE_EXAMPLES = {
  NG: [
    "Sold 3 bags of rice for 75,000",
    "Paid supplier 45,000",
    "Received rent 150,000",
    "Bought fuel for 12,500",
    "Customer paid 28,000"
  ],
  US: [
    "Sold 50 units for 385",
    "Paid vendor 1,200",
    "Received payment 2,500",
    "Bought supplies for 89",
    "Client paid 450"
  ],
  DEFAULT: [
    "Sold 12 items for 450",
    "Paid supplier 120",
    "Received customer payment 250",
    "Bought stock for 80",
    "Client paid 600"
  ]
};

export const BUSINESS_TYPES = [
  { id: "ng_market_trader", country: "NG", sector_id: "trade_retail", name: "Market Trader", icon: "🧺" },
  { id: "ng_provision_shop", country: "NG", sector_id: "trade_retail", name: "Provision Shop", icon: "🏪" },
  { id: "ng_food_vendor", country: "NG", sector_id: "food_hospitality", name: "Food Vendor", icon: "🍛" },
  { id: "ng_transport_worker", country: "NG", sector_id: "transport_logistics", name: "Transport Worker", icon: "🛺" },
  { id: "ng_artisan", country: "NG", sector_id: "skilled_construction", name: "Artisan", icon: "🛠️" },
  { id: "ng_service_provider", country: "NG", sector_id: "personal_professional", name: "Service Provider", icon: "🧾" },
  { id: "ng_online_seller", country: "NG", sector_id: "digital_online", name: "Online Seller", icon: "📱" },
  { id: "ng_kiosk_phone_business", country: "NG", sector_id: "digital_online", name: "Kiosk / Phone Business", icon: "📞" },
  { id: "ng_fashion_tailor", country: "NG", sector_id: "personal_professional", name: "Fashion / Tailor", icon: "🧵" },
  { id: "ng_okada_keke_rider", country: "NG", sector_id: "transport_logistics", name: "Okada / Keke Rider", icon: "🛵" },
  { id: "us_retail", country: "US", sector_id: "trade_retail", name: "Retail", icon: "🛍️" },
  { id: "us_food_service", country: "US", sector_id: "food_hospitality", name: "Food Service", icon: "🍔" },
  { id: "us_logistics", country: "US", sector_id: "transport_logistics", name: "Logistics", icon: "🚚" },
  { id: "us_contractor", country: "US", sector_id: "skilled_construction", name: "Contractor", icon: "🔨" },
  { id: "us_beauty_services", country: "US", sector_id: "personal_professional", name: "Beauty Services", icon: "💇" },
  { id: "us_digital_business", country: "US", sector_id: "digital_online", name: "Digital Business", icon: "🧑‍💻" },
  { id: "us_personal_services_side_hustle", country: "US", sector_id: "personal_professional", name: "Personal Services / Side Hustle", icon: "🧹" },
  { id: "global_trade_retail", country: "GLOBAL", sector_id: "trade_retail", name: "Retail / Trading", icon: "🛍️" },
  { id: "global_food_hospitality", country: "GLOBAL", sector_id: "food_hospitality", name: "Food & Hospitality", icon: "🍽️" },
  { id: "global_transport_logistics", country: "GLOBAL", sector_id: "transport_logistics", name: "Transport & Logistics", icon: "🚚" },
  { id: "global_skilled_construction", country: "GLOBAL", sector_id: "skilled_construction", name: "Skilled Work / Construction", icon: "🛠️" },
  { id: "global_personal_professional", country: "GLOBAL", sector_id: "personal_professional", name: "Personal / Professional Services", icon: "💼" },
  { id: "global_digital_online", country: "GLOBAL", sector_id: "digital_online", name: "Digital / Online Business", icon: "💻" }
];

export const QUICK_PICKS = {
  ng_market_trader: {
    sell: ["Rice", "Beans", "Garri", "Tomatoes", "Pepper", "Palm Oil", "Yam", "Onion"],
    purchase: ["Rice Stock", "Beans Stock", "Palm Oil Stock", "Tomato Crate", "Pepper Bag", "Nylon Bags"],
    payment: ["Transport", "Market Fee", "Stall Rent", "Packaging", "Helper Pay", "Generator Fuel"],
    receipt: ["Customer Payment", "POS Payment", "Debt Collected", "Esusu Payout"]
  },
  ng_provision_shop: {
    sell: ["Drinks", "Noodles", "Biscuits", "Sugar", "Bread", "Water", "Toiletries", "Airtime"],
    purchase: ["Drinks Stock", "Noodles Carton", "Biscuit Carton", "Sugar Stock", "Bread Stock", "Airtime Float"],
    payment: ["Shop Rent", "Electricity", "Transport", "Staff Pay", "Generator Fuel"],
    receipt: ["Customer Payment", "POS Payment", "Debt Collected"]
  },
  ng_food_vendor: {
    sell: ["Swallow & Soup", "Rice Meal", "Snacks", "Drinks", "Protein", "Catering", "Takeaway", "Breakfast"],
    purchase: ["Grains/Staples", "Oil", "Vegetables", "Protein/Meat", "Cooking Gas", "Packaging", "Seasoning", "Firewood"],
    payment: ["Stall Rent", "Helper Pay", "Transport", "Packaging", "Cooking Gas", "Market Fee"],
    receipt: ["Customer Payment", "Bulk Order Payment", "Debt Collected"]
  },
  ng_transport_worker: {
    sell: ["Trip Fare", "Delivery Fee", "Charter", "Loading Fee", "Extra Seat"],
    purchase: ["Fuel", "Engine Oil", "Spare Parts", "Tyres"],
    payment: ["Fuel", "Motor Levy", "Parking Fee", "Repair", "Driver Pay", "Car Wash"],
    receipt: ["Passenger Payment", "Delivery Payment", "Charter Payment"]
  },
  ng_artisan: {
    sell: ["Repair Job", "Labour", "Installation", "Maintenance", "Inspection"],
    purchase: ["Materials", "Spare Parts", "Tools", "Fittings"],
    payment: ["Transport", "Helper Pay", "Workshop Rent", "Generator Fuel", "Phone/Data"],
    receipt: ["Job Payment", "Deposit", "Balance Payment", "Refund Received"]
  },
  ng_service_provider: {
    sell: ["Service Fee", "Consultation", "Project Fee", "Training", "Admin Service"],
    purchase: ["Materials", "Data Bundle", "Office Supplies"],
    payment: ["Transport", "Data/Internet", "Office Rent", "Assistant Pay", "Marketing"],
    receipt: ["Client Payment", "Deposit", "Balance"]
  },
  ng_online_seller: {
    sell: ["Products", "Delivery Charged", "Wholesale Order", "Custom Order"],
    purchase: ["Inventory", "Packaging", "Product Photos"],
    payment: ["Shipping Cost", "Marketplace Fee", "Marketing Boost", "Data/Internet"],
    receipt: ["Customer Transfer", "POS/Link Payment", "Deposit"]
  },
  ng_kiosk_phone_business: {
    sell: ["Airtime", "Data Bundle", "Transfer Fee", "Electricity Credit", "Cable Sub", "Print/Photocopy"],
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
  ng_okada_keke_rider: {
    sell: ["Passenger Fare", "Errand Trip", "Delivery Run"],
    purchase: ["Fuel", "Spare Parts", "Tyres"],
    payment: ["Fuel", "Union Levy", "Repair", "Tyre", "Bike Loan"],
    receipt: ["Passenger Payment", "Delivery Payment", "Debt Collected"]
  },
  us_retail: {
    sell: ["Products", "Merchandise", "Gift Items", "Accessories", "Online Sale"],
    purchase: ["Inventory", "Supplies", "Packaging", "Labels/Tags"],
    payment: ["Rent", "Utilities", "Shipping Cost", "Staff Pay", "Card Fees"],
    receipt: ["Customer Payment", "Online Order Payment", "Deposit"]
  },
  us_food_service: {
    sell: ["Meals", "Drinks", "Snacks", "Catering", "Delivery", "Desserts"],
    purchase: ["Ingredients", "Meat/Protein", "Packaging", "Produce", "Cooking Oil"],
    payment: ["Rent", "Utilities", "Staff Pay", "Delivery App Fee", "Permits"],
    receipt: ["Customer Payment", "Catering Deposit", "Delivery App Payout"]
  },
  us_logistics: {
    sell: ["Delivery Job", "Route Pay", "Freight Job", "Rush Delivery", "Charter Trip", "Moving Job"],
    purchase: ["Vehicle Fuel", "Tires", "Parts", "Safety Gear"],
    payment: ["Fuel", "Repairs", "Insurance", "Tolls", "Truck Payment", "Parking", "Phone/Data", "Driver Pay"],
    receipt: ["Client Payment", "Marketplace Payout", "Tip", "Reimbursement"]
  },
  us_contractor: {
    sell: ["Labor", "Project Fee", "Installation", "Repair Job", "Inspection"],
    purchase: ["Materials", "Equipment Rental", "Tools", "Safety Gear"],
    payment: ["Subcontractor Pay", "Permits", "Fuel", "Disposal", "Helper Pay"],
    receipt: ["Client Payment", "Deposit", "Progress Payment", "Final Balance"]
  },
  us_beauty_services: {
    sell: ["Hair Service", "Nails", "Treatment", "Makeup", "Lashes", "Product Sale"],
    purchase: ["Supplies", "Products", "Equipment"],
    payment: ["Booth Rent", "Staff Pay", "Training", "Booking App Fee"],
    receipt: ["Client Payment", "Deposit", "Tip"]
  },
  us_digital_business: {
    sell: ["Project Fee", "Consultation", "Retainer", "Digital Product", "Recurring Service"],
    purchase: ["Software", "Equipment", "Domain/Hosting"],
    payment: ["Software Tools", "Marketing", "Contractor Pay", "Internet", "Marketplace Fee"],
    receipt: ["Client Payment", "Marketplace Payout", "Affiliate Payout"]
  },
  us_personal_services_side_hustle: {
    sell: ["Cleaning Job", "Dog Walking", "Babysitting", "Tutoring", "Lawn Care", "Photography", "Car Detailing", "Rideshare", "Power Washing", "Moving Help"],
    purchase: ["Cleaning Supplies", "Equipment"],
    payment: ["Gas", "App Fee", "Equipment", "Background Check", "Cleaning Supplies"],
    receipt: ["Client Payment", "Tip", "Reimbursement", "App Payout"]
  },
  global_trade_retail: {
    sell: ["Products", "Merchandise", "Accessories", "Online Sale", "Wholesale Order"],
    purchase: ["Inventory", "Supplies", "Packaging", "Labels", "General Restock"],
    payment: ["Rent", "Transport", "Utilities", "Staff Pay", "Marketplace Fee"],
    receipt: ["Customer Payment", "Deposit", "Transfer Received", "Supplier Refund"]
  },
  global_food_hospitality: {
    sell: ["Meals", "Drinks", "Snacks", "Catering", "Delivery Order"],
    purchase: ["Ingredients", "Packaging", "Produce", "Cooking Fuel", "Beverage Stock"],
    payment: ["Rent", "Transport", "Helper Pay", "Utilities", "Cleaning Supplies"],
    receipt: ["Customer Payment", "Catering Deposit", "Bulk Order Payment", "Refund Received"]
  },
  global_transport_logistics: {
    sell: ["Trip Fare", "Delivery Fee", "Charter", "Route Pay", "Moving Job"],
    purchase: ["Fuel", "Spare Parts", "Tyres", "Safety Gear", "Vehicle Supplies"],
    payment: ["Fuel", "Repairs", "Parking", "Tolls", "Driver Pay"],
    receipt: ["Client Payment", "Delivery Payment", "Charter Payment", "Reimbursement"]
  },
  global_skilled_construction: {
    sell: ["Labour", "Project Fee", "Installation", "Repair Job", "Inspection"],
    purchase: ["Materials", "Tools", "Equipment Rental", "Safety Gear", "Supplies"],
    payment: ["Transport", "Helper Pay", "Permits", "Fuel", "Equipment Repair"],
    receipt: ["Client Payment", "Deposit", "Progress Payment", "Final Balance"]
  },
  global_personal_professional: {
    sell: ["Service Fee", "Consultation", "Project Fee", "Treatment", "Training"],
    purchase: ["Materials", "Supplies", "Products", "Equipment", "Office Supplies"],
    payment: ["Rent", "Transport", "Utilities", "Staff Pay", "Marketing"],
    receipt: ["Client Payment", "Deposit", "Tip", "Referral Payment"]
  },
  global_digital_online: {
    sell: ["Project Fee", "Consultation", "Digital Product", "Recurring Service", "Online Sale"],
    purchase: ["Software", "Equipment", "Domain/Hosting", "Packaging", "Product Photos"],
    payment: ["Internet", "Marketplace Fee", "Marketing", "Contractor Pay", "Shipping Cost"],
    receipt: ["Client Payment", "Marketplace Payout", "Affiliate Payout", "Transfer Received"]
  }
};

export const LAYER_B = {
  NG: {
    ng_market_trader: {
      sell: ["Rice", "Beans", "Garri", "Tomatoes", "Pepper", "Palm Oil", "Yam", "Onion", "Groundnuts", "Vegetable Oil", "Crayfish", "Stock Fish", "Egusi", "Plantain", "Maize", "Millet", "Garden Egg", "Okra", "Ugu", "Bitter Leaf", "Sweet Potato", "Cocoyam", "Banana", "Soybeans", "Groundnut Oil", "Seasoning Cubes", "Salt", "Tomato Paste", "Ogi", "Soft Drinks", "Pure Water", "Zobo", "Kunu"],
      buy: ["Rice Stock", "Beans Stock", "Palm Oil Stock", "Tomato Crate", "Pepper Bag", "Nylon Bags", "Garri Stock", "Yam Stock", "Onion Bag", "Groundnut Stock", "Vegetable Oil Stock", "Crayfish Stock", "Dried Fish Stock", "Egusi Stock", "Seasoning Stock", "Salt Stock", "Wholesale Goods", "Storage Sacks", "Plastic Containers", "Weighing Scale", "Crates/Trays"],
      pay: ["Transport", "Market Fee", "Stall Rent", "Packaging", "Helper Pay", "Generator Fuel", "Mobile Data", "Electricity", "Porter Pay", "Cold Room Fee", "Association Dues", "Loading Fee", "Vehicle Hire", "Shop Repair", "Security Fee", "Cleaning Supplies", "Waste Disposal", "Record Keeper"],
      receive: ["Customer Payment", "POS Payment", "Debt Collected", "Esusu Payout", "Family Support", "Supplier Refund", "Association Refund", "Government Support", "NGO Grant", "Bank Transfer"]
    },
    ng_provision_shop: {
      sell: ["Drinks", "Noodles", "Biscuits", "Sugar", "Bread", "Water", "Toiletries", "Airtime", "Detergent", "Milk", "Eggs", "Tin Tomato", "Sardine", "Corned Beef", "Groundnut Oil", "Vegetable Oil", "Seasoning", "Salt", "Flour", "Spaghetti", "Rice", "Beans", "Garri", "Snacks", "Ice Cream", "Yoghurt", "Juice", "Energy Drinks", "Recharge Cards", "Data Bundle", "Baby Food", "Diapers", "Sanitary Pads", "Soap", "Cream", "Toothpaste", "Tissue", "Matches", "Candles", "Stationery", "Cosmetics", "Cleaning Products", "Household Items"],
      buy: ["Drinks Stock", "Noodles Carton", "Biscuit Carton", "Sugar Stock", "Bread Stock", "Airtime Float", "Toiletries Stock", "Detergent Stock", "Milk Stock", "Egg Crate", "Tin Tomato Stock", "Sardine Carton", "Snack Carton", "Juice Carton", "Rice Stock", "Beans Stock", "Garri Stock", "Seasoning Stock", "Flour Stock", "Baby Food Stock", "Soap Stock", "Cream Stock", "Wholesale Restock", "Nylon Bags", "Shelving", "General Restock"],
      pay: ["Shop Rent", "Electricity", "Transport", "Staff Pay", "Generator Fuel", "Mobile Data", "Packaging", "Shop Repair", "Security Fee", "Association Dues", "Waste Disposal", "Water Supply", "Delivery Cost", "Cleaning Supplies"],
      receive: ["Customer Payment", "POS Payment", "Debt Collected", "Supplier Refund", "Esusu Payout", "Family Support", "Bank Transfer"]
    },
    ng_food_vendor: {
      sell: ["Rice Meal", "Soup", "Swallow", "Snacks", "Drinks", "Fish", "Chicken", "Catering", "Jollof Rice", "Fried Rice", "Egusi Soup", "Ogbono Soup", "Okra Soup", "Pepper Soup", "Pounded Yam", "Eba", "Amala", "Semo", "Fufu", "Tuwo Shinkafa", "Tuwo Masara", "Masa", "Kosai", "Suya", "Moin Moin", "Akara", "Ogi", "Boli", "Asun", "Ofada Rice", "Abacha", "Nkwobi", "Afang Soup", "Yam Porridge", "Beans Porridge", "Puff Puff", "Meat Pie", "Egg Roll", "Scotch Egg", "Chin Chin", "Zobo", "Kunu", "Smoothie", "Fresh Juice", "Chapman", "Goat Meat", "Tilapia", "Grilled Fish", "Small Chops", "Party Pack", "Takeaway", "Delivery Order"],
      buy: ["Rice Stock", "Oil", "Tomatoes", "Pepper", "Meat/Fish", "Gas", "Packaging", "Seasoning", "Firewood", "Vegetables", "Egusi", "Crayfish", "Stock Fish", "Beans", "Yam", "Plantain", "Garri", "Semovita", "Palm Oil", "Onions", "Spices", "Maggi", "Salt", "Water", "Charcoal", "Takeaway Packs", "Nylons", "Plates/Cutlery", "Drinks Stock", "Ice", "Frozen Chicken", "Goat", "Prawns", "Smoked Fish"],
      pay: ["Stall Rent", "Helper Pay", "Transport", "Packaging", "Cooking Gas", "Water Supply", "Electricity", "Generator Fuel", "Firewood", "Market Fee", "Waste Disposal", "Kitchen Rent", "Equipment Repair", "Cleaning Supplies", "Aprons", "Mobile Data", "Association Dues", "Delivery Rider", "Cold Room Fee"],
      receive: ["Customer Payment", "Bulk Order Payment", "Debt Collected", "Catering Deposit", "Event Payment", "Supplier Refund", "Esusu Payout", "Bank Transfer"]
    },
    ng_transport_worker: {
      sell: ["Trip Fare", "Delivery Fee", "Charter", "Loading Fee", "Extra Seat", "Interstate Fare", "Haulage Income", "School Run", "Airport Trip", "Goods Delivery", "Dispatch Rider Job", "Moving Service"],
      buy: ["Fuel", "Engine Oil", "Tyres", "Spare Parts", "Battery", "Brake Pads", "Windscreen", "Filters", "Brake Fluid", "Lubricants", "Wipers", "Bulbs"],
      pay: ["Fuel", "Motor Levy", "Parking Fee", "Repair", "Driver Pay", "Car Wash", "Vehicle Registration", "Vehicle Insurance", "Mechanic", "Tyre Repair", "Vulcanizer", "Road Toll", "Union Dues", "Park Rent", "Vehicle Loan Payment", "Emission Test", "Mobile Data", "GPS Recurring Service"],
      receive: ["Passenger Payment", "Delivery Payment", "Charter Payment", "Fuel Advance", "Vehicle Loan", "Debt Collected", "Esusu Payout", "Family Support"]
    },
    ng_artisan: {
      sell: ["Repair Job", "Labour", "Installation", "Maintenance", "Inspection", "Electrical Work", "Plumbing Work", "Welding Job", "Carpentry Job", "Painting Job", "Tiling Job", "Roofing Job", "AC Repair", "Generator Repair", "Phone Repair", "Electronics Repair", "Furniture Making", "Steel Work", "Aluminum Work", "Borehole Service", "Fumigation Service"],
      buy: ["Materials", "Spare Parts", "Tools", "Fittings", "Paint", "Cement", "Tiles", "Wood", "Iron Rods", "Electrical Wire", "PVC Pipe", "Welding Rod", "Gas Cylinder", "Screws/Nails", "Primer", "Safety Gear", "Drill Bits", "Saw Blade", "Measuring Tape"],
      pay: ["Transport", "Helper Pay", "Workshop Rent", "Generator Fuel", "Phone/Data", "Tool Repair", "Electricity", "Protective Gear", "Association Dues", "Training Fee", "Equipment Servicing", "Van Hire", "Marketing"],
      receive: ["Job Payment", "Deposit", "Balance Payment", "Refund Received", "Materials Advance", "Contract Payment", "Esusu Payout"]
    },
    ng_service_provider: {
      sell: ["Service Fee", "Consultation", "Project Fee", "Training", "Admin Service", "Hair Styling", "Barbing", "Makeup", "Nail Service", "Facial", "Photography", "Videography", "Graphic Design", "Web Design", "Printing", "Photocopying", "Lamination", "Typing", "Event Planning", "DJ Service", "MC Service", "Security Service", "Cleaning Service", "Laundry Service", "Ironing Service", "Tutoring", "Driving Lesson", "Fitness Training", "Massage"],
      buy: ["Materials", "Data Bundle", "Office Supplies", "Printing Ink", "Paper", "Tools/Equipment", "Beauty Supplies", "Cleaning Supplies", "Uniforms", "Camera Accessories", "Studio Props", "Sound Equipment"],
      pay: ["Transport", "Data/Internet", "Office Rent", "Assistant Pay", "Marketing", "Electricity", "Generator Fuel", "Equipment Repair", "Training Fee", "Marketplace Fee", "Printing", "Association Dues", "Tax/Levy"],
      receive: ["Client Payment", "Deposit", "Balance", "Esusu Payout", "Referral Bonus", "Marketplace Payout", "Bank Transfer"]
    },
    ng_online_seller: {
      sell: ["Products", "Delivery Charged", "Wholesale Order", "Social Media Sale", "Custom Order", "Bundle Sale", "Clearance Sale", "Digital Download", "Recurring Box", "Gift Set", "Print-On-Demand", "Dropship Order"],
      buy: ["Inventory", "Packaging", "Data Bundle", "Product Photos", "Boxes", "Mailers", "Tissue Paper", "Poly Bags", "Tape", "Stickers", "Thank You Cards", "Branded Bags", "Ribbon", "Labels"],
      pay: ["Shipping Cost", "Marketplace Fee", "Marketing Boost", "Data/Internet", "Rider Payment", "Printing", "Storage", "Returns Processing", "Photography", "Marketplace Monthly", "Accounting Software", "Email Marketing", "Influencer Collab", "Packaging Design", "Customs Fee", "Fulfillment Fee", "Processor Fee"],
      receive: ["Customer Transfer", "Payment Link", "Deposit", "Marketplace Payout", "Refund Received", "Grant", "Affiliate Payout", "Chargeback Reversal"]
    }
  },
  US: {
    us_retail: {
      sell: ["Products", "Merchandise", "Gift Items", "Accessories", "Online Sale", "Clothing", "Shoes", "Jewelry", "Handbags", "Beauty Products", "Candles", "Home Decor", "Artwork", "Books", "Electronics", "Toys", "Thrift Items", "Sneaker Resale", "Vintage Items", "Custom T-Shirts", "Merch", "Gift Baskets", "Phone Cases", "Seasonal Items", "Pop-Up Sale", "Flea Market Sale", "Custom Hats", "Baby Items", "Pet Supplies"],
      buy: ["Inventory", "Supplies", "Packaging", "Labels/Tags", "Wholesale Clothing", "Thrift Haul", "Display/Fixtures", "Mailers", "Poly Bags", "Boxes", "Tape", "Hangers", "Tissue Paper", "Ribbon", "Stickers", "Receipt Paper", "Mannequins", "Shelving", "Shopping Bags", "Price Tags"],
      pay: ["Rent", "Utilities", "Shipping Cost", "Staff Pay", "Card Fees", "Storage Unit", "Marketing", "Business License", "Marketplace Fees", "Insurance", "Accounting", "Website/Domain", "Printer Ink", "Cleaning Supplies", "Security System", "POS Equipment Lease", "Booth Fee", "Event Fee", "Photography"],
      receive: ["Customer Payment", "Online Order Payment", "Deposit", "Supplier Refund", "Insurance Claim", "Grant", "Tax Refund", "Wallet Transfer"]
    },
    us_food_service: {
      sell: ["Meals", "Drinks", "Catering", "Delivery", "Desserts", "Baked Goods", "Custom Cake", "Cookies", "Cupcakes", "Bread", "Soul Food Plate", "BBQ", "Wings", "Fried Chicken", "Tacos", "Empanadas", "Jerk Chicken", "Meal Prep", "Fresh Juice", "Smoothie", "Coffee", "Tea", "Breakfast Plate", "Brunch Special", "Food Truck Special", "Catering Package", "Weekly Meal Plan", "Ice Cream"],
      buy: ["Ingredients", "Meat", "Packaging", "Produce", "Cooking Oil", "Dairy", "Baking Supplies", "Spices", "Beverages Stock", "Seafood", "Frozen Items", "Canned Goods", "Dry Goods", "Paper Goods", "Foil", "Gloves", "Cleaning Supplies", "Napkins", "Cups", "Lids", "Straws"],
      pay: ["Rent", "Utilities", "Staff Pay", "Delivery App Fee", "Permits", "Cooking Gas/Propane", "Equipment", "Kitchen Rental", "Event Fee", "Uniforms", "Food Handler Permit", "Health Inspection Fee", "Marketing", "Marketplace Commission", "Insurance", "Accounting", "Pest Control", "Grease Trap Service", "Refrigeration Repair", "Linen Service", "POS System", "Website/Online Ordering"],
      receive: ["Customer Payment", "Catering Deposit", "Delivery App Payout", "Event Deposit", "Supplier Refund", "Grant", "Insurance Claim", "Tip Pool", "Wallet Transfer", "Zelle"]
    },
    us_digital_business: {
      sell: ["Project Fee", "Consultation", "Retainer", "Digital Product", "Sponsor Revenue", "Social Media Management", "Video Editing", "Graphic Design", "Web Design", "Copywriting", "Virtual Assistant", "Course Sale", "E-Book Sale", "Template Sale", "Coaching Session", "Podcast Sponsorship", "Brand Deal", "YouTube Income", "TikTok Income", "Affiliate Income", "Print-On-Demand", "Stock Photo Sale", "UGC Content", "Newsletter Sponsorship", "Voice Over", "Translation", "Products", "Etsy Sale", "Amazon Sale", "Shopify Sale", "eBay Sale", "Instagram Sale", "TikTok Shop Sale", "Custom Order", "Bundle Sale", "Clearance Sale", "Recurring Box", "Gift Set", "Dropship Order"],
      buy: ["Software", "Equipment", "Domain/Hosting", "Camera/Gear", "Computer", "External Drive", "Props/Backdrops", "Merch Inventory", "Microphone", "Ring Light", "Tripod", "Green Screen", "Stock Photos", "Music License", "Inventory", "Packaging", "Product Photos", "Blank Apparel", "Boxes", "Mailers", "Tissue Paper", "Poly Bags", "Tape", "Stickers", "Thank You Cards", "Branded Bags", "Ribbon", "Labels"],
      pay: ["Software Tools", "Marketing", "Contractor Pay", "Internet", "Marketplace Fee", "Phone Plan", "Cloud Storage", "Email Marketing Tool", "Project Management Tool", "Accounting Software", "Legal Fee", "LLC Filing", "Taxes", "Health Insurance", "Co-working Space", "Training/Course", "Stock Assets", "Business Cards", "Website Maintenance", "CRM Tool", "Shipping Cost", "Storage", "Returns Processing", "Photography", "Influencer Collab", "Packaging Design", "Fulfillment Fee", "Processor Fee"],
      receive: ["Client Payment", "Marketplace Payout", "Affiliate Payout", "Deposit", "Grant", "Tax Refund", "Tip", "Wallet Transfer", "Zelle", "Wire Transfer", "Check Deposit", "Customer Payment", "Refund Received", "Chargeback Reversal"]
    },
    us_contractor: {
      sell: ["Labor", "Project Fee", "Installation", "Repair Job", "Inspection", "Roofing Job", "Plumbing Job", "Electrical Job", "HVAC Job", "Painting Job", "Drywall Job", "Flooring Job", "Landscaping", "Pressure Washing", "Fence Job", "Handyman Work", "Pool Service", "Snow Removal", "Tree Service", "Concrete Work", "Masonry", "Window Installation", "Door Installation", "Cabinet Install", "Deck Build", "Garage Door", "Gutter Install"],
      buy: ["Materials", "Equipment Rental", "Tools", "Safety Gear", "Lumber", "Concrete/Block", "Pipe/Plumbing", "Wire/Electrical", "Roofing Materials", "Flooring Materials", "Paint/Primer", "Fasteners", "Landscaping Supplies", "Chemicals", "Mulch/Soil", "Gravel/Stone", "Drywall", "Insulation", "Windows", "Doors", "Hardware", "Sealants/Caulk"],
      pay: ["Subcontractor Pay", "Permits", "Fuel", "Disposal", "Helper Pay", "Insurance", "Truck Payment", "Tool Rental", "Marketing", "Uniforms", "Accounting", "Legal Fee", "License Renewal", "Safety Training", "Equipment Servicing", "Background Checks", "PPE", "Vehicle Maintenance", "Storage Unit", "Phone Plan"],
      receive: ["Client Payment", "Deposit", "Progress Payment", "Final Balance", "Insurance Payout", "Grant", "Retainer", "Check Deposit", "Wire Transfer"]
    },
    us_beauty_services: {
      sell: ["Hair Service", "Nails", "Treatment", "Makeup", "Product Sale", "Lashes", "Box Braids", "Knotless Braids", "Cornrows", "Fulani Braids", "Starter Locs", "Loc Retwist", "Wash and Style", "Silk Press", "Wig Install", "Sew-In", "Color Service", "Barber Cut", "Shape-Up", "Kids Hair", "Acrylic Set", "Gel Nails", "Manicure", "Pedicure", "Nail Art", "Lash Extensions", "Microblading", "Brow Lamination", "Waxing", "Facial", "Bridal Makeup", "Massage", "Teeth Whitening", "Spray Tan"],
      buy: ["Supplies", "Products", "Equipment", "Braiding Hair", "Bundles/Wigs", "Nail Supplies", "Lash Supplies", "Color/Developer", "Wax Supplies", "Gloves/PPE", "Spa Supplies", "Towels/Linen", "Furniture", "Retail Stock", "Shampoo/Conditioner", "Styling Products", "Nail Polish", "Gel/Acrylic Powder"],
      pay: ["Booth Rent", "Staff Pay", "Training", "Booking App Fee", "Utilities", "Supplies Run", "Insurance", "Marketing", "Business Cards", "Website/Online Booking", "License Renewal", "Equipment Repair", "Laundry", "Cleaning", "Phone Plan", "Parking", "Accounting"],
      receive: ["Client Payment", "Deposit", "Tip", "Supplier Refund", "Grant", "Insurance Claim", "Wallet Transfer", "Zelle", "Cash App"]
    }
  }
};

export const EXTRA_SEARCH_LABELS = [
  buildLabel("tuwo_shinkafa_sale", "Tuwo Shinkafa", "🍲", ["tuwo", "rice tuwo"], ["sale"], ["NG"], ["ng_food_vendor"]),
  buildLabel("zobo_sale", "Zobo", "🥤", ["zobo drink"], ["sale"], ["NG"], ["ng_food_vendor"]),
  buildLabel("crayfish_sale", "Crayfish", "🦐", ["crayfish"], ["sale"], ["NG"], ["ng_market_trader"]),
  buildLabel("egusi_sale", "Egusi", "🥜", ["melon"], ["sale"], ["NG"], ["ng_market_trader"]),
  buildLabel("social_media_management_sale", "Social Media Mgmt", "📱", ["social media management"], ["sale"], ["US"], ["us_digital_business"]),
  buildLabel("video_editing_sale", "Video Editing", "🎬", ["editing"], ["sale"], ["US"], ["us_digital_business"]),
  buildLabel("box_braids_sale", "Box Braids", "💇", ["braids"], ["sale"], ["US"], ["us_beauty_services"]),
  buildLabel("car_detailing_sale", "Car Detailing", "🚗", ["detailing"], ["sale"], ["US"], ["us_personal_services_side_hustle"])
];

// Phase 4A — borrowing taxonomy labels. Global, served via the region
// fallback in getCatalogForProfileAction (empty business_types).
export const LIABILITY_LABELS = [
  buildLabel("liability_family_loan", "Family Loan", "👪", ["family loan", "relative loan"], ["liability_in"], ["GLOBAL"], []),
  buildLabel("liability_esusu_ajo", "Esusu/Ajo", "🤝", ["esusu", "ajo", "susu", "adashe"], ["liability_in"], ["GLOBAL"], []),
  buildLabel("liability_supplier_credit", "Supplier Credit", "📦", ["supplier credit", "trade credit", "goods on credit"], ["liability_in"], ["GLOBAL"], []),
  buildLabel("liability_bank_loan", "Bank Loan", "🏦", ["bank loan"], ["liability_in"], ["GLOBAL"], []),
  buildLabel("liability_cooperative_loan", "Cooperative Loan", "🧑‍🤝‍🧑", ["cooperative", "coop loan", "cooperative loan"], ["liability_in"], ["GLOBAL"], []),
  buildLabel("liability_loan_repayment", "Loan Repayment", "💵", ["loan repayment", "repayment", "payback", "paid back"], ["liability_out"], ["GLOBAL"], []),
  buildLabel("liability_installment", "Installment", "📆", ["installment", "instalment"], ["liability_out"], ["GLOBAL"], [])
];

export const PRIMARY_ACTIONS = [
  { id: "sale", label: "Sell", icon: "🟢", help: "Business sells goods or services." },
  { id: "purchase", label: "Buy", icon: "🛒", help: "Business buys stock or inputs." },
  { id: "payment", label: "Pay", icon: "💸", help: "Business pays money out." },
  { id: "receipt", label: "Receive", icon: "💰", help: "Business receives money in." }
];

export const TRANSFER_ACTIONS = [
  { id: "transfer_in", label: "Transfer In", icon: "⬇️", help: "Move money into this store of value." },
  { id: "transfer_out", label: "Transfer Out", icon: "⬆️", help: "Move money out to another store of value." }
];

// Phase 4A — borrowing taxonomy. Recorded separately from revenue/expense:
// liability_in / liability_out are never counted as income, expense, or net.
export const LIABILITY_ACTIONS = [
  { id: "liability_in", label: "Money Borrowed", icon: "📥", help: "Record money borrowed. Not sales or income." },
  { id: "liability_out", label: "Loan Repayment", icon: "📤", help: "Record a loan repayment you made." }
];

export function isLiabilityAction(action) {
  return action === "liability_in" || action === "liability_out";
}
