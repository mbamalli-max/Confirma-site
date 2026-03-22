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
  retur