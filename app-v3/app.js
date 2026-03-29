import {
  getDefaultSyncApiBaseUrl,
  postJson,
  requestOtpCode,
  syncQueuedEntries,
  verifyOtpCode
} from "./syncWorker.js";

const DB_NAME = "confirma-v3-db";
const DB_VERSION = 5;
const FEATURE_TRANSFER_PRIMARY = false;
const PAYSTACK_PUBLIC_KEY = "pk_test_placeholder";
const MONTHLY_FREE_EXPORT_LIMIT = 3;
const PASSCODE_KDF_VERSION = "pbkdf2-sha256-v1";
const PASSCODE_PBKDF2_ITERATIONS = 210000;

const HOUSE_ADS = {
  interstitial: [
    {
      headline: "Know your credit score before they do",
      body: "30 days of Confirma records is worth more than a bank statement.",
      cta: "Keep recording →",
      brand: "Confirma Pro",
      action: () => {
        renderExportScreen();
        showScreen("screen-export");
      }
    },
    {
      headline: "Share your verified report with any lender",
      body: "Your daily records become tamper-proof proof of income.",
      cta: "Generate report →",
      brand: "Confirma",
      action: () => {
        renderExportScreen();
        showScreen("screen-export");
      }
    },
    {
      headline: "Upgrade to Pro — no ads, ever",
      body: "Unlimited exports, no interruptions, priority sync.",
      cta: "See plans →",
      brand: "Confirma Pro",
      action: () => {
        renderExportScreen();
        showScreen("screen-export");
      }
    }
  ],
  infeed: [
    {
      headline: "Tip: categorise transfers separately",
      body: "Transfers between your own accounts aren't income or expenses.",
      cta: "Learn more",
      brand: "Confirma Tips"
    },
    {
      headline: "Ready to share with a lender?",
      body: "Generate a Verified Report from your export screen.",
      cta: "Go to Export →",
      brand: "Confirma",
      action: () => {
        renderExportScreen();
        showScreen("screen-export");
      }
    }
  ],
  banner: [
    {
      headline: "Upgrade to Pro — no ads",
      cta: "See plans",
      brand: "Confirma Pro",
      action: () => {
        renderExportScreen();
        showScreen("screen-export");
      }
    }
  ]
};

const SECTORS = [
  { id: "trade_retail", name: "Trade & Retail", icon: "🛍️" },
  { id: "food_hospitality", name: "Food & Hospitality", icon: "🍲" },
  { id: "transport_logistics", name: "Transport & Logistics", icon: "🚌" },
  { id: "skilled_construction", name: "Skilled Work & Construction", icon: "🔧" },
  { id: "personal_professional", name: "Personal & Professional Services", icon: "💼" },
  { id: "digital_online", name: "Digital & Online Business", icon: "💻" }
];

const COUNTRIES = [
  { id: "US", name: "United States", icon: "🇺🇸" },
  { id: "NG", name: "Nigeria", icon: "🇳🇬" }
];

const CAPTURE_EXAMPLES = {
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
  ]
};

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
  ng_transport_operator: {
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
    payment: ["Shipping Cost", "Platform Fee", "Ad Boost", "Data/Internet"],
    receipt: ["Customer Transfer", "POS/Link Payment", "Deposit"]
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
    receipt: ["Client Payment", "Platform Payout", "Tip", "Reimbursement"]
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
    sell: ["Project Fee", "Consultation", "Retainer", "Digital Product", "Subscription"],
    purchase: ["Software", "Equipment", "Domain/Hosting"],
    payment: ["Subscriptions", "Ads", "Contractor Pay", "Internet", "Platform Fee"],
    receipt: ["Client Payment", "Platform Payout", "Affiliate Payout"]
  },
  us_personal_services_side_hustle: {
    sell: ["Cleaning Job", "Dog Walking", "Babysitting", "Tutoring", "Lawn Care", "Photography", "Car Detailing", "Rideshare", "Power Washing", "Moving Help"],
    purchase: ["Cleaning Supplies", "Equipment"],
    payment: ["Gas", "App Fee", "Equipment", "Background Check", "Cleaning Supplies"],
    receipt: ["Client Payment", "Tip", "Reimbursement", "App Payout"]
  }
};

