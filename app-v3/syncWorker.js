function normalizeApiBaseUrl(rawUrl) {
  return String(rawUrl || "").trim().replace(/\/+$/, "");
}

export async function postJson(baseUrl, path, body, authToken) {
  const normalizedBaseUrl = normalizeApiBaseUrl(baseUrl);
  if (!normalizedBaseUrl) {
    const error = new Error("Sync server URL is not configured.");
    error.statusCode = 0;
    throw error;
  }

  const response = await fetch(`${normalizedBaseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {})
    },
    body: JSON.stringify(body)
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
    throw error;
  }

  return data || {};
}

export function getDefaultSyncApiBaseUrl() {
  const host = window.location.hostname;
  if (host === "127.0.0.1" || host === "localhost") {
    return "http://127.0.0.1:8787";
  }
  return "https://confirma-server-production.up.railway.app";
}

export async function requestOtpCode(baseUrl, phoneNumber) {
  return postJson(baseUrl, "/auth/otp/request", {
    phone_number: phoneNumber
  });
}

export async function verifyOtpCode(baseUrl, phoneNumber, code) {
  return postJson(baseUrl, "/auth/otp/verify", {
    phone_number: phoneNumber,
    code
  });
}

export async function syncQueuedEntries(baseUrl, authToken, payload) {
  return postJson(baseUrl, "/sync/entries", payload, authToken);
}

export async function rotateDeviceIdentity(baseUrl, authToken, payload) {
  return postJson(baseUrl, "/identity/rotate", payload, authToken);
}

export { normalizeApiBaseUrl };
