import {
  getDefaultSyncApiBaseUrl,
  postJson,
  requestOtpCode,
  syncQueuedEntries,
  verifyOtpCode
} from "./syncWorker.js";

const DB_NAME = "confirma-v3-db";
const DB_VERSION = 3;
const FEATURE_TRANSFER_PRIMARY = false;
const PAYSTACK_PUBLIC_KEY = "pk_test_placeholder";

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
  pinEntry: "",
  pinAttempts: 0,
  reminderDismissed: false,
  isConfirming: false,
  dashboardMetricsCache: null,
  lowStorageWarning: "",
  otpChallenge: null,
  otpReturnScreen: "screen-capture",
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

async function init() {
  cacheElements();
  state.db = await openDb();
  await loadCustomLabelsIntoCatalog();
  state.profile = await getProfile();
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

  if (state.profile) {
    state.profile.preferred_labels = Array.isArray(state.profile.preferred_labels) ? state.profile.preferred_labels : [];
    hydrateProfileUi();
    if (state.profile.pinEnabled && state.profile.pinHash) {
      showPinLock();
    }
    await showCapture();
    void flushSyncQueue();
  } else {
    showScreen("screen-onboarding");
  }
}

function cacheElements() {
  [
    "country-grid", "sector-grid", "business-grid", "common-label-grid", "onboarding-step-copy", "finish-onboarding",
    "onboarding-next", "onboarding-name", "onboarding-phone", "onboarding-email", "onboarding-state",
    "onboarding-birth-year", "onboarding-gender", "onboarding-profile-error",
    "business-helper", "profile-summary", "primary-actions", "advanced-panel", "transfer-actions",
    "quick-label-grid", "selected-label-chip", "amount-input-v2", "counterparty-input-v2", "source-account-input",
    "destination-account-input", "transfer-details", "capture-error", "confirm-copy-v2", "confirm-meta-v2",
    "recent-records-v2", "history-records-v2", "selector-modal", "label-search-input", "search-results",
    "speech-results", "browse-results", "speech-status", "custom-label-input", "onboarding-back",
    "change-confirm-modal", "mic-button-v2", "voice-label-v2", "voice-error-v2", "quick-text-input-v2",
    "bottom-nav-v2", "dash-today-sales-v2", "dash-monthly-sales-v2", "dash-monthly-expenses-v2",
    "dash-cash-flow-v2", "dashboard-records-v2", "settings-profile-v2", "settings-preferred-v2",
    "settings-capture-v2", "settings-summary-v2", "settings-trust-v3", "settings-change-profile-v2",
    "settings-open-trust-v3", "export-button-v2", "export-status-v2", "export-trust-status-v3", "export-open-trust-v3",
    "verified-report-section", "payment-status",
    "daily-reminder-banner", "dismiss-reminder-btn", "privacy-toggle-btn", "reminder-toggle", "pin-lock-toggle",
    "pin-setup-area", "pin-input-new", "pin-input-confirm", "pin-save-btn", "pin-remove-btn", "pin-setup-error",
    "settings-security-status", "pin-setup-label", "pin-lock-screen", "pin-error", "first-record-guide",
    "storage-warning-v2", "loan-readiness-banner", "banner-tier-icon", "banner-headline", "banner-subtext", "banner-cta",
    "otp-back", "otp-status-card", "otp-phone-input", "otp-request-code",
    "otp-helper-text", "otp-code-input", "otp-verify-code", "otp-error-text"
  ].forEach((id) => {
    els[id] = document.getElementById(id);
  });
}