const LAYER_B = {
  NG: {
    ng_market_trader: {
      sell: ["Rice", "Beans", "Garri", "Tomatoes", "Pepper", "Palm Oil", "Yam", "Onion", "Groundnuts", "Vegetable Oil", "Crayfish", "Stock Fish", "Egusi", "Plantain", "Maize", "Millet", "Garden Egg", "Okra", "Ugu", "Bitter Leaf", "Sweet Potato", "Cocoyam", "Banana", "Soybeans", "Groundnut Oil", "Seasoning Cubes", "Salt", "Tomato Paste", "Ogi", "Soft Drinks", "Pure Water", "Zobo", "Kunu"],
      buy: ["Rice Stock", "Beans Stock", "Palm Oil Stock", "Tomato Crate", "Pepper Bag", "Nylon Bags", "Garri Stock", "Yam Stock", "Onion Bag", "Groundnut Stock", "Vegetable Oil Stock", "Crayfish Stock", "Dried Fish Stock", "Egusi Stock", "Seasoning Stock", "Salt Stock", "Wholesale Goods", "Storage Sacks", "Plastic Containers", "Weighing Scale", "Crates/Trays"],
      pay: ["Transport", "Market Fee", "Stall Rent", "Packaging", "Helper Pay", "Generator Fuel", "Mobile Data", "Electricity", "Porter Pay", "Cold Room Fee", "Association Dues", "Loading Fee", "Vehicle Hire", "Shop Repair", "Security Fee", "Cleaning Supplies", "Waste Disposal", "Record Keeper"],
      receive: ["Customer Payment", "POS Payment", "Debt Collected", "Esusu Payout", "Family Support", "Supplier Refund", "Business Loan", "Association Refund", "Government Support", "NGO Grant", "Bank Transfer"]
    },
    ng_provision_shop: {
      sell: ["Drinks", "Noodles", "Biscuits", "Sugar", "Bread", "Water", "Toiletries", "Airtime", "Detergent", "Milk", "Eggs", "Tin Tomato", "Sardine", "Corned Beef", "Groundnut Oil", "Vegetable Oil", "Seasoning", "Salt", "Flour", "Spaghetti", "Rice", "Beans", "Garri", "Snacks", "Ice Cream", "Yoghurt", "Juice", "Energy Drinks", "Recharge Cards", "Data Bundle", "Baby Food", "Diapers", "Sanitary Pads", "Soap", "Cream", "Toothpaste", "Tissue", "Matches", "Candles", "Stationery", "Cosmetics", "Cleaning Products", "Household Items"],
      buy: ["Drinks Stock", "Noodles Carton", "Biscuit Carton", "Sugar Stock", "Bread Stock", "Airtime Float", "Toiletries Stock", "Detergent Stock", "Milk Stock", "Egg Crate", "Tin Tomato Stock", "Sardine Carton", "Snack Carton", "Juice Carton", "Rice Stock", "Beans Stock", "Garri Stock", "Seasoning Stock", "Flour Stock", "Baby Food Stock", "Soap Stock", "Cream Stock", "Wholesale Restock", "Nylon Bags", "Shelving", "General Restock"],
      pay: ["Shop Rent", "Electricity", "Transport", "Staff Pay", "Generator Fuel", "Mobile Data", "Packaging", "Shop Repair", "Security Fee", "Association Dues", "Waste Disposal", "Water Supply", "Delivery Cost", "Cleaning Supplies"],
      receive: ["Customer Payment", "POS Payment", "Debt Collected", "Supplier Refund", "Esusu Payout", "Family Support", "Business Loan", "Bank Transfer"]
    },
    ng_food_vendor: {
      sell: ["Rice Meal", "Soup", "Swallow", "Snacks", "Drinks", "Fish", "Chicken", "Catering", "Jollof Rice", "Fried Rice", "Egusi Soup", "Ogbono Soup", "Okra Soup", "Pepper Soup", "Pounded Yam", "Eba", "Amala", "Semo", "Fufu", "Tuwo Shinkafa", "Tuwo Masara", "Masa", "Kosai", "Suya", "Moin Moin", "Akara", "Ogi", "Boli", "Asun", "Ofada Rice", "Abacha", "Nkwobi", "Afang Soup", "Yam Porridge", "Beans Porridge", "Puff Puff", "Meat Pie", "Egg Roll", "Scotch Egg", "Chin Chin", "Zobo", "Kunu", "Smoothie", "Fresh Juice", "Chapman", "Goat Meat", "Tilapia", "Grilled Fish", "Small Chops", "Party Pack", "Takeaway", "Delivery Order"],
      buy: ["Rice Stock", "Oil", "Tomatoes", "Pepper", "Meat/Fish", "Gas", "Packaging", "Seasoning", "Firewood", "Vegetables", "Egusi", "Crayfish", "Stock Fish", "Beans", "Yam", "Plantain", "Garri", "Semovita", "Palm Oil", "Onions", "Spices", "Maggi", "Salt", "Water", "Charcoal", "Takeaway Packs", "Nylons", "Plates/Cutlery", "Drinks Stock", "Ice", "Frozen Chicken", "Goat", "Prawns", "Smoked Fish"],
      pay: ["Stall Rent", "Helper Pay", "Transport", "Packaging", "Cooking Gas", "Water Supply", "Electricity", "Generator Fuel", "Firewood", "Market Fee", "Waste Disposal", "Kitchen Rent", "Equipment Repair", "Cleaning Supplies", "Aprons", "Mobile Data", "Association Dues", "Delivery Rider", "Cold Room Fee"],
      receive: ["Customer Payment", "Bulk Order Payment", "Debt Collected", "Catering Deposit", "Event Payment", "Supplier Refund", "Esusu Payout", "Business Loan", "Bank Transfer"]
    },
    ng_transport_operator: {
      sell: ["Trip Fare", "Delivery Fee", "Charter", "Loading Fee", "Extra Seat", "Interstate Fare", "Haulage Income", "School Run", "Airport Trip", "Goods Delivery", "Dispatch Rider Job", "Moving Service"],
      buy: ["Fuel", "Engine Oil", "Tyres", "Spare Parts", "Battery", "Brake Pads", "Windscreen", "Filters", "Brake Fluid", "Lubricants", "Wipers", "Bulbs"],
      pay: ["Fuel", "Motor Levy", "Parking Fee", "Repair", "Driver Pay", "Car Wash", "Vehicle Registration", "Vehicle Insurance", "Mechanic", "Tyre Repair", "Vulcanizer", "Road Toll", "Union Dues", "Park Rent", "Vehicle Loan Payment", "Emission Test", "Mobile Data", "GPS Subscription"],
      receive: ["Passenger Payment", "Delivery Payment", "Charter Payment", "Fuel Advance", "Vehicle Loan", "Debt Collected", "Esusu Payout", "Family Support"]
    },
    ng_artisan: {
      sell: ["Repair Job", "Labour", "Installation", "Maintenance", "Inspection", "Electrical Work", "Plumbing Work", "Welding Job", "Carpentry Job", "Painting Job", "Tiling Job", "Roofing Job", "AC Repair", "Generator Repair", "Phone Repair", "Electronics Repair", "Furniture Making", "Steel Work", "Aluminum Work", "Borehole Service", "Fumigation Service"],
      buy: ["Materials", "Spare Parts", "Tools", "Fittings", "Paint", "Cement", "Tiles", "Wood", "Iron Rods", "Electrical Wire", "PVC Pipe", "Welding Rod", "Gas Cylinder", "Screws/Nails", "Primer", "Safety Gear", "Drill Bits", "Saw Blade", "Measuring Tape"],
      pay: ["Transport", "Helper Pay", "Workshop Rent", "Generator Fuel", "Phone/Data", "Tool Repair", "Electricity", "Protective Gear", "Association Dues", "Training Fee", "Equipment Servicing", "Van Hire", "Marketing"],
      receive: ["Job Payment", "Deposit", "Balance Payment", "Refund Received", "Materials Advance", "Contract Payment", "Esusu Payout", "Business Loan"]
    },
    ng_service_provider: {
      sell: ["Service Fee", "Consultation", "Project Fee", "Training", "Admin Service", "Hair Styling", "Barbing", "Makeup", "Nail Service", "Facial", "Photography", "Videography", "Graphic Design", "Web Design", "Printing", "Photocopying", "Lamination", "Typing", "Event Planning", "DJ Service", "MC Service", "Security Service", "Cleaning Service", "Laundry Service", "Ironing Service", "Tutoring", "Driving Lesson", "Fitness Training", "Massage"],
      buy: ["Materials", "Data Bundle", "Office Supplies", "Printing Ink", "Paper", "Tools/Equipment", "Beauty Supplies", "Cleaning Supplies", "Uniforms", "Camera Accessories", "Studio Props", "Sound Equipment"],
      pay: ["Transport", "Data/Internet", "Office Rent", "Assistant Pay", "Marketing", "Electricity", "Generator Fuel", "Equipment Repair", "Training Fee", "Platform Fee", "Printing", "Association Dues", "Tax/Levy"],
      receive: ["Client Payment", "Deposit", "Balance", "Esusu Payout", "Business Loan", "Referral Bonus", "Platform Payout", "Bank Transfer"]
    },
    ng_online_seller: {
      sell: ["Products", "Delivery Charged", "Wholesale Order", "Social Media Sale", "Custom Order", "Bundle Sale", "Clearance Sale", "Digital Download", "Subscription Box", "Gift Set", "Print-On-Demand", "Dropship Order"],
      buy: ["Inventory", "Packaging", "Data Bundle", "Product Photos", "Boxes", "Mailers", "Tissue Paper", "Poly Bags", "Tape", "Stickers", "Thank You Cards", "Branded Bags", "Ribbon", "Labels"],
      pay: ["Shipping Cost", "Platform Fee", "Ad Boost", "Data/Internet", "Rider Payment", "Printing", "Storage", "Returns Processing", "Photography", "Platform Monthly", "Accounting Software", "Email Marketing", "Influencer Collab", "Packaging Design", "Customs Fee", "Fulfillment Fee", "Paystack/Flutterwave Fee"],
      receive: ["Customer Transfer", "Payment Link", "Deposit", "Platform Payout", "Refund Received", "Business Loan", "Grant", "Affiliate Payout", "Chargeback Reversal"]
    }
  },
  US: {
    us_retail: {
      sell: ["Products", "Merchandise", "Gift Items", "Accessories", "Online Sale", "Clothing", "Shoes", "Jewelry", "Handbags", "Beauty Products", "Candles", "Home Decor", "Artwork", "Books", "Electronics", "Toys", "Thrift Items", "Sneaker Resale", "Vintage Items", "Custom T-Shirts", "Merch", "Gift Baskets", "Phone Cases", "Seasonal Items", "Pop-Up Sale", "Flea Market Sale", "Custom Hats", "Baby Items", "Pet Supplies"],
      buy: ["Inventory", "Supplies", "Packaging", "Labels/Tags", "Wholesale Clothing", "Thrift Haul", "Display/Fixtures", "Mailers", "Poly Bags", "Boxes", "Tape", "Hangers", "Tissue Paper", "Ribbon", "Stickers", "Receipt Paper", "Mannequins", "Shelving", "Shopping Bags", "Price Tags"],
      pay: ["Rent", "Utilities", "Shipping Cost", "Staff Pay", "Card Fees", "Storage Unit", "Marketing/Ads", "Business License", "Platform Fees", "Insurance", "Accounting", "Website/Domain", "Printer Ink", "Cleaning Supplies", "Security System", "POS Equipment Lease", "Booth Fee", "Event Fee", "Photography"],
      receive: ["Customer Payment", "Online Order Payment", "Deposit", "Supplier Refund", "Insurance Claim", "Business Loan", "Grant", "Tax Refund", "PayPal/Venmo"]
    },
    us_food_service: {
      sell: ["Meals", "Drinks", "Catering", "Delivery", "Desserts", "Baked Goods", "Custom Cake", "Cookies", "Cupcakes", "Bread", "Soul Food Plate", "BBQ", "Wings", "Fried Chicken", "Tacos", "Empanadas", "Jerk Chicken", "Meal Prep", "Fresh Juice", "Smoothie", "Coffee", "Tea", "Breakfast Plate", "Brunch Special", "Food Truck Special", "Catering Package", "Weekly Meal Plan", "Ice Cream"],
      buy: ["Ingredients", "Meat", "Packaging", "Produce", "Cooking Oil", "Dairy", "Baking Supplies", "Spices", "Beverages Stock", "Seafood", "Frozen Items", "Canned Goods", "Dry Goods", "Paper Goods", "Foil", "Gloves", "Cleaning Supplies", "Napkins", "Cups", "Lids", "Straws"],
      pay: ["Rent", "Utilities", "Staff Pay", "Delivery App Fee", "Permits", "Cooking Gas/Propane", "Equipment", "Kitchen Rental", "Event Fee", "Uniforms", "Food Handler Permit", "Health Inspection Fee", "Marketing/Ads", "Platform Commission", "Insurance", "Accounting", "Pest Control", "Grease Trap Service", "Refrigeration Repair", "Linen Service", "POS System", "Website/Online Ordering"],
      receive: ["Customer Payment", "Catering Deposit", "Delivery App Payout", "Event Deposit", "Supplier Refund", "Business Loan", "Grant", "Insurance Claim", "Tip Pool", "PayPal/Venmo", "Zelle"]
    },
    us_digital_business: {
      sell: ["Project Fee", "Consultation", "Retainer", "Digital Product", "Ad Revenue", "Social Media Management", "Video Editing", "Graphic Design", "Web Design", "Copywriting", "Virtual Assistant", "Course Sale", "E-Book Sale", "Template Sale", "Coaching Session", "Podcast Sponsorship", "Brand Deal", "YouTube Income", "TikTok Income", "Affiliate Income", "Print-On-Demand", "Stock Photo Sale", "UGC Content", "Newsletter Sponsorship", "Voice Over", "Translation", "Products", "Etsy Sale", "Amazon Sale", "Shopify Sale", "eBay Sale", "Instagram Sale", "TikTok Shop Sale", "Custom Order", "Bundle Sale", "Clearance Sale", "Subscription Box", "Gift Set", "Dropship Order"],
      buy: ["Software", "Equipment", "Domain/Hosting", "Camera/Gear", "Computer", "External Drive", "Props/Backdrops", "Merch Inventory", "Microphone", "Ring Light", "Tripod", "Green Screen", "Stock Photos", "Music License", "Inventory", "Packaging", "Product Photos", "Blank Apparel", "Boxes", "Mailers", "Tissue Paper", "Poly Bags", "Tape", "Stickers", "Thank You Cards", "Branded Bags", "Ribbon", "Labels"],
      pay: ["Subscriptions", "Ads", "Contractor Pay", "Internet", "Platform Fee", "Phone Plan", "Cloud Storage", "Email Marketing Tool", "Project Management Tool", "Accounting Software", "Legal Fee", "LLC Filing", "Taxes", "Health Insurance", "Co-working Space", "Training/Course", "Stock Assets", "Business Cards", "Website Maintenance", "CRM Tool", "Shipping Cost", "Storage", "Returns Processing", "Photography", "Influencer Collab", "Packaging Design", "Fulfillment Fee", "PayPal/Stripe Fee"],
      receive: ["Client Payment", "Platform Payout", "Affiliate Payout", "Deposit", "Business Loan", "Grant", "Tax Refund", "Tip", "PayPal/Venmo", "Zelle", "Wire Transfer", "Check Deposit", "Customer Payment", "Refund Received", "Chargeback Reversal"]
    },
    us_contractor: {
      sell: ["Labor", "Project Fee", "Installation", "Repair Job", "Inspection", "Roofing Job", "Plumbing Job", "Electrical Job", "HVAC Job", "Painting Job", "Drywall Job", "Flooring Job", "Landscaping", "Pressure Washing", "Fence Job", "Handyman Work", "Pool Service", "Snow Removal", "Tree Service", "Concrete Work", "Masonry", "Window Installation", "Door Installation", "Cabinet Install", "Deck Build", "Garage Door", "Gutter Install"],
      buy: ["Materials", "Equipment Rental", "Tools", "Safety Gear", "Lumber", "Concrete/Block", "Pipe/Plumbing", "Wire/Electrical", "Roofing Materials", "Flooring Materials", "Paint/Primer", "Fasteners", "Landscaping Supplies", "Chemicals", "Mulch/Soil", "Gravel/Stone", "Drywall", "Insulation", "Windows", "Doors", "Hardware", "Sealants/Caulk"],
      pay: ["Subcontractor Pay", "Permits", "Fuel", "Disposal", "Helper Pay", "Insurance", "Truck Payment", "Tool Rental", "Advertising", "Uniforms", "Accounting", "Legal Fee", "License Renewal", "Safety Training", "Equipment Servicing", "Background Checks", "PPE", "Vehicle Maintenance", "Storage Unit", "Phone Plan"],
      receive: ["Client Payment", "Deposit", "Progress Payment", "Final Balance", "Insurance Payout", "Business Loan", "Grant", "Retainer", "Check Deposit", "Wire Transfer"]
    },
    us_beauty_services: {
      sell: ["Hair Service", "Nails", "Treatment", "Makeup", "Product Sale", "Lashes", "Box Braids", "Knotless Braids", "Cornrows", "Fulani Braids", "Starter Locs", "Loc Retwist", "Wash and Style", "Silk Press", "Wig Install", "Sew-In", "Color Service", "Barber Cut", "Shape-Up", "Kids Hair", "Acrylic Set", "Gel Nails", "Manicure", "Pedicure", "Nail Art", "Lash Extensions", "Microblading", "Brow Lamination", "Waxing", "Facial", "Bridal Makeup", "Massage", "Teeth Whitening", "Spray Tan"],
      buy: ["Supplies", "Products", "Equipment", "Braiding Hair", "Bundles/Wigs", "Nail Supplies", "Lash Supplies", "Color/Developer", "Wax Supplies", "Gloves/PPE", "Spa Supplies", "Towels/Linen", "Furniture", "Retail Stock", "Shampoo/Conditioner", "Styling Products", "Nail Polish", "Gel/Acrylic Powder"],
      pay: ["Booth Rent", "Staff Pay", "Training", "Booking App Fee", "Utilities", "Supplies Run", "Insurance", "Advertising", "Business Cards", "Website/Online Booking", "License Renewal", "Equipment Repair", "Laundry", "Cleaning", "Phone Plan", "Parking", "Accounting"],
      receive: ["Client Payment", "Deposit", "Tip", "Supplier Refund", "Business Loan", "Grant", "Insurance Claim", "PayPal/Venmo", "Zelle", "Cash App"]
    }
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

let LABEL_CATALOG = [];

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
  speechResults: [],
  amountsHidden: false,
  isRecording: false,
  pinEntry: "",
  pinAttempts: 0,
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
  pinConfirmResolver: null,
  pinConfirmWrongMessage: "",
  pinRecoveryReturnScreen: "screen-capture",
  pendingAdAction: null,
  interstitialDismiss: null,
  preferredLabelEditorOpen: false,
  passcodeReminderEditorOpen: false,
  emailVerified: false,
  phoneVerified: false,
  smsSupported: false,
  authPhoneCountry: "NG",
  devicePrivateKey: null,
  devicePublicKey: "",
  deviceIdentity: "",
  publicKeyFingerprint: "",
  authToken: "",
  authTokenExpiresAt: "",
  syncApiBaseUrl: "",
  syncStatus: "Sync not configured yet.",
  syncInFlight: false,
  syncQueueCount: 0,
  lastSyncAt: "",
  lastSyncReceipt: ""
};

let dashChart = null;
let searchDebounceTimer = null;
let privacyResetFlashTimer = null;

const els = {};

document.addEventListener("DOMContentLoaded", init);

function syncGlobalDeviceIdentity() {
  if (state.deviceIdentity) {
    window.CONFIRMA_DEVICE_IDENTITY = state.deviceIdentity;
  } else {
    delete window.CONFIRMA_DEVICE_IDENTITY;
  }
}

async function init() {
  cacheElements();
  state.db = await openDb();
  await loadCustomLabelsIntoCatalog();
  try {
    const savedAuthPhoneCountry = await getSetting("auth_phone_country");
    state.authPhoneCountry = getRecognizedCountryId(savedAuthPhoneCountry) || "NG";
  } catch (error) {
    state.authPhoneCountry = "NG";
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
  initializeAuthPhoneCountry();
  syncVerificationState();
  await loadDeviceTrustState();
  await loadSyncState();
  wireEvents();
  wirePaymentTierButtons();
  window.addEventListener("online", () => {
    void flushSyncQueue();
  });
  registerPwa();
  renderOnboarding();
  renderActionRows();
  await notifyAnomaly();

  if (state.profile) {
    state.profile.plan = normalizePlan(state.profile.plan);
    try {
      state.profile.preferred_labels = normalizePreferredLabels(state.profile.preferred_labels, state.profile.business_type_id);
    } catch (error) {
      console.warn("Unable to normalize saved preferred labels. Resetting them for onboarding safety.", error);
      state.profile.preferred_labels = [];
    }
    if (!state.profile.display_name) {
      state.onboardingStep = 5;
      renderOnboarding();
      showScreen("screen-onboarding");
      return;
    }
    hydrateProfileUi();
    const pinLockEnabled = Boolean(state.profile.pinEnabled && state.profile.pinHash);
    await showInterstitial();
    await showCapture();
    if (pinLockEnabled) {
      showPinLock();
    }
    if (typeof state.pendingAdAction === "function") {
      const action = state.pendingAdAction;
      state.pendingAdAction = null;
      action();
    }
    void flushSyncQueue();
  } else {
    showScreen("screen-onboarding");
  }
  syncDevQaSnapshot("init");
}

function cacheElements() {
  [
    "interstitial-slot", "interstitial-countdown", "interstitial-skip",
    "country-grid", "restore-account-link", "sector-grid", "business-grid", "common-label-grid", "onboarding-step-copy", "finish-onboarding",
    "onboarding-next", "onboarding-name", "onboarding-phone", "onboarding-email", "onboarding-state",
    "onboarding-birth-year", "onboarding-gender", "onboarding-profile-error",
    "business-helper", "profile-summary", "anomaly-banner", "anomaly-banner-text", "anomaly-banner-cta", "primary-actions", "advanced-panel", "transfer-actions",
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
    "voice-example-v2", "voice-announce", "banner-history", "banner-dashboard", "banner-export",
    "bottom-nav-v2", "dash-today-sales-v2", "dash-monthly-sales-v2", "dash-monthly-expenses-v2",
    "dash-cash-flow-v2", "dashboard-records-v2", "settings-profile-v2", "settings-preferred-v2",
    "settings-preferred-edit-v2", "settings-preferred-editor", "settings-preferred-grid", "settings-preferred-done-v2",
    "settings-voice-corrections-v2", "anomaly-panel", "anomaly-badge", "anomaly-list", "mark-anomalies-reviewed",
    "settings-capture-v2", "settings-summary-v2", "settings-trust-v3", "settings-devices-v2", "settings-change-profile-v2",
    "settings-open-trust-v3", "export-button-v2", "export-status-v2", "export-trust-status-v3", "export-open-trust-v3",
    "rewarded-export-wrap", "rewarded-export-button", "rewarded-ad-modal", "rewarded-ad-slot", "rewarded-ad-countdown", "rewarded-ad-complete",
    "verified-report-section", "verified-report-region-note", "payment-tiers", "payment-status",
    "daily-reminder-banner", "dismiss-reminder-btn", "privacy-toggle-btn", "reminder-toggle", "pin-lock-toggle",
    "pin-setup-area", "pin-input-new", "pin-input-confirm", "pin-passcode-guidance", "pin-reminder-summary", "pin-reminder-edit", "pin-reminder-clear",
    "pin-reminder-editor", "pin-reminder-question", "pin-reminder-answer", "pin-reminder-save", "pin-reminder-cancel",
    "pin-reset-btn", "pin-save-btn", "pin-remove-btn", "pin-setup-error",
    "settings-security-status", "pin-setup-label", "pin-lock-screen", "pin-error", "first-record-guide",
    "storage-warning-v2", "loan-readiness-banner", "banner-tier-icon", "banner-headline", "banner-subtext", "banner-cta",
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
  document.getElementById("onboarding-next").addEventListener("click", () => updateOnboardingStep(5));
  document.getElementById("restore-account-link").addEventListener("click", () => {
    restoreAccountFlow();
  });
  document.getElementById("change-profile").addEventListener("click", openChangeProfileConfirm);
  document.getElementById("anomaly-banner-cta").addEventListener("click", () => {
    void openAnomalyReview();
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
  document.getElementById("open-history").addEventListener("click", async () => {
    await renderHistory();
    showScreen("screen-history");
  });
  document.getElementById("back-home").addEventListener("click", () => showScreen("screen-capture"));
  document.getElementById("settings-change-profile-v2").addEventListener("click", openChangeProfileConfirm);
  document.getElementById("settings-open-trust-v3").addEventListener("click", () => openTrustSetup("screen-settings"));
  document.getElementById("settings-preferred-edit-v2").addEventListener("click", () => togglePreferredLabelEditor());
  document.getElementById("settings-preferred-done-v2").addEventListener("click", () => togglePreferredLabelEditor(false));
  document.getElementById("mark-anomalies-reviewed").addEventListener("click", () => {
    void markAllAnomaliesReviewed();
  });
  document.getElementById("export-button-v2").addEventListener("click", generateExport);
  document.getElementById("rewarded-export-button").addEventListener("click", () => {
    void showRewardedExportAd();
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
    void persistAuthPhoneCountry(getSelectedCountryId());
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
}

function wirePaymentTierButtons() {
  document.querySelectorAll(".tier-btn").forEach((button) => {
    button.addEventListener("click", () => {
      initPaystackPayment(
        button.dataset.tier,
        Number(button.dataset.amount),
        Number(button.dataset.window)
      );
    });
  });
}

function registerPwa() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/app/sw.js");
  }
}

function renderOnboarding() {
  renderCountryGrid();
  renderSectorGrid();
  renderBusinessGrid();
  renderCommonLabelGrid();
  renderOnboardingProfileStep();
  updateOnboardingStep(state.onboardingStep || 1);
}

function renderCountryGrid() {
  els["country-grid"].innerHTML = "";
  COUNTRIES.forEach((country) => {
    els["country-grid"].appendChild(buildVisualCard(country.icon, country.name, "Country", () => {
      state.profile = {
        ...(state.profile || {}),
        plan: normalizePlan(state.profile?.plan),
        country: country.id,
        sector_id: null,
        business_type_id: null,
        last_action: "sale",
        preferred_labels: [],
        display_name: state.profile?.display_name || "",
        phone_number: state.profile?.phone_number || "",
        email: state.profile?.email || "",
        region: state.profile?.region || "",
        birth_year: state.profile?.birth_year || "",
        gender: state.profile?.gender || ""
      };
      void persistAuthPhoneCountry(country.id);
      renderSectorGrid();
      renderBusinessGrid();
      renderOnboardingProfileStep();
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
        business_type_id: null,
        preferred_labels: []
      };
      renderBusinessGrid();
      renderOnboardingProfileStep();
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
        business_type_id: item.id,
        preferred_labels: []
      };
      renderBusinessGrid();
      renderCommonLabelGrid();
      renderOnboardingProfileStep();
      updateOnboardingStep(4);
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
    button.innerHTML = `<strong>${getIconForLabel(item.display_name)} ${item.display_name}</strong><span>${friendlyActionLabel(item.context)}</span><small>Show more often while recording</small>`;
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
  els["onboarding-step-copy"].textContent = `Step ${state.onboardingStep} of 5`;
  els["onboarding-back"].hidden = state.onboardingStep === 1;
  els["finish-onboarding"].hidden = state.onboardingStep !== 5;
  updateFinishOnboardingState();
  focusFirstInteractive(activeStep);
}

function goToPreviousOnboardingStep() {
  if (state.onboardingStep <= 1) return;
  const targetStep = state.onboardingStep - 1;
  if (targetStep === 2) {
    renderSectorGrid();
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

async function finishOnboarding() {
  clearOnboardingProfileError();
  const country = getSelectedCountryId();
  const displayName = document.getElementById("onboarding-name")?.value.trim() || "";
  const rawPhoneNumber = document.getElementById("onboarding-phone")?.value.trim() || "";
  const normalizedPhoneNumber = rawPhoneNumber ? normalizePhoneNumber(rawPhoneNumber, country) : "";
  const email = normalizeEmailAddress(document.getElementById("onboarding-email")?.value.trim() || "");
  const region = document.getElementById("onboarding-state")?.value.trim() || "";
  const birthYear = document.getElementById("onboarding-birth-year")?.value.trim() || "";
  const gender = document.getElementById("onboarding-gender")?.value || "";

  if (!displayName) {
    updateFinishOnboardingState();
    return;
  }

  if (rawPhoneNumber && !normalizedPhoneNumber) {
    showOnboardingProfileError(getPhoneValidationMessage(country));
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
    display_name: displayName,
    phone_number: normalizedPhoneNumber,
    email,
    region,
    birth_year: birthYear,
    gender
  };

  await saveProfile(state.profile);
  if (normalizedPhoneNumber) {
    await persistAuthPhoneCountry(country);
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
  els["profile-summary"].textContent = `${nameDisplay}${countryName(state.profile.country)} · ${sector?.name || ""} · ${businessType?.name || ""}`;
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
  const currency = state.profile?.country === "US" ? "USD" : "NGN";
  const symbol = currency === "USD" ? "$" : "₦";
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
      if (r.transaction_type === "sale") salesData[idx] += amt;
      if (r.transaction_type === "payment" || r.transaction_type === "purchase") expenseData[idx] += amt;
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
      if (r.transaction_type === "sale") salesData[idx] += amt;
      if (r.transaction_type === "payment" || r.transaction_type === "purchase") expenseData[idx] += amt;
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
          label: "Sales",
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
  const currency = state.profile?.country === "US" ? "USD" : "NGN";
  const metrics = getDashboardMetrics(records, effectiveRecords);

  els["dash-today-sales-v2"].textContent = formatMoney(metrics.todaySales, currency);
  els["dash-monthly-sales-v2"].textContent = formatMoney(metrics.monthlySales, currency);
  els["dash-monthly-expenses-v2"].textContent = formatMoney(metrics.monthlyExpenses, currency);
  els["dash-cash-flow-v2"].textContent = formatMoney(metrics.monthlySales - metrics.monthlyExpenses, currency);

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

  const banner = document.getElementById("loan-readiness-banner");
  if (banner && state.authToken && state.deviceIdentity) {
    if (streak >= 90) {
      document.getElementById("banner-tier-icon").textContent = "🥈";
      document.getElementById("banner-headline").textContent = "You have " + streak + " days of verified history.";
      document.getElementById("banner-subtext").textContent = "Your Verified Report is ready. Share it with lenders.";
      banner.hidden = false;
    } else if (streak >= 30) {
      document.getElementById("banner-tier-icon").textContent = "🥉";
      document.getElementById("banner-headline").textContent = "You have " + streak + " days of verified history.";
      document.getElementById("banner-subtext").textContent = "Generate your Verified Report to share with lenders.";
      banner.hidden = false;
    } else {
      banner.hidden = true;
    }
  } else if (banner) {
    banner.hidden = true;
  }

  refreshBannerAd("screen-dashboard");
}

function renderDashboardRecords(records) {
  const recent = [...records].reverse().slice(0, 5);
  renderRecordListWithAds(
    "dashboard-records-v2",
    recent,
    `<div class="record-card"><strong>No confirmed records yet.</strong><div class="record-meta">Your recent confirmed transactions will appear here.</div></div>`,
    (record) => createElementFromHtml(renderRecordCard(record))
  );
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
  const currency = state.profile.country === "US" ? "USD" : "NGN";
  const latestRecord = records.length ? records[records.length - 1] : null;
  const totalSales = effectiveRecords
    .filter((record) => record.transaction_type === "sale")
    .reduce((sum, record) => sum + Number(record.amount_minor || 0), 0);
  const totalOutflow = effectiveRecords
    .filter((record) => record.transaction_type === "payment" || record.transaction_type === "purchase")
    .reduce((sum, record) => sum + Number(record.amount_minor || 0), 0);

  els["settings-profile-v2"].innerHTML = `
    ${renderSettingsRow("Country", countryName(state.profile.country))}
    ${renderSettingsRow("Sector", sector?.name || "Not selected")}
    ${renderSettingsRow("Business type", businessType?.name || "Not selected")}
    ${state.profile.display_name ? renderSettingsRow("Name", state.profile.display_name) : ""}
    ${state.profile.phone_number ? renderSettingsRow("Phone", state.profile.phone_number) : ""}
    ${state.profile.email ? renderSettingsRow("Email", state.profile.email) : ""}
    ${state.profile.region ? renderSettingsRow("Region", state.profile.region) : ""}
    ${renderSettingsRow("Last action", friendlyActionLabel(state.profile.last_action || "sale"))}
  `;

  els["settings-trust-v3"].innerHTML = `
    ${renderSettingsRow("Verification summary", getVerificationSummaryLabel())}
    ${renderSettingsRow("Verification channels", getVerificationChannelAvailabilityLabel())}
    ${renderSettingsRow("Email verification", getVerificationStatusLabel("email"))}
    ${(state.smsSupported || state.profile.phone_verified) ? renderSettingsRow("Phone verification", getVerificationStatusLabel("sms")) : ""}
    ${renderSettingsRow("Phone anchor", getPhoneAnchorStatusLabel())}
    ${state.profile.identity_verified_at ? renderSettingsRow("Verified on", new Date(state.profile.identity_verified_at).toLocaleString()) : ""}
    ${renderSettingsRow("Device key", getDeviceKeyStatusLabel())}
    ${state.publicKeyFingerprint ? renderSettingsRow("Public key fingerprint", state.publicKeyFingerprint) : ""}
    ${state.deviceIdentity ? renderSettingsRow("Device identity", state.deviceIdentity) : ""}
    ${renderSettingsRow("Sync server", state.syncApiBaseUrl || "Not configured")}
    ${renderSettingsRow("Auth session", getAuthSessionStatusLabel())}
    ${renderSettingsRow("Queued sync entries", String(state.syncQueueCount))}
    ${renderSettingsRow("Sync status", state.syncStatus || "Idle")}
    ${state.lastSyncAt ? renderSettingsRow("Last sync", new Date(state.lastSyncAt).toLocaleString()) : ""}
    ${renderSettingsRow("Recovery contact", state.profile.email || state.profile.phone_number || "Not set")}
    ${renderSettingsRow("Week B status", isSigningReady() ? "This device can sign locally and queue entries for server sync." : `Finish ${getVerificationChannelLabel().toLowerCase()} and device key setup before confirming new entries.`)}
  `;

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
  return `<div class="settings-row"><span>${label}</span><strong>${value}</strong></div>`;
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
  return entries.filter((entry) => !entry.reviewed).length;
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
  return Math.max(20, p95 * 3);
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
    const recentRecords = await getRecords();
    const oneHourAgoMs = Date.now() - 3600000;
    const fiveMinAgoMs = Date.now() - 300000;
    const thisHourCount = recentRecords.filter((record) => getRecordConfirmedAtMs(record) >= oneHourAgoMs).length;

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

    if (sameAmountRecent.length >= 5) {
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
        `prev_entry_hash ${newEntry.prev_entry_hash?.slice(0, 12)} used by multiple entries`,
        newEntry.id
      );
    }
  } catch (error) {
    console.warn("Anomaly detection skipped.", error);
  }
}

async function notifyAnomaly() {
  const count = await getUnreviewedAnomalyCount();

  if (els["anomaly-banner"] && els["anomaly-banner-text"]) {
    if (count <= 0) {
      els["anomaly-banner"].hidden = true;
    } else {
      els["anomaly-banner"].hidden = false;
      if (count === 1) {
        els["anomaly-banner-text"].textContent = "Unusual activity detected — tap to review";
      } else if (count >= 3) {
        els["anomaly-banner-text"].textContent = `${count} unreviewed anomalies — please check your recent records`;
      } else {
        els["anomaly-banner-text"].textContent = `${count} unreviewed anomalies — tap to review`;
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

async function markAllAnomaliesReviewed() {
  const store = getAnomalyStore("readwrite");
  if (!store) return;

  await new Promise((resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => {
      const entries = Array.isArray(request.result) ? request.result : [];
      entries.forEach((entry) => {
        if (!entry.reviewed) {
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

async function openAnomalyReview() {
  await renderSettings();
  showScreen("screen-settings");
  window.requestAnimationFrame(() => {
    els["anomaly-panel"]?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

function normalizePlan(plan) {
  return plan === "basic" || plan === "pro" ? plan : "free";
}

function getCurrentPlan() {
  return normalizePlan(state.profile?.plan);
}

function setRecordingState(isRecording) {
  state.isRecording = Boolean(isRecording);
  refreshBannerAd(document.querySelector(".screen.active")?.id || "");
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

function getRewardedExportCount() {
  return getMonthlyLocalNumber("rewardedExportsThisMonth");
}

function hasFreeExportQuota() {
  if (getCurrentPlan() === "pro") return true;
  return getMonthlyFreeExportCount() < (MONTHLY_FREE_EXPORT_LIMIT + getRewardedExportCount());
}

function shouldOfferRewardedExport() {
  return getCurrentPlan() !== "pro" && !state.isRecording && !hasFreeExportQuota();
}

function refreshRewardedExportState() {
  if (!els["export-button-v2"]) return;
  const exhausted = !hasFreeExportQuota();
  els["export-button-v2"].disabled = exhausted;
  els["export-button-v2"].textContent = exhausted ? "Free export limit reached" : "Generate export";
  if (els["rewarded-export-wrap"]) {
    els["rewarded-export-wrap"].hidden = !shouldOfferRewardedExport();
  }
}

function unlockRewardedExport() {
  incrementMonthlyLocalNumber("rewardedExportsThisMonth");
  refreshRewardedExportState();
}

function shouldShowInterstitial() {
  if (state.isRecording || getCurrentPlan() === "pro") return false;
  const lastSeen = parseInt(localStorage.getItem("lastInterstitialAt") || "0", 10);
  const hoursSince = (Date.now() - lastSeen) / 3600000;
  if (getCurrentPlan() === "basic") return hoursSince > 12;
  return hoursSince > 4;
}

function getHouseAdContent(type) {
  const ads = HOUSE_ADS[type] || [];
  if (!ads.length) return null;
  return ads[Math.floor(Math.random() * ads.length)];
}

function runHouseAdAction(ad, type, slotId) {
  if (typeof ad?.action !== "function") return;
  if (type === "interstitial" && slotId === "interstitial-slot") {
    state.pendingAdAction = ad.action;
    if (typeof state.interstitialDismiss === "function") {
      state.interstitialDismiss();
    }
    return;
  }
  ad.action();
}

function buildHouseAdElement(ad, type, slotId = "") {
  const wrapper = document.createElement("div");
  wrapper.className = type === "infeed" ? "record-card ad-record house-ad" : "house-ad";

  const brand = document.createElement("div");
  brand.className = "house-ad-brand";
  brand.textContent = ad.brand || "Confirma";

  const headline = document.createElement("div");
  headline.className = "house-ad-headline";
  headline.textContent = ad.headline || "";

  wrapper.append(brand, headline);

  if (ad.body) {
    const body = document.createElement("div");
    body.className = "house-ad-body";
    body.textContent = ad.body;
    wrapper.appendChild(body);
  }

  if (ad.cta) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn btn-secondary house-ad-cta";
    button.textContent = ad.cta;
    if (typeof ad.action === "function") {
      button.addEventListener("click", () => {
        runHouseAdAction(ad, type, slotId);
      });
    }
    wrapper.appendChild(button);
  }

  return wrapper;
}

function renderHouseAd(slotId, type) {
  const slot = els[slotId] || document.getElementById(slotId);
  if (!slot) return null;
  slot.innerHTML = "";
  const ad = getHouseAdContent(type);
  if (!ad) {
    slot.hidden = true;
    return null;
  }
  const adElement = buildHouseAdElement(ad, type, slotId);
  slot.appendChild(adElement);
  slot.hidden = false;
  return adElement;
}

function renderInFeedAd() {
  const ad = getHouseAdContent("infeed");
  return ad ? buildHouseAdElement(ad, "infeed") : null;
}

function createElementFromHtml(html) {
  const template = document.createElement("template");
  template.innerHTML = String(html || "").trim();
  return template.content.firstElementChild;
}

function getInFeedAdFrequency() {
  if (state.isRecording || getCurrentPlan() === "pro") return 0;
  return getCurrentPlan() === "basic" ? 10 : 5;
}

function renderRecordListWithAds(containerId, records, emptyHtml, renderer) {
  const container = els[containerId] || document.getElementById(containerId);
  if (!container) return;

  container.innerHTML = "";
  if (!records.length) {
    container.innerHTML = emptyHtml;
    return;
  }

  const adFrequency = getInFeedAdFrequency();
  const fragment = document.createDocumentFragment();

  records.forEach((record, index) => {
    const node = renderer(record, index);
    if (node) fragment.appendChild(node);

    if (adFrequency && (index + 1) % adFrequency === 0 && index < records.length - 1) {
      const adNode = renderInFeedAd();
      if (adNode) fragment.appendChild(adNode);
    }
  });

  container.appendChild(fragment);
}

function refreshBannerAd(screenId) {
  ["banner-history", "banner-dashboard", "banner-export"].forEach((slotId) => {
    const slot = els[slotId];
    if (!slot) return;
    slot.innerHTML = "";
    slot.hidden = true;
  });

  if (state.isRecording || getCurrentPlan() === "pro") return;

  const slotId = {
    "screen-history": "banner-history",
    "screen-dashboard": "banner-dashboard",
    "screen-export": "banner-export"
  }[screenId];

  if (!slotId) return;
  if (screenId === "screen-dashboard" && getCurrentPlan() === "basic") return;
  renderHouseAd(slotId, "banner");
}

function showInterstitial() {
  return new Promise((resolve) => {
    if (!shouldShowInterstitial()) {
      resolve();
      return;
    }

    localStorage.setItem("lastInterstitialAt", Date.now().toString());
    showScreen("screen-interstitial");
    renderHouseAd("interstitial-slot", "interstitial");

    let seconds = 5;
    const countdown = document.getElementById("interstitial-countdown");
    const skipBtn = document.getElementById("interstitial-skip");
    if (!(countdown && skipBtn)) {
      resolve();
      return;
    }

    countdown.textContent = `Skip in ${seconds}s`;
    skipBtn.disabled = true;
    skipBtn.textContent = "Skip →";

    let tick = null;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearInterval(tick);
      state.interstitialDismiss = null;
      resolve();
    };

    state.interstitialDismiss = finish;

    tick = setInterval(() => {
      seconds -= 1;
      if (seconds <= 0) {
        clearInterval(tick);
        countdown.textContent = "";
        skipBtn.disabled = false;
        skipBtn.textContent = "Skip →";
      } else {
        countdown.textContent = `Skip in ${seconds}s`;
      }
    }, 1000);

    skipBtn.onclick = finish;
  });
}

function showRewardedExportAd() {
  return new Promise((resolve) => {
    if (!shouldOfferRewardedExport()) {
      resolve(false);
      return;
    }

    const modal = els["rewarded-ad-modal"];
    const countdown = els["rewarded-ad-countdown"];
    const unlockButton = els["rewarded-ad-complete"];
    if (!(modal && countdown && unlockButton)) {
      resolve(false);
      return;
    }

    modal.hidden = false;
    renderHouseAd("rewarded-ad-slot", "interstitial");

    let seconds = 15;
    countdown.textContent = `Unlock in ${seconds}s`;
    unlockButton.disabled = true;
    unlockButton.textContent = "Unlock export";

    let tick = null;
    const finish = (didUnlock) => {
      clearInterval(tick);
      modal.hidden = true;
      if (didUnlock) {
        unlockRewardedExport();
        if (els["export-status-v2"]) {
          els["export-status-v2"].textContent = "1 extra export unlocked.";
        }
      }
      resolve(didUnlock);
    };

    tick = setInterval(() => {
      seconds -= 1;
      if (seconds <= 0) {
        clearInterval(tick);
        countdown.textContent = "";
        unlockButton.disabled = false;
      } else {
        countdown.textContent = `Unlock in ${seconds}s`;
      }
    }, 1000);

    unlockButton.onclick = () => finish(true);
  });
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
    ? preferred.map((label) => `<div class="settings-chip">${getIconForLabel(label)} ${label}</div>`).join("")
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
    els["settings-voice-corrections-v2"].innerHTML = `<div class="record-meta">No saved corrections yet. Confirma will learn from manual voice fixes on this device.</div>`;
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

function legacyHashPin(pin) {
  let hash = 0;
  for (let index = 0; index < pin.length; index += 1) {
    hash = ((hash << 5) - hash) + pin.charCodeAt(index);
    hash |= 0;
  }
  return String(hash);
}

async function hashPin(pin, salt) {
  return sha256(`${pin}${salt}`);
}

function createPinSalt() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex) {
  const value = String(hex || "");
  const bytes = new Uint8Array(Math.floor(value.length / 2));
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, (index * 2) + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes) {
  return Array.from(bytes || []).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashPasscodeWithPbkdf2(passcode, salt, iterations = PASSCODE_PBKDF2_ITERATIONS) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(String(passcode || "")),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: hexToBytes(salt),
      iterations
    },
    keyMaterial,
    256
  );
  return bytesToHex(new Uint8Array(derivedBits));
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

function normalizeLocalProfile(profile, { trackReminderMigration = false } = {}) {
  if (!profile) return null;
  const { reminder, migrated } = normalizePasscodeReminder(profile.passcodeReminder, profile.passcode_hint);
  const normalizedProfile = {
    ...profile,
    plan: normalizePlan(profile.plan),
    preferred_labels: normalizePreferredLabels(profile.preferred_labels, profile.business_type_id)
  };
  if (reminder) {
    normalizedProfile.passcodeReminder = clonePasscodeReminder(reminder);
  } else {
    delete normalizedProfile.passcodeReminder;
  }
  delete normalizedProfile.passcode_hint;
  delete normalizedProfile._needsReminderMigration;
  if (trackReminderMigration && migrated) {
    normalizedProfile._needsReminderMigration = true;
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

async function upgradeLegacyPinHash(pin) {
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
      await upgradeLegacyPinHash(passcode);
    }
    state.pinAttempts = 0;
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

function renderExportScreen() {
  refreshTrustSetupButtons();
  const verifiedReportsAvailable = supportsVerifiedReports(state.profile?.country);
  els["export-status-v2"].textContent = "";
  if (els["payment-status"]) {
    els["payment-status"].textContent = "";
  }
  if (els["verified-report-section"]) {
    els["verified-report-section"].hidden = !(state.authToken && state.deviceIdentity);
  }
  if (els["payment-tiers"]) {
    els["payment-tiers"].hidden = !verifiedReportsAvailable;
  }
  if (els["verified-report-region-note"]) {
    els["verified-report-region-note"].hidden = verifiedReportsAvailable;
  }
  if (els["export-trust-status-v3"]) {
    els["export-trust-status-v3"].innerHTML = `
      ${renderSettingsRow("Verification summary", getVerificationSummaryLabel())}
      ${renderSettingsRow("Verification channels", getVerificationChannelAvailabilityLabel())}
      ${renderSettingsRow("Email verification", getVerificationStatusLabel("email"))}
      ${(state.smsSupported || state.profile?.phone_verified) ? renderSettingsRow("Phone verification", getVerificationStatusLabel("sms")) : ""}
      ${renderSettingsRow("Phone anchor", getPhoneAnchorStatusLabel())}
      ${renderSettingsRow("Device key", getDeviceKeyStatusLabel())}
      ${state.publicKeyFingerprint ? renderSettingsRow("Public key fingerprint", state.publicKeyFingerprint) : ""}
      ${renderSettingsRow("Sync status", state.syncStatus || "Idle")}
      ${renderSettingsRow("Queued sync entries", String(state.syncQueueCount))}
      ${renderSettingsRow("Recovery contact", state.profile?.email || state.profile?.phone_number || "Not set")}
    `;
  }
  refreshRewardedExportState();
  refreshBannerAd("screen-export");
  refreshStorageWarning();
}

async function generateExport() {
  if (!hasFreeExportQuota()) {
    refreshRewardedExportState();
    els["export-status-v2"].textContent = "Free export limit reached this month. Watch a short ad to unlock one more export.";
    return;
  }

  const records = await getRecords();
  if (!records.length) {
    els["export-status-v2"].textContent = "No confirmed records yet.";
    return;
  }

  const currency = state.profile?.country === "US" ? "USD" : "NGN";
  const ledgerRootHash = records[records.length - 1].entry_hash;
  const lines = records.map((record) => {
    const timestamp = new Date(record.confirmed_at * 1000).toLocaleString();
    return [
      record.server_entry_id || record.id,
      record.transaction_type,
      record.label,
      formatMoney(record.amount_minor, currency),
      timestamp,
      record.signature ? "signed: true" : "unsigned: true"
    ].join(" | ");
  });
  const signedCount = records.filter((record) => Boolean(record.signature)).length;
  const unsignedCount = records.length - signedCount;
  let attestation = null;
  let qrDataUrl = null;

  if (state.authToken && state.deviceIdentity) {
    try {
      const response = await postJson(state.syncApiBaseUrl, "/attest", {
        device_identity: state.deviceIdentity,
        window_days: 90
      }, state.authToken);

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

  const verificationStatus = signedCount
    ? (attestation?.verify_url
      ? `Device-signed and server-attested. Verify at ${attestation.verify_url}`
      : "Device-signed on this device. Server attestation coming.")
    : `Legacy unsigned history only. Complete ${getVerificationChannelLabel().toLowerCase()} to start device signing.`;

  const output = [
    "CONFIRMA V3 EXPORT",
    `Generated: ${new Date().toLocaleString()}`,
    `Profile: ${countryName(state.profile.country)} / ${BUSINESS_TYPES.find((item) => item.id === state.profile.business_type_id)?.name || "Unknown"}`,
    state.profile.display_name ? `Name: ${state.profile.display_name}` : null,
    state.profile.region ? `Region: ${state.profile.region}` : null,
    `Verification Anchor: ${getPhoneAnchorStatusLabel()}`,
    `Device Key: ${getDeviceKeyStatusLabel()}`,
    state.publicKeyFingerprint ? `Public Key Fingerprint: ${state.publicKeyFingerprint}` : null,
    `Sync Server: ${state.syncApiBaseUrl || "Not configured"}`,
    `Sync Status: ${state.syncStatus || "Idle"}`,
    `Queued Sync Entries: ${state.syncQueueCount}`,
    `Recovery Contact: ${state.profile.email || state.profile.phone_number || "Not set"}`,
    `Entries: ${records.length}`,
    `Signed entries: ${signedCount}`,
    `Unsigned legacy entries: ${unsignedCount}`,
    "---",
    ...lines,
    "---",
    `Ledger Root Hash: ${ledgerRootHash}`,
    `Verification Status: ${verificationStatus}`,
    attestation?.vt_id ? `vt_id: ${attestation.vt_id}` : null,
    attestation?.verify_url ? `verify_url: ${attestation.verify_url}` : null,
    qrDataUrl ? `qr_code_data_url: ${qrDataUrl}` : null
  ].filter(Boolean).join("\n");

  const blob = new Blob([output], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `confirma-export-${Date.now()}.txt`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  if (getCurrentPlan() !== "pro") {
    incrementMonthlyLocalNumber("freeExportsThisMonth");
  }
  refreshRewardedExportState();
  els["export-status-v2"].textContent = "Export downloaded.";
}

function setPaymentStatus(message) {
  if (els["payment-status"]) {
    els["payment-status"].textContent = message || "";
  }
}

function downloadBase64File(base64, filename, mimeType) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  const blob = new Blob([bytes], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function initPaystackPayment(tier, amountKobo, windowDays) {
  if (!state.authToken || !state.deviceIdentity) {
    setPaymentStatus(`Complete ${getVerificationChannelLabel().toLowerCase()} on this device before purchasing a verified report.`);
    return;
  }

  if (!supportsVerifiedReports(state.profile?.country)) {
    setPaymentStatus("Verified Reports are coming soon for your region.");
    return;
  }

  if (!window.PaystackPop) {
    setPaymentStatus("Payment service is unavailable right now. Please try again.");
    return;
  }

  const reference = "cfm_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
  const popup = new window.PaystackPop();

  popup.newTransaction({
    key: PAYSTACK_PUBLIC_KEY,
    email: state.profile.email || (state.profile.phone_number + "@confirma.app"),
    amount: amountKobo,
    currency: "NGN",
    ref: reference,
    metadata: {
      custom_fields: [
        { display_name: "Phone", variable_name: "phone", value: state.profile.phone_number },
        { display_name: "Tier", variable_name: "tier", value: tier },
        { display_name: "Window Days", variable_name: "window_days", value: String(windowDays) },
        { display_name: "Device Identity", variable_name: "device_identity", value: state.deviceIdentity }
      ]
    },
    onSuccess: (transaction) => {
      void handlePaymentSuccess(transaction, windowDays);
    },
    onCancel: () => {
      setPaymentStatus("Payment cancelled.");
    }
  });
}

async function handlePaymentSuccess(transaction, windowDays) {
  const reference = String(transaction?.reference || "").trim();
  if (!reference) {
    setPaymentStatus("Report generation failed. Contact support with reference: unknown");
    return;
  }

  setPaymentStatus("Generating your verified report...");

  try {
    const response = await postJson(state.syncApiBaseUrl, "/payment/generate-pdf", {
      reference,
      window_days: windowDays
    }, state.authToken);

    if (!(response?.ok && response?.pdf_base64 && response?.filename)) {
      throw new Error("Invalid PDF response.");
    }

    downloadBase64File(response.pdf_base64, response.filename, "application/pdf");
    setPaymentStatus("Verified report downloaded.");
  } catch (error) {
    console.error("Verified report generation failed.", error);
    setPaymentStatus("Report generation failed. Contact support with reference: " + reference);
  }
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
  button.innerHTML = `<strong>${item.icon || "🏷️"} ${item.display_name}</strong><span>${contextCopy(item)}</span>`;
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
    return "Microphone access was denied. Please allow microphone access in your browser settings.";
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

function formatVoiceCorrectionAmount(value) {
  const normalized = String(value || "").trim().replace(/,/g, "");
  if (!normalized) return "";
  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount <= 0) return "";
  if (state.profile?.country === "US") {
    return amount.toLocaleString("en-US", {
      minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
      maximumFractionDigits: 2
    });
  }
  return Math.round(amount).toLocaleString("en-NG", { maximumFractionDigits: 0 });
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
    receipt: "received"
  }[parsed.action] || "captured";
  const currency = state.profile?.country === "US" ? "USD" : "NGN";
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
  if (!parsed) {
    setVoiceRecordError(`Could not understand that. Try: ${getCurrentCaptureExample()}.`);
    return;
  }
  applyParsedTransactionToCapture(parsed);
  els["quick-text-input-v2"].value = "";
}

function parseNaturalTransaction(input) {
  const text = String(input || "").trim().replace(/[₦$,]/g, "");
  let match = text.match(/^(?:sold|sell)\s+(.+?)\s+for\s+([0-9,.]+)/i);
  if (match) {
    return { action: "sale", labelQuery: match[1].trim(), amountMinor: parseMinor(match[2]), counterparty: "" };
  }

  match = text.match(/^(?:bought|buy)\s+(.+?)\s+for\s+([0-9,.]+)/i);
  if (match) {
    return { action: "purchase", labelQuery: match[1].trim(), amountMinor: parseMinor(match[2]), counterparty: "" };
  }

  match = text.match(/^paid\s+([0-9,.]+)\s+for\s+(.+)/i);
  if (match) {
    return { action: "payment", labelQuery: match[2].trim(), amountMinor: parseMinor(match[1]), counterparty: "" };
  }

  match = text.match(/^(?:paid|pay)\s+(.+?)\s+(?:for\s+)?([0-9,.]+)/i);
  if (match) {
    return { action: "payment", labelQuery: match[1].trim(), amountMinor: parseMinor(match[2]), counterparty: "" };
  }

  match = text.match(/^(?:received|receive)\s+([0-9,.]+)\s+from\s+(.+)/i);
  if (match) {
    return { action: "receipt", labelQuery: "Customer Payment", amountMinor: parseMinor(match[1]), counterparty: match[2].trim() };
  }

  match = text.match(/^(?:received|receive)\s+(.+?)\s+for\s+([0-9,.]+)/i);
  if (match) {
    return { action: "receipt", labelQuery: match[1].trim(), amountMinor: parseMinor(match[2]), counterparty: "" };
  }

  match = text.match(/^(?:received|receive)\s+(.+?)\s+([0-9,.]+)$/i);
  if (match) {
    return { action: "receipt", labelQuery: match[1].trim(), amountMinor: parseMinor(match[2]), counterparty: "" };
  }

  match = text.match(/^(customer|client)\s+paid\s+([0-9,.]+)$/i);
  if (match) {
    return { action: "receipt", labelQuery: "Customer Payment", amountMinor: parseMinor(match[2]), counterparty: match[1].trim() };
  }

  return null;
}

function startVoiceRecordShortcut() {
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
  recognition.lang = state.profile.country === "US" ? "en-US" : "en-NG";
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  recognition.onresult = async (event) => {
    const transcript = event.results[0][0].transcript;
    const corrected = await applyVoiceCorrections(transcript);
    rememberVoiceTranscript(transcript, "capture");
    const parsed = parseNaturalTransaction(corrected);
    if (!parsed || !parsed.amountMinor) {
      setVoiceRecordError(`Could not understand that. Try: ${getCurrentCaptureExample()}.`);
    } else {
      applyParsedTransactionToCapture(parsed, { announce: true });
    }
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
  };

  recognition.start();
}

function getCatalogForProfileAction(actionContext) {
  const exactBusinessMatches = LABEL_CATALOG.filter((item) => {
    return item.transaction_contexts.includes(actionContext)
      && item.business_types.includes(state.profile.business_type_id);
  });

  if (exactBusinessMatches.length) return exactBusinessMatches;

  const sectorBusinessIds = BUSINESS_TYPES
    .filter((item) => item.country === state.profile.country && item.sector_id === state.profile.sector_id)
    .map((item) => item.id);

  const sectorMatches = LABEL_CATALOG.filter((item) => {
    return item.transaction_contexts.includes(actionContext)
      && item.countries.includes(state.profile.country)
      && item.business_types.some((businessId) => sectorBusinessIds.includes(businessId));
  });

  if (sectorMatches.length) return sectorMatches;

  return LABEL_CATALOG.filter((item) => {
    return item.transaction_contexts.includes(actionContext)
      && item.countries.includes(state.profile.country);
  });
}

function findBestLabelForAction(labelQuery, actionContext) {
  const catalog = getCatalogForProfileAction(actionContext);
  const normalizedQuery = normalizeText(labelQuery);
  const ranked = catalog
    .map((item) => {
      const exact = normalizeText(item.display_name) === normalizedQuery ? 1 : 0;
      const partial = normalizeText(item.display_name).includes(normalizedQuery) ? 1 : 0;
      const synonym = item.synonyms.some((synonym) => normalizeText(synonym).includes(normalizedQuery)) ? 1 : 0;
      const preferred = (state.profile?.preferred_labels || []).includes(item.display_name) ? 1 : 0;
      const score = (exact * 50) + (partial * 18) + (synonym * 20) + (preferred * 8);
      return { item, score };
    })
    .sort((a, b) => b.score - a.score || a.item.display_name.localeCompare(b.item.display_name));

  return ranked[0]?.score ? ranked[0].item : catalog[0] || null;
}

function applyParsedTransactionToCapture(parsed, options = {}) {
  setVoiceRecordError("");
  state.currentAction = parsed.action;
  state.profile.last_action = parsed.action;
  renderActionRows();

  const label = findBestLabelForAction(parsed.labelQuery, parsed.action);
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
    ? searchLayerBLabels(query, state.profile.country, state.profile.business_type_id, getCurrentActionContext())
    : await rankLabels("", { limit: 12 });
  state.searchResults = results;
  els["search-results"].innerHTML = results.length
    ? results.map(renderRankedItemHtml).join("")
    : `<div class="record-card"><strong>No labels found</strong><div class="record-meta">Try speech, browse all, or add Other.</div></div>`;
  wireRankedButtons("search-results", results);
}

async function renderBrowseResults() {
  const results = getBrowseAllLabels(state.profile.country, state.profile.business_type_id, getCurrentActionContext());
  state.browseResults = results;
  els["browse-results"].innerHTML = results.map(renderRankedItemHtml).join("");
  wireRankedButtons("browse-results", results);
}

function renderRankedItemHtml(item, index) {
  return `<button type="button" class="ranked-item" data-ranked-id="${item.id}"><strong>${item.icon || "🏷️"} ${item.display_name}</strong><span>${contextCopy(item)}</span><small>${item.badge || item.reason || "Recommended label"}</small></button>`;
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
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRec) {
    setRecordingState(false);
    els["speech-status"].textContent = "Speech recognition is not available in this browser.";
    return;
  }

  els["speech-status"].textContent = "Listening...";
  stopActiveRecognition();
  const recognition = new SpeechRec();
  state.activeRecognition = recognition;
  setRecordingState(true);
  recognition.lang = state.profile.country === "US" ? "en-US" : "en-NG";
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  recognition.onresult = async (event) => {
    const transcript = event.results[0][0].transcript;
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
  const signingBlockReason = getSigningBlockReason();
  if (signingBlockReason) {
    return showError(signingBlockReason);
  }
  const amount = parseMinor(els["amount-input-v2"].value);
  if (!state.selectedLabel) {
    return showError("Pick a label first.");
  }
  const currency = state.profile.country === "US" ? "USD" : "NGN";
  const maxAmount = currency === "USD" ? 100000 * 100 : 10000000 * 100;
  if (!amount || amount <= 0) {
    return showError("Enter a valid amount before confirming.");
  }
  if (amount > maxAmount) {
    return showError(currency === "USD"
      ? "Amount looks too large. Confirma accepts up to $100,000 per entry."
      : "Amount looks too large. Confirma accepts up to ₦10,000,000 per entry.");
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
    country: state.profile.country
  };

  state.candidateRecord = record;
  els["confirm-copy-v2"].textContent = confirmationCopy(record);
  els["confirm-meta-v2"].innerHTML = `
    <div><strong>Type:</strong> ${record.transaction_type}</div>
    <div><strong>Normalized label:</strong> ${record.normalized_label}</div>
    <div><strong>Amount:</strong> ${formatMoney(record.amount_minor, record.currency)}</div>
    <div><strong>Counterparty:</strong> ${record.counterparty || "Not provided"}</div>
    ${record.reversed_entry_hash ? `<div><strong>Reverses:</strong> ${record.reversed_entry_hash}</div>` : ""}
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
  renderRecordListWithAds(
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
  refreshBannerAd("screen-history");
}

function renderHistoryList(records) {
  const reversedHashes = getReversedEntryHashSet(records);
  renderRecordListWithAds(
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
      const exact = normalizedQuery && normalizeText(item.display_name) === normalizedQuery ? 1 : 0;
      const synonym = normalizedQuery && item.synonyms.some((synonym) => normalizeText(synonym) === normalizedQuery) ? 1 : 0;
      const partial = normalizedQuery && (normalizeText(item.display_name).includes(normalizedQuery) || item.synonyms.some((synonym) => normalizeText(synonym).includes(normalizedQuery))) ? 1 : 0;
      const businessMatch = item.business_types.includes(state.profile.business_type_id) ? 1 : 0;
      const sectorMatch = businessSectorMatch(item) ? 1 : 0;
      const countryMatch = item.countries.includes(state.profile.country) ? 1 : 0;
      const historyBoost = usageMap.get(item.normalized_label) || 0;
      const preferredBoost = (state.profile?.preferred_labels || []).includes(item.display_name) ? 18 : 0;
      const score = (exact * 40) + (synonym * 30) + (partial * 16) + (businessMatch * 12) + (sectorMatch * 8) + (countryMatch * 6) + Math.min(historyBoost, 8) + preferredBoost;
      const confidence = normalizedQuery
        ? Math.min(score / 50, 0.99)
        : Math.min((businessMatch * 0.55) + (sectorMatch * 0.2) + (countryMatch * 0.1) + Math.min(historyBoost, 3) / 10 + (preferredBoost ? 0.15 : 0), 0.92);
      const reason = exact ? "Exact match" : synonym ? "Synonym match" : partial ? "Related match" : preferredBoost ? "Picked during onboarding" : "Recommended for this business";
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

function findPreferredCatalogItem(displayName) {
  if (!(state.profile && state.profile.business_type_id)) return null;
  const actionContext = getCurrentActionContext();
  const candidates = LABEL_CATALOG
    .filter((item) => item.display_name === displayName && item.countries.includes(state.profile.country))
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
  "Marketing/Ads": "📢",
  "Platform Fees": "💻",
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
  "Subscription": "🔄",
  "Social Media Management": "📱",
  "Video Editing": "🎬",
  "Graphic Design": "🎨",
  "Web Design": "🌐",
  "Coaching Session": "🎯",
  "Brand Deal": "⭐",
  "Affiliate Income": "🔗",
  "Course Sale": "🎓",
  "UGC Content": "📸",
  "Subscriptions": "🔄",
  "Ads": "📢",
  "Contractor Pay": "🤝",
  "Internet": "🌐",
  "Platform Fee": "💻",
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
  "Platform Payout": "💻",
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
  if (lower.includes("ads") || lower.includes("marketing") || lower.includes("boost")) return "📢";
  if (lower.includes("software") || lower.includes("subscription")) return "💻";
  if (lower.includes("stock") || lower.includes("inventory")) return "🗃️";
  if (lower.includes("packaging") || lower.includes("nylon") || lower.includes("bag")) return "📦";
  if (lower.includes("project") || lower.includes("consult")) return "📋";
  return "🏷️";
}

function inferIcon(displayName, action) {
  return getIconForLabel(displayName);
}

LABEL_CATALOG = [...buildCatalogFromQuickPicks(), ...EXTRA_SEARCH_LABELS];

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
  if (id !== "screen-confirm") {
    cancelConfirmationSpeech();
  }
  if (previousScreen === "screen-dashboard" && id !== "screen-dashboard" && state.amountsHidden) {
    resetPrivacyMode();
  }
  updateBottomNav(id);
  refreshBannerAd(id);
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

  if (await pinMatchesProfile(pin)) {
    if (!state.profile.pinSalt) {
      await upgradeLegacyPinHash(pin);
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
    request.onblocked = () => reject(new Error("Close other open Confirma tabs before wiping this device."));
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
  return COUNTRIES.find((item) => item.id === normalizeCountryId(countryId))?.name || countryId;
}

function normalizeCountryId(country) {
  if (country === "Nigeria" || country === "NG") return "NG";
  if (country === "United States" || country === "US" || country === "USA" || country === "United States of America") return "US";
  return country || "NG";
}

function getRecognizedCountryId(country) {
  if (country === "Nigeria" || country === "NG") return "NG";
  if (country === "United States" || country === "US" || country === "USA" || country === "United States of America") return "US";
  return "";
}

function getSelectedCountryId() {
  return normalizeCountryId(state.profile?.country);
}

function getPhoneInputCountry() {
  return getRecognizedCountryId(state.authPhoneCountry)
    || getRecognizedCountryId(state.profile?.country)
    || "NG";
}

function initializeAuthPhoneCountry() {
  state.authPhoneCountry = getRecognizedCountryId(state.authPhoneCountry)
    || getRecognizedCountryId(state.profile?.country)
    || "NG";
}

async function persistAuthPhoneCountry(country) {
  const nextCountry = getRecognizedCountryId(country) || getPhoneInputCountry();
  state.authPhoneCountry = nextCountry;
  try {
    await saveSetting("auth_phone_country", nextCountry);
  } catch (error) {
    console.warn("Unable to persist selected phone country.", error);
  }
  syncDevQaSnapshot("auth_phone_country_updated");
}

function getCountryDialCode(country) {
  const countryId = getRecognizedCountryId(country);
  if (countryId === "US") return "+1";
  if (countryId === "NG") return "+234";
  return "";
}

function getCaptureExamples(country) {
  const countryId = getRecognizedCountryId(country);
  return countryId === "US" ? CAPTURE_EXAMPLES.US : CAPTURE_EXAMPLES.NG;
}

function getCurrentCaptureExample(country = state.profile?.country) {
  const examples = getCaptureExamples(country);
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
    const examples = getCaptureExamples(state.profile?.country);
    state.captureExampleIndex = (state.captureExampleIndex + 1) % examples.length;
    renderCaptureExample();
  }, 3000);
}

function getOnboardingPhonePlaceholder(country) {
  const countryId = getRecognizedCountryId(country);
  if (countryId === "US") return "e.g. 2125551234";
  if (countryId === "NG") return "e.g. 08031234567";
  return "Phone number";
}

function getOtpPhonePlaceholder(country) {
  const countryId = getRecognizedCountryId(country);
  if (countryId === "US") return "2125551234";
  if (countryId === "NG") return "08031234567";
  return "Phone number";
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
  return Boolean(state.authToken && isChannelVerified(channel));
}

function hasVerifiedIdentityAnchor() {
  return Boolean(
    (state.profile?.identity_status === "verified_local" || state.profile?.identity_status === "verified_server")
    && (state.profile?.email_verified || state.profile?.phone_verified)
  );
}

function syncDevQaSnapshot(reason = "") {
  if (!isLocalQaMode()) return;
  window.CONFIRMA_DEV_QA = {
    reason,
    at: new Date().toISOString(),
    screen: document.querySelector(".screen.active")?.id || "",
    otp_channel: getPreferredOtpChannel(),
    verification_summary: getVerificationSummaryLabel(),
    email_verified: Boolean(state.profile?.email_verified),
    phone_verified: Boolean(state.profile?.phone_verified),
    phone_anchor: hasPhoneAnchor() ? "present" : "missing",
    auth_phone_country: state.authPhoneCountry || "",
    auth_session: Boolean(state.authToken),
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
  if (countryId === "US") return "Enter a valid US phone number";
  if (countryId === "NG") return "Enter a valid Nigerian phone number";
  return "Enter a valid phone number";
}

function normalizePhoneNumber(value, country) {
  const countryId = getRecognizedCountryId(country);
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";

  if (countryId === "US") {
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
    return "";
  }

  if (digits.length === 13 && digits.startsWith("234")) return `+${digits}`;
  if (digits.length === 11 && digits.startsWith("0")) return `+234${digits.slice(1)}`;
  if (digits.length === 10) return `+234${digits}`;
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

  if (digits.length === 13 && digits.startsWith("234")) return `0${digits.slice(3)}`;
  if (digits.length === 11 && digits.startsWith("0")) return digits;
  if (digits.length === 10) return `0${digits}`;
  return String(value || "");
}

function syncCountryAwareInputs() {
  const profileCountry = state.profile?.country;
  const phoneCountry = getPhoneInputCountry();
  const otpChannel = getPreferredOtpChannel();
  if (els["onboarding-phone"]) {
    els["onboarding-phone"].placeholder = getOnboardingPhonePlaceholder(profileCountry);
  }
  if (els["onboarding-state"]) {
    els["onboarding-state"].placeholder = getRegionPlaceholder(profileCountry);
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

function supportsVerifiedReports(country) {
  return normalizeCountryId(country) === "NG";
}

function parseMinor(value) {
  const number = parseFloat(String(value || "").replace(/,/g, ""));
  return Number.isFinite(number) ? Math.round(number * 100) : 0;
}

function updateAmountInputStep() {
  if (!els["amount-input-v2"]) return;
  const isUS = state.profile?.country === "US";
  els["amount-input-v2"].step = isUS ? "0.01" : "1";
  if (els["amount-helper-v2"]) {
    els["amount-helper-v2"].textContent = isUS
      ? "Enter amount in USD. Decimals are allowed."
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
      ? "Confirma will send a code to your phone number when SMS delivery is available."
      : (missingPhoneAnchor
        ? `${getPhoneAnchorRequirementMessage(channel)} Existing phone-anchored accounts with a saved email can still restore by email on a new device.`
        : (isLocalDevelopmentOtpFallbackAllowed()
          ? "Confirma sends a code to your email address. If delivery is unavailable in local development, this device can still use a local development code."
          : "Confirma sends a code to your email address to verify this device."));
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
    ${state.publicKeyFingerprint ? renderSettingsRow("Public key fingerprint", state.publicKeyFingerprint) : ""}
    ${renderSettingsRow("Sync server", state.syncApiBaseUrl || "Not configured")}
    ${renderSettingsRow("Auth session", getAuthSessionStatusLabel())}
    ${renderSettingsRow("Recovery contact", channel === "sms" ? (state.profile?.phone_number || "Not set") : (state.profile?.email || "Not set"))}
    ${state.profile?.phone_number ? renderSettingsRow("Phone on profile", state.profile.phone_number) : ""}
    ${renderSettingsRow("Email for delivery", state.profile?.email || "Not set")}
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
    state.authToken = response.auth_token || "";
    state.authTokenExpiresAt = response.expires_at || "";
    state.smsSupported = Boolean(response?.sms_available ?? state.smsSupported);
    if (response.device_identity) {
      state.deviceIdentity = response.device_identity;
      await saveSetting("device_identity", state.deviceIdentity);
      syncGlobalDeviceIdentity();
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
    await Promise.all([
      saveProfile(state.profile, { skipPush: !persistProfileRemotely }),
      saveSetting("auth_token", state.authToken),
      saveSetting("auth_token_expires_at", state.authTokenExpiresAt)
    ]);
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
    state.profile.identity_anchor = challengeChannel;
    state.profile.identity_status = "verified_local";
    state.profile.identity_verified_at = Date.now();
    await saveProfile(state.profile, { skipPush: !persistProfileRemotely });
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
  if (state.profile?.identity_status === "verified_server" && isChannelVerified(channel)) {
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

async function fetchAuthenticatedJson(path, options = {}) {
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
      ...(state.authToken ? { Authorization: `Bearer ${state.authToken}` } : {})
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
  state.authToken = "";
  state.authTokenExpiresAt = "";
  state.otpChallenge = null;
  state.syncStatus = "Signed out. Re-open verification to sync again.";
  await Promise.all([
    saveSetting("auth_token", ""),
    saveSetting("auth_token_expires_at", "")
  ]);
  refreshTrustSetupButtons();
  renderExportScreen();
  await renderSettings();
}

function buildProfileSyncPayload(profile = state.profile) {
  if (!profile) return null;
  const displayName = String(profile.display_name || "").trim();
  const country = getRecognizedCountryId(profile.country);
  return {
    name: displayName || null,
    business_name: displayName || null,
    country: country || null,
    business_type_id: String(profile.business_type_id || "").trim() || null,
    sector_id: String(profile.sector_id || "").trim() || null,
    preferred_labels: normalizePreferredLabels(profile.preferred_labels, profile.business_type_id),
    email: normalizeEmailAddress(profile.email || "") || null
  };
}

async function pushProfile() {
  if (!(state.profile && state.authToken && state.syncApiBaseUrl)) return;
  const payload = buildProfileSyncPayload();
  if (!payload) return;
  try {
    await postJson(state.syncApiBaseUrl, "/profile", payload, state.authToken);
  } catch (error) {
    console.warn("Profile push skipped.", error);
  }
}

function mergeServerProfile(serverProfile, fallbackCountry = getSelectedCountryId()) {
  if (!serverProfile) return null;
  const displayName = String(serverProfile.business_name || serverProfile.name || "").trim();
  return normalizeLocalProfile({
    ...(state.profile || {}),
    plan: normalizePlan(state.profile?.plan),
    display_name: displayName || state.profile?.display_name || "",
    phone_number: String(serverProfile.phone || state.profile?.phone_number || "").trim(),
    email: normalizeEmailAddress(serverProfile.email || state.profile?.email || ""),
    country: normalizeCountryId(serverProfile.country || fallbackCountry || state.profile?.country),
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
  return {
    id: 1000000000 + index + 1,
    server_entry_id: Number(record.entry_id || 0),
    importedFromServer: true,
    device_identity: String(record.device_identity || "").trim(),
    transaction_type: transactionType,
    label: String(record.label || "").trim() || "Imported record",
    normalized_label: String(record.normalized_label || "").trim() || normalizeText(record.label || transactionType),
    amount_minor: Number(record.amount_minor || 0),
    currency: record.currency || (state.profile?.country === "US" ? "USD" : "NGN"),
    counterparty: record.counterparty ?? null,
    source_account: record.source_account ?? null,
    destination_account: record.destination_account ?? null,
    input_mode: record.input_mode || "server_restore",
    confirmation_state: "confirmed",
    business_type_id: record.business_type_id || state.profile?.business_type_id || null,
    sector_id: record.sector_id || state.profile?.sector_id || null,
    country: record.country || state.profile?.country || getSelectedCountryId(),
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

async function pullRecordsFromServer() {
  const response = await fetchAuthenticatedJson("/records");
  return Array.isArray(response.records) ? response.records : [];
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
      country: getSelectedCountryId()
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
    state.profile = { plan: "free", country };
  }

  if (channel === "email") {
    state.profile.email = identifier;
  } else {
    state.profile.phone_number = identifier;
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
    country: normalizeCountryId(country || state.profile?.country),
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
  if (!devices.length) {
    container.innerHTML = `<div class="record-meta">${emptyMessage}</div>`;
    return;
  }

  container.innerHTML = devices.map((device) => `
    <div class="device-row">
      <div class="device-meta">
        <strong>${formatDeviceIdentityShort(device.device_identity)}</strong>
        <span class="record-meta">${getDeviceStatusCopy(device)}</span>
      </div>
      ${(!device.is_current && !device.revoked_at)
        ? `<button class="btn btn-secondary" type="button" data-device-revoke="${device.device_identity}">Revoke</button>`
        : ""}
    </div>
  `).join("");

  container.querySelectorAll("[data-device-revoke]").forEach((button) => {
    button.addEventListener("click", () => {
      void onRevoke(String(button.dataset.deviceRevoke || ""));
    });
  });
}

async function revokeDevice(deviceIdentity) {
  if (!deviceIdentity) return;
  await postJson(state.syncApiBaseUrl, "/identity/revoke", {
    device_identity: deviceIdentity
  }, state.authToken);
}

async function renderTrustedDevicesSettings() {
  if (!els["settings-devices-v2"]) return;
  if (!state.authToken) {
    els["settings-devices-v2"].innerHTML = `<div class="record-meta">${getVerificationActionLabel()} on this device to manage trusted devices.</div>`;
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
    els["settings-devices-v2"].innerHTML = `<div class="record-meta">${error.message || "Unable to load trusted devices."}</div>`;
  }
}

async function maybePromptToRevokeOldDevices() {
  if (!els["revoke-old-devices-modal"]) return;

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
  try {
    await pullProfile(country);
  } catch (error) {
    if (error.statusCode) {
      console.warn("Profile pull skipped.", error);
    } else {
      throw error;
    }
  }

  if (!state.profile) {
    state.profile = buildFallbackRecoveredProfile(country, phoneNumber);
    await saveProfile(state.profile, { skipPush: true });
  } else {
    state.profile = buildFallbackRecoveredProfile(country, state.profile.phone_number || phoneNumber);
    await saveProfile(state.profile, { skipPush: true });
  }

  const records = await pullRecordsFromServer();
  await replaceLocalRecordsWithImported(records);
  hydrateProfileUi();
  closeRestoreModal();
  await showCapture();
  syncDevQaSnapshot("restore_completed");
  await maybePromptToRevokeOldDevices();
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
  const examples = getCaptureExamples(state.profile?.country);
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
  syncCountryAwareInputs();
  els["onboarding-name"].value = state.profile?.display_name || "";
  els["onboarding-phone"].value = formatPhoneForInput(state.profile?.phone_number || "", getSelectedCountryId());
  els["onboarding-email"].value = state.profile?.email || "";
  els["onboarding-state"].value = state.profile?.region || "";
  els["onboarding-birth-year"].value = state.profile?.birth_year || "";
  els["onboarding-gender"].value = state.profile?.gender || "";
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
  utterance.lang = state.profile?.country === "US" ? "en-US" : "en-NG";
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

function getDashboardMetrics(records, effectiveRecords) {
  const cacheKey = `${records.length}:${state.profile?.country || ""}`;
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
    monthlyExpenses: 0
  };

  effectiveRecords.forEach((record) => {
    const amount = Number(record.amount_minor || 0);
    const date = new Date(record.confirmed_at * 1000);
    const isToday = date.toDateString() === todayKey;
    const isThisMonth = date.getMonth() === currentMonth && date.getFullYear() === currentYear;

    if (record.transaction_type === "sale") {
      if (isToday) metrics.todaySales += amount;
      if (isThisMonth) metrics.monthlySales += amount;
    }

    if (record.transaction_type === "payment" || record.transaction_type === "purchase") {
      if (isThisMonth) metrics.monthlyExpenses += amount;
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
    country: record.country
  };
  els["confirm-copy-v2"].textContent = confirmationCopy(state.candidateRecord);
  els["confirm-meta-v2"].innerHTML = `
    <div><strong>Type:</strong> reversal</div>
    <div><strong>Original type:</strong> ${record.transaction_type}</div>
    <div><strong>Amount:</strong> ${formatMoney(record.amount_minor, record.currency)}</div>
    <div><strong>Reverses:</strong> ${record.entry_hash}</div>
  `;
  showScreen("screen-confirm");
  speakConfirmationCopy(els["confirm-copy-v2"].textContent);
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
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
      resolve(normalizeLocalProfile(request.result, { trackReminderMigration: true }));
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
  syncGlobalDeviceIdentity();
}

async function loadSyncState() {
  if (!state.db) return;
  const [authToken, authTokenExpiresAt, syncApiBaseUrl, lastSyncAt, lastSyncReceipt] = await Promise.all([
    getSetting("auth_token"),
    getSetting("auth_token_expires_at"),
    getSetting("sync_api_base_url"),
    getSetting("last_sync_at"),
    getSetting("last_sync_receipt")
  ]);
  state.authToken = authToken || "";
  state.authTokenExpiresAt = authTokenExpiresAt || "";
  state.syncApiBaseUrl = syncApiBaseUrl || getDefaultSyncApiBaseUrl();
  state.lastSyncAt = lastSyncAt || "";
  state.lastSyncReceipt = lastSyncReceipt || "";
  if (!syncApiBaseUrl && state.syncApiBaseUrl) {
    await saveSetting("sync_api_base_url", state.syncApiBaseUrl);
  }
  await refreshSyncQueueCount();
  state.syncStatus = state.authToken
    ? "Ready to sync queued entries."
    : "Waiting for server OTP verification.";
}

async function createAndStoreDeviceKeyMaterial() {
  if (!isWebCryptoAvailable()) {
    throw new Error("This browser does not support WebCrypto signing.");
  }
  if (state.devicePrivateKey && state.devicePublicKey && state.deviceIdentity && state.publicKeyFingerprint) {
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
  syncGlobalDeviceIdentity();
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
  state.syncStatus = state.authToken
    ? "Entry queued for server sync."
    : "Entry signed locally and queued. Complete server OTP to sync.";
}

async function flushSyncQueue() {
  if (state.syncInFlight || !state.db) return;
  const queuedEntries = await getSyncQueueEntries(25);
  if (!queuedEntries.length) {
    state.syncStatus = state.authToken ? "All queued entries synced." : state.syncStatus;
    await refreshSyncQueueCount();
    return;
  }
  if (!state.authToken) {
    state.syncStatus = "Queued entries are waiting for server OTP verification.";
    await refreshSyncQueueCount();
    return;
  }
  if (!state.syncApiBaseUrl) {
    state.syncStatus = "Queued entries cannot sync until a sync server URL is configured.";
    return;
  }
  if (!(state.deviceIdentity && state.devicePublicKey)) {
    state.syncStatus = "Device identity is missing, so server sync is paused.";
    return;
  }

  state.syncInFlight = true;
  state.syncStatus = `Syncing ${queuedEntries.length} queued entr${queuedEntries.length === 1 ? "y" : "ies"}...`;

  try {
    const response = await syncQueuedEntries(state.syncApiBaseUrl, state.authToken, {
      device_identity: state.deviceIdentity,
      public_key: state.devicePublicKey,
      entries: queuedEntries.map((item) => item.entry_payload)
    });
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
  if (state.authToken && state.authTokenExpiresAt) {
    return `Active until ${new Date(state.authTokenExpiresAt).toLocaleString()}`;
  }
  if (state.authToken) return "Active";
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
