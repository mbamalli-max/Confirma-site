export function maskPhone(phone) {
  if (!phone || phone.length < 6) return "***";
  const digits = phone.replace(/\D/g, "");
  if (digits.length <= 4) return "***" + digits.slice(-2);
  // Show first few chars (country code area) and last 4
  const prefix = phone.startsWith("+") ? phone.slice(0, phone.indexOf(digits[0]) + (phone.startsWith("+234") ? 4 : 2)) : "";
  return prefix + "****" + digits.slice(-4);
}

export function maskEmail(email) {
  if (!email || !email.includes("@")) return "***";
  const [local, domain] = email.split("@");
  if (local.length <= 2) return local[0] + "***@" + domain;
  return local[0] + "***" + local.slice(-1) + "@" + domain;
}