function wireEvents() {
  document.getElementById("finish-onboarding").addEventListener("click", finishOnboarding);
  document.getElementById("onboarding-next").addEventListener("click", () => updateOnboardingStep(5));
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
  document.getElementById("settings-change-profile-v2").addEventListener("click", openChangeProfileConfirm);
  document.getElementById("settings-open-trust-v3").addEventListener("click", () => openTrustSetup("screen-settings"));
  document.getElementById("export-button-v2").addEventListener("click", generateExport);
  document.getElementById("export-open-trust-v3").addEventListener("click", () => openTrustSetup("screen-export"));
  document.getElementById("dismiss-reminder-btn").addEventListener("click", dismissDailyReminder);
  document.getElementById("privacy-toggle-btn").addEventListener("click", togglePrivacyMode);
  document.getElementById("reminder-toggle").addEventListener("click", toggleReminderPreference);
  document.getElementById("pin-lock-toggle").addEventListener("click", togglePinLockPreference);
  document.getElementById("pin-save-btn").addEventListener("click", savePinLock);
  document.getElementById("pin-remove-btn").addEventListener("click", removePinLock);
  document.getElementById("mic-button-v2").addEventListener("click", startVoiceRecordShortcut);
  document.getElementById("quick-text-submit").addEventListener("click", handleQuickTextRecord);
  document.getElementById("onboarding-name").addEventListener("input", updateFinishOnboardingState);
  document.getElementById("onboarding-phone").addEventListener("input", clearOnboardingProfileError);
  document.getElementById("onboarding-email").addEventListener("input", clearOnboardingProfileError);
  document.getElementById("otp-back").addEventListener("click", () => showScreen(state.otpReturnScreen || "screen-capture"));
  document.getElementById("otp-request-code").addEventListener("click", requestServerOtpCode);
  document.getElementById("otp-verify-code").addEventListener("click", verifyServerOtpCode);
  document.getElementById("otp-phone-input").addEventListener("input", clearOtpError);
  document.getElementById("otp-code-input").addEventListener("input", clearOtpError);
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

function renderCommonLabelGrid() {
  els["common-label-grid"].innerHTML = "";
  if (!(state.profile && state.profile.business_type_id)) return;

  const labels = getCommonTransactionOptions(state.profile.business_type_id);
  const selected = state.profile.preferred_labels || [];

  labels.forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `ranked-item${selected.includes(item.display_name) ? " active" : ""}`;
    button.innerHTML = `<strong>${getIconForLabel(item.display_name)} ${item.display_name}</strong><span>${friendlyActionLabel(item.context)}</span><small>Show more often while recording</small>`;
    button.addEventListener("click", () => togglePreferredLabel(item.display_name));
    els["common-label-grid"].appendChild(button);
  });
}

function updateOnboardingStep(step) {
  state.onboardingStep = step;
  document.querySelectorAll(".step").forEach((node) => node.classList.remove("active"));
  document.querySelector(`.step[data-step="${state.onboardingStep}"]`).classList.add("active");
  els["onboarding-step-copy"].textContent = `Step ${state.onboardingStep} of 5`;
  els["onboarding-back"].hidden = state.onboardingStep === 1;
  els["finish-onboarding"].hidden = state.onboardingStep !== 5;
  updateFinishOnboardingState();
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
  if (!state.profile.preferred_labels) state.profile.preferred_labels = [];
  state.profile.display_name = document.getElementById("onboarding-name")?.value.trim() || "";
  state.profile.phone_number = document.getElementById("onboarding-phone")?.value.trim() || "";
  state.profile.email = document.getElementById("onboarding-email")?.value.trim() || "";
  state.profile.region = document.getElementById("onboarding-state")?.value.trim() || "";
  state.profile.birth_year = document.getElementById("onboarding-birth-year")?.value.trim() || "";
  state.profile.gender = document.getElementById("onboarding-gender")?.value || "";

  if (!state.profile.display_name) {
    updateFinishOnboardingState();
    return;
  }

  if (state.profile.phone_number && !/^\+?[\d\s\-]{7,15}$/.test(state.profile.phone_number)) {
    showOnboardingProfileError("Enter a valid phone number");
    state.profile.phone_number = "";
  }

  if (state.profile.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(state.profile.email)) {
    showOnboardingProfileError("Enter a valid email address");
    state.profile.email = "";
  }

  await saveProfile(state.profile);
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

  const recent = [...records].reverse().slice(0, 5);
  els["dashboard-records-v2"].innerHTML = recent.length
    ? recent.map(renderRecordCard).join("")
    : `<div class="record-card"><strong>No confirmed records yet.</strong><div class="record-meta">Your recent confirmed transactions will appear here.</div></div>`;

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
}

async function renderSettings() {
  if (!state.profile) return;
  const records = await getRecords();
  const effectiveRecords = getOperationalRecords(records);
  const businessType = BUSINESS_TYPES.find((item) => item.id === state.profile.business_type_id);
  const sector = SECTORS.find((item) => item.id === state.profile.sector_id);
  const preferred = state.profile.preferred_labels || [];
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
    ${renderSettingsRow("Week B status", isSigningReady() ? "This device can sign locally and queue entries for server sync." : "Finish phone verification and device key setup before confirming new entries.")}
  `;

  els["settings-capture-v2"].innerHTML = `
    ${renderSettingsRow("Primary recording mode", "Voice-first with text fallback")}
    ${renderSettingsRow("Confirmation rule", "Every transaction must be reviewed before append")}
    ${renderSettingsRow("Quick-pick strategy", preferred.length ? `${preferred.length} common transaction${preferred.length === 1 ? "" : "s"} boosted` : "Using business defaults")}
    ${renderSettingsRow("Transfer handling", "Separate from income and expense")}
  `;

  if (state.profile.reminderEnabled === false) {
    els["reminder-toggle"].classList.remove("on");
  } else {
    els["reminder-toggle"].classList.add("on");
  }

  if (state.profile.pinEnabled && state.profile.pinHash) {
    els["pin-lock-toggle"].classList.add("on");
    els["pin-setup-area"].hidden = false;
    els["pin-remove-btn"].hidden = false;
    els["pin-setup-label"].textContent = "PIN is set — enter new PIN to change";
  } else {
    els["pin-lock-toggle"].classList.remove("on");
    els["pin-setup-area"].hidden = true;
    els["pin-remove-btn"].hidden = true;
    els["pin-setup-label"].textContent = "Set a 4-digit PIN";
    els["settings-security-status"].textContent = "";
    els["pin-setup-error"].textContent = "";
  }

  els["settings-preferred-v2"].innerHTML = preferred.length
    ? preferred.map((label) => `<div class="settings-chip">${getIconForLabel(label)} ${label}</div>`).join("")
    : `<div class="record-meta">No common transactions selected yet.</div>`;

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
  els["pin-error"].textContent = "";
  els["pin-lock-screen"].hidden = false;
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

async function pinMatchesProfile(pin) {
  if (!state.profile) return false;
  if (state.profile.pinSalt) {
    return (await hashPin(pin, state.profile.pinSalt)) === state.profile.pinHash;
  }
  return legacyHashPin(pin) === state.profile.pinHash;
}

async function upgradeLegacyPinHash(pin) {
  if (!(state.profile && !state.profile.pinSalt && state.profile.pinHash)) return;
  state.profile.pinSalt = createPinSalt();
  state.profile.pinHash = await hashPin(pin, state.profile.pinSalt);
  await saveProfile(state.profile);
}

async function handlePinKey(digit) {
  if (!(state.profile && state.profile.pinEnabled && state.profile.pinHash)) return;

  if (digit === "back") {
    state.pinEntry = state.pinEntry.slice(0, -1);
    updatePinDots();
    return;
  }

  if (state.pinEntry.length >= 4) return;
  state.pinEntry += digit;
  updatePinDots();

  if (state.pinEntry.length !== 4) return;

  if (await pinMatchesProfile(state.pinEntry)) {
    if (!state.profile.pinSalt) {
      await upgradeLegacyPinHash(state.pinEntry);
    }
    state.pinAttempts = 0;
    hidePinLock();
    els["pin-error"].textContent = "";
    return;
  }

  state.pinAttempts += 1;
  state.pinEntry = "";
  updatePinDots();
  els["pin-error"].textContent = state.pinAttempts >= 3 ? "Too many attempts. Try again." : "Incorrect PIN. Try again.";
  setTimeout(() => {
    if (els["pin-error"]) els["pin-error"].textContent = "";
  }, 2000);
}

async function togglePinLockPreference() {
  if (!state.profile) return;
  const enabled = els["pin-lock-toggle"].classList.toggle("on");

  if (enabled) {
    els["pin-setup-area"].hidden = false;
    els["pin-remove-btn"].hidden = !state.profile.pinEnabled;
    els["pin-setup-label"].textContent = state.profile.pinEnabled ? "PIN is set — enter new PIN to change" : "Set a 4-digit PIN";
    return;
  }

  els["pin-setup-area"].hidden = true;
  els["pin-remove-btn"].hidden = true;
  state.profile.pinEnabled = false;
  state.profile.pinHash = null;
  state.profile.pinSalt = null;
  await saveProfile(state.profile);
}

async function savePinLock() {
  if (!state.profile) return;
  const newPin = els["pin-input-new"].value.trim();
  const confirmPin = els["pin-input-confirm"].value.trim();

  if (!/^\d{4}$/.test(newPin)) {
    els["pin-setup-error"].textContent = "PIN must be exactly 4 digits";
    return;
  }

  if (newPin !== confirmPin) {
    els["pin-setup-error"].textContent = "PINs do not match";
    return;
  }

  state.profile.pinEnabled = true;
  state.profile.pinSalt = createPinSalt();
  state.profile.pinHash = await hashPin(newPin, state.profile.pinSalt);
  await saveProfile(state.profile);

  els["pin-input-new"].value = "";
  els["pin-input-confirm"].value = "";
  els["pin-setup-error"].textContent = "";
  els["pin-remove-btn"].hidden = false;
  els["pin-setup-area"].hidden = false;
  els["pin-setup-label"].textContent = "PIN is set — enter new PIN to change";
  els["settings-security-status"].textContent = "PIN lock enabled";
  setTimeout(() => {
    if (els["settings-security-status"]) els["settings-security-status"].textContent = "";
  }, 2000);
}

async function removePinLock() {
  if (!state.profile) return;
  if (!window.confirm("Remove PIN lock? The app will open without a PIN.")) return;

  state.profile.pinEnabled = false;
  state.profile.pinHash = null;
  state.profile.pinSalt = null;
  await saveProfile(state.profile);
  els["pin-lock-toggle"].classList.remove("on");
  els["pin-setup-area"].hidden = true;
  els["pin-remove-btn"].hidden = true;
  els["pin-input-new"].value = "";
  els["pin-input-confirm"].value = "";
  els["pin-setup-error"].textContent = "";
  els["settings-security-status"].textContent = "PIN removed";
  setTimeout(() => {
    if (els["settings-security-status"]) els["settings-security-status"].textContent = "";
  }, 2000);
}

function renderExportScreen() {
  els["export-status-v2"].textContent = "";
  if (els["payment-status"]) {
    els["payment-status"].textContent = "";
  }
  if (els["verified-report-section"]) {
    els["verified-report-section"].hidden = !(state.authToken && state.deviceIdentity);
  }
  if (els["export-trust-status-v3"]) {
    els["export-trust-status-v3"].innerHTML = `
      ${renderSettingsRow("Phone anchor", getPhoneAnchorStatusLabel())}
      ${renderSettingsRow("Device key", getDeviceKeyStatusLabel())}
      ${state.publicKeyFingerprint ? renderSettingsRow("Public key fingerprint", state.publicKeyFingerprint) : ""}
      ${renderSettingsRow("Sync status", state.syncStatus || "Idle")}
      ${renderSettingsRow("Queued sync entries", String(state.syncQueueCount))}
      ${renderSettingsRow("Recovery contact", state.profile?.email || state.profile?.phone_number || "Not set")}
    `;
  }
  refreshStorageWarning();
}

async function generateExport() {
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
      record.id,
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
    : "Legacy unsigned history only. Complete phone verification to start device signing.";

  const output = [
    "CONFIRMA V3 EXPORT",
    `Generated: ${new Date().toLocaleString()}`,
    `Profile: ${countryName(state.profile.country)} / ${BUSINESS_TYPES.find((item) => item.id === state.profile.business_type_id)?.name || "Unknown"}`,
    state.profile.display_name ? `Name: ${state.profile.display_name}` : null,
    state.profile.region ? `Region: ${state.profile.region}` : null,
    `Phone Anchor: ${getPhoneAnchorStatusLabel()}`,
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
    setPaymentStatus("Complete phone verification on this device before purchasing a verified report.");
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
  if (item.subtitle) return item.subtitle;
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

function setVoiceRecordError(message) {
  els["voice-error-v2"].hidden = !message;
  els["voice-error-v2"].textContent = message || "";
}

function handleQuickTextRecord() {
  const input = els["quick-text-input-v2"].value.trim();
  if (!input) {
    setVoiceRecordError("Type a short transaction like: Sold rice for 15000.");
    return;
  }
  const parsed = parseNaturalTransaction(input);
  if (!parsed) {
    setVoiceRecordError("Could not understand that. Try: Sold rice for 15000.");
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

  return null;
}

function startVoiceRecordShortcut() {
  setVoiceRecordError("");
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRec) {
    setVoiceRecordError("Voice input is not available in this browser. Please use text input.");
    return;
  }

  const recognition = new SpeechRec();
  recognition.lang = state.profile.country === "US" ? "en-US" : "en-NG";
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript;
    const parsed = parseNaturalTransaction(transcript);
    if (!parsed || !parsed.amountMinor) {
      setVoiceRecordError("Could not understand that. Try: Sold rice for 15000.");
      return;
    }
    applyParsedTransactionToCapture(parsed);
  };

  recognition.onerror = () => {
    setVoiceRecordError("Microphone error. Please try again or use text input.");
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

function applyParsedTransactionToCapture(parsed) {
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

function togglePreferredLabel(label) {
  if (!state.profile) return;
  const selected = new Set(state.profile.preferred_labels || []);
  if (selected.has(label)) selected.delete(label);
  else selected.add(label);
  state.profile.preferred_labels = [...selected];
  renderCommonLabelGrid();
}

async function openSelector() {
  els["selector-modal"].hidden = false;
  setSelectorMode("search");
  await handleSearch();
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
  els["recent-records-v2"].innerHTML = recent.length
    ? recent.map(renderRecordCard).join("")
    : `<div class="record-card"><strong>No confirmed records yet.</strong><div class="record-meta">Tap a label, enter an amount, then review before confirming. Your first confirmed record starts your history.</div></div>`;
}

async function renderHistory() {
  const records = await getRecords();
  const reversedHashes = getReversedEntryHashSet(records);
  els["history-records-v2"].innerHTML = records.length
    ? [...records].reverse().map((record) => {
      return renderRecordCard(record, {
        allowReverse: record.transaction_type !== "reversal" && !reversedHashes.has(record.entry_hash)
      });
    }).join("")
    : `<div class="record-card"><strong>No history yet.</strong><div class="record-meta">Nothing has been appended yet.</div></div>`;
  wireReverseButtons(records);
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

function getCatalogForCurrentProfile() {
  return getCatalogForProfileAction(getCurrentActionContext());
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
  document.getElementById(id).classList.add("active");
  if (id !== "screen-confirm") {
    cancelConfirmationSpeech();
  }
  if (previousScreen === "screen-dashboard" && id !== "screen-dashboard" && state.amountsHidden) {
    resetPrivacyMode();
  }
  updateBottomNav(id);
}

function openTrustSetup(returnScreen = "screen-capture") {
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
}

function closeChangeProfileConfirm() {
  els["change-confirm-modal"].hidden = true;
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
  return COUNTRIES.find((item) => item.id === countryId)?.name || countryId;
}

function parseMinor(value) {
  const number = parseFloat(String(value || "").replace(/,/g, ""));
  return Number.isFinite(number) ? Math.round(number * 100) : 0;
}

function updateAmountInputStep() {
  if (!els["amount-input-v2"]) return;
  els["amount-input-v2"].step = state.profile?.country === "US" ? "0.01" : "1";
}

function renderOtpScreen() {
  if (!els["otp-phone-input"]) return;
  els["otp-phone-input"].value = state.profile?.phone_number || "";
  els["otp-code-input"].value = "";
  els["otp-helper-text"].textContent = state.otpChallenge
    ? getOtpHelperText()
    : "Request a code. If the server is unavailable, Confirma falls back to a local development code for this device.";
  els["otp-status-card"].innerHTML = `
    ${renderSettingsRow("Current status", getPhoneAnchorStatusLabel())}
    ${renderSettingsRow("Device key", getDeviceKeyStatusLabel())}
    ${state.publicKeyFingerprint ? renderSettingsRow("Public key fingerprint", state.publicKeyFingerprint) : ""}
    ${renderSettingsRow("Sync server", state.syncApiBaseUrl || "Not configured")}
    ${renderSettingsRow("Auth session", getAuthSessionStatusLabel())}
    ${renderSettingsRow("Phone on profile", state.profile?.phone_number || "Not set")}
    ${renderSettingsRow("Email for delivery", state.profile?.email || "Not set")}
  `;
  clearOtpError();
}

async function requestLocalOtpCode() {
  if (!state.profile) return;
  const phoneNumber = els["otp-phone-input"]?.value.trim() || "";
  if (!isValidPhoneNumber(phoneNumber)) {
    showOtpError("Enter a valid phone number");
    return;
  }

  state.profile.phone_number = phoneNumber;
  await saveProfile(state.profile);
  try {
    const response = await requestOtpCode(state.syncApiBaseUrl, phoneNumber);
    state.otpChallenge = {
      phoneNumber,
      expiresAt: Date.now() + 10 * 60 * 1000,
      source: "server",
      devCode: response.dev_code || ""
    };
    state.syncStatus = "OTP requested from sync server.";
  } catch (error) {
    const random = new Uint32Array(1);
    crypto.getRandomValues(random);
    const code = String(random[0] % 1000000).padStart(6, "0");
    state.otpChallenge = {
      code,
      phoneNumber,
      expiresAt: Date.now() + 10 * 60 * 1000,
      source: "local"
    };
    state.syncStatus = "Sync server unavailable. Using local OTP fallback.";
  }
  renderOtpScreen();
}

async function verifyLocalOtpCode() {
  if (!state.profile) return;
  const enteredCode = (els["otp-code-input"]?.value || "").trim();
  const activeChallenge = state.otpChallenge;
  if (!activeChallenge) {
    showOtpError("Generate a code first");
    return;
  }
  if (Date.now() > activeChallenge.expiresAt) {
    state.otpChallenge = null;
    renderOtpScreen();
    showOtpError("This code expired. Generate a new one");
    return;
  }
  if (!/^\d{6}$/.test(enteredCode)) {
    showOtpError("Enter a valid 6-digit code");
    return;
  }
  if (activeChallenge.source === "server") {
    try {
      const response = await verifyOtpCode(activeChallenge.serverBaseUrl || state.syncApiBaseUrl, activeChallenge.phoneNumber, enteredCode);
      state.authToken = response.auth_token || "";
      state.authTokenExpiresAt = response.expires_at || "";
      state.profile.identity_anchor = "phone";
      state.profile.identity_status = "verified_server";
      state.profile.identity_verified_at = Date.now();
      state.profile.phone_number = activeChallenge.phoneNumber;
      await Promise.all([
        saveProfile(state.profile),
        saveSetting("auth_token", state.authToken),
        saveSetting("auth_token_expires_at", state.authTokenExpiresAt)
      ]);
      state.syncStatus = "Phone verified with sync server.";
    } catch (error) {
      showOtpError(error.message || "Server OTP verification failed.");
      return;
    }
  } else if (enteredCode !== activeChallenge.code) {
    showOtpError("Enter the 6-digit code shown for this device");
    return;
  } else {
    state.profile.phone_number = activeChallenge.phoneNumber;
    state.profile.identity_anchor = "phone";
    state.profile.identity_status = "verified_local";
    state.profile.identity_verified_at = Date.now();
    await saveProfile(state.profile);
    state.syncStatus = "Phone verified locally. Sign-in with the server still pending.";
  }

  try {
    await ensureDeviceKeyMaterial();
  } catch (error) {
    showOtpError(error.message || "Phone verified, but device key setup failed.");
    return;
  }

  state.otpChallenge = null;
  await refreshSyncQueueCount();
  renderOtpScreen();
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

function getPhoneAnchorStatusLabel() {
  if (state.profile?.identity_status === "verified_server") {
    return "Verified with sync server";
  }
  if (state.profile?.identity_status === "verified_local") {
    return "Verified on this device (local fallback)";
  }
  return "Not verified yet";
}

function isValidPhoneNumber(value) {
  return /^\+?[\d\s\-]{7,15}$/.test(value);
}

function showOtpError(message) {
  if (!els["otp-error-text"]) return;
  els["otp-error-text"].hidden = !message;
  els["otp-error-text"].textContent = message || "";
}

function clearOtpError() {
  showOtpError("");
}

function renderFirstRecordGuide(records) {
  if (!els["first-record-guide"]) return;
  els["first-record-guide"].innerHTML = `
    <strong>📋 Record your first transaction</strong>
    <div style="margin-top:8px;line-height:1.7">
      <strong style="font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:var(--primary-mid)">
        By voice
      </strong><br>
      Tap the mic, speak naturally — "Sold rice for 15,000" or "Paid transport 2,000".<br>
      The app fills the action, label, and amount. Review, then confirm.
    </div>
    <div style="margin-top:10px;line-height:1.7">
      <strong style="font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:var(--primary-mid)">
        By text
      </strong><br>
      Type a short phrase in the text box — same format. Or tap a quick-pick label,
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
  els["onboarding-name"].value = state.profile?.display_name || "";
  els["onboarding-phone"].value = state.profile?.phone_number || "";
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
    request.onsuccess = () => resolve(request.result.sort((a, b) => a.id - b.id));
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
    request.onsuccess = () => resolve(request.result ? request.result.value : null);
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

async function ensureDeviceKeyMaterial() {
  if (!hasVerifiedPhoneAnchor()) {
    throw new Error("Verify a phone number before setting up this device key.");
  }
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
      state.syncStatus = "Sync auth expired. Re-verify your phone.";
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
  return Boolean(
    (state.profile?.identity_status === "verified_local" || state.profile?.identity_status === "verified_server")
    && state.profile?.phone_number
  );
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
  if (hasVerifiedPhoneAnchor()) return "Phone verified, device key still missing";
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
  if (!hasVerifiedPhoneAnchor()) {
    return "Verify your phone before confirming a new record.";
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
  if (state.otpChallenge.source === "server" && state.otpChallenge.devCode) {
    return `Server OTP requested. Development code: ${state.otpChallenge.devCode}. It expires in 10 minutes.`;
  }
  if (state.otpChallenge.source === "server") {
    return "Server OTP requested. Enter the code sent by the sync server.";
  }
  return `Local fallback code for this device: ${state.otpChallenge.code}. It expires in 10 minutes.`;
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
  const phoneInput = document.getElementById("otp-phone-input");
  const phoneNumber = phoneInput.value.trim();

  if (!phoneNumber) {
    alert("Enter phone number");
    return;
  }

  try {
    const res = await fetch(`${state.syncApiBaseUrl}/auth/otp/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone_number: phoneNumber })
    });

    const data = await res.json();
    console.log("OTP request response:", data);

    state.otpChallenge = {
      phoneNumber,
      expiresAt: Date.now() + 10 * 60 * 1000,
      source: "server",
      devCode: data.dev_code || ""
    };
    renderOtpScreen();
  } catch (err) {
    console.error(err);
    alert("Failed to request OTP");
  }
}

async function verifyServerOtpCode() {
  const phoneInput = document.getElementById("otp-phone-input");
  const codeInput = document.getElementById("otp-code-input");

  const phoneNumber = phoneInput.value.trim();
  const code = codeInput.value.trim();

  if (!phoneNumber || !code) {
    alert("Enter phone and code");
    return;
  }

  try {
    const res = await fetch("http://127.0.0.1:8787/auth/otp/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phone_number: phoneNumber,
        code: code
      })
    });

    const data = await res.json();
    console.log("OTP verify response:", data);

    if (data.auth_token) {
      localStorage.setItem("auth_token", data.auth_token);
      alert("Server sign-in successful");
      window.location.reload();

      if (typeof syncQueuedEntries === "function") {
        await syncQueuedEntries();
      }
    } else {
      alert("Verification failed");
    }
  } catch (err) {
    console.error(err);
    alert("Failed to verify OTP");
  }
}
