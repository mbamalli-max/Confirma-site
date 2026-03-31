import crypto from "node:crypto";
import { Readable } from "node:stream";
import { authenticateRequest, buildReceiptSignature } from "../auth-utils.js";
import { query } from "../db.js";

const VERIFY_BASE_URL = process.env.VERIFY_BASE_URL || "https://konfirmata.com";
const PATENT_NOTICE = "Protected under USPTO Provisional Application 63/987,858. Konfirmata Temporal Attestation System (TAS). Unauthorized reproduction of this attestation mechanism is prohibited.";
let resendModulePromise = null;
let pdfkitModulePromise = null;
let qrCodeModulePromise = null;

async function getResendClient(apiKey) {
  if (!apiKey) return null;
  if (!resendModulePromise) {
    resendModulePromise = import("resend");
  }
  const { Resend } = await resendModulePromise;
  return new Resend(apiKey);
}

async function getPdfDocumentConstructor() {
  if (!pdfkitModulePromise) {
    pdfkitModulePromise = import("pdfkit");
  }
  const module = await pdfkitModulePromise;
  return module.default;
}

async function getQrCodeModule() {
  if (!qrCodeModulePromise) {
    qrCodeModulePromise = import("qrcode");
  }
  const module = await qrCodeModulePromise;
  return module.default || module;
}

function parseWindowDays(value, fallback = 30) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

function getMetadataFields(metadata) {
  const customFields = Array.isArray(metadata?.custom_fields) ? metadata.custom_fields : [];
  return customFields.reduce((accumulator, field) => {
    const key = String(field?.variable_name || "").trim();
    if (key) accumulator[key] = field?.value;
    return accumulator;
  }, {});
}

function safeCompareHex(expectedHex, providedHex) {
  if (!expectedHex || !providedHex) return false;
  if (expectedHex.length !== providedHex.length) return false;

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expectedHex, "hex"),
      Buffer.from(providedHex, "hex")
    );
  } catch (error) {
    return false;
  }
}

function formatMoney(amountMinor, currency = "NGN") {
  const amount = Number(amountMinor || 0) / 100;
  if (currency === "USD") {
    return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return `₦${amount.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  });
}

function formatDateOnly(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleDateString("en-US", {
    dateStyle: "medium"
  });
}

function fmt(amountMinor, cur = "NGN") {
  const currency = String(cur || "NGN").toUpperCase() === "USD" ? "USD" : "NGN";
  const locale = currency === "USD" ? "en-US" : "en-NG";
  const amount = Number(amountMinor || 0) / 100;
  return `${currency} ${new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(amount)}`;
}

function getStatementTransactionType(entry) {
  return String(
    entry?.transaction_type
    || entry?.payload?.transaction_type
    || entry?.payload?.action
    || ""
  ).trim().toLowerCase();
}

function getStatementAmountMinor(entry) {
  return Number(entry?.amount_minor ?? entry?.payload?.amount_minor ?? 0);
}

function getStatementReversedHash(entry) {
  return String(entry?.reversed_entry_hash || entry?.payload?.reversed_entry_hash || "").trim();
}

function getStatementConfirmedAtSeconds(entry) {
  const value = entry?.confirmed_at;
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1e12) return Math.floor(value / 1000);
    return Math.floor(value);
  }
  if (value instanceof Date) {
    return Math.floor(value.getTime() / 1000);
  }
  const parsed = Date.parse(String(value || ""));
  return Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000);
}

function computeFinancialStatements(entries, currency) {
  const reversedHashes = new Set(
    entries
      .filter((entry) => getStatementTransactionType(entry) === "reversal" && getStatementReversedHash(entry))
      .map((entry) => getStatementReversedHash(entry))
  );

  const effective = entries.filter((entry) => {
    const transactionType = getStatementTransactionType(entry);
    if (transactionType === "reversal") return false;
    return !reversedHashes.has(String(entry?.entry_hash || ""));
  });

  let grossRevenue = 0;
  let otherIncome = 0;
  let costOfGoods = 0;
  let operatingExpenses = 0;
  let start = null;
  let end = null;
  const monthlyBuckets = new Map();

  effective.forEach((entry) => {
    const transactionType = getStatementTransactionType(entry);
    const amountMinor = getStatementAmountMinor(entry);
    const confirmedAt = getStatementConfirmedAtSeconds(entry);
    if (!confirmedAt) return;

    if (start == null || confirmedAt < start) start = confirmedAt;
    if (end == null || confirmedAt > end) end = confirmedAt;

    const month = new Date(confirmedAt * 1000).toISOString().slice(0, 7);
    const bucket = monthlyBuckets.get(month) || { inflows: 0, outflows: 0, net: 0 };

    if (transactionType === "sale") {
      grossRevenue += amountMinor;
      bucket.inflows += amountMinor;
    } else if (transactionType === "receipt") {
      otherIncome += amountMinor;
      bucket.inflows += amountMinor;
    } else if (transactionType === "purchase") {
      costOfGoods += amountMinor;
      bucket.outflows += amountMinor;
    } else if (transactionType === "payment") {
      operatingExpenses += amountMinor;
      bucket.outflows += amountMinor;
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
    cashFlowByMonth: [...monthlyBuckets.entries()]
      .sort(([monthA], [monthB]) => monthA.localeCompare(monthB))
      .map(([month, values]) => ({
        month,
        inflows: values.inflows,
        outflows: values.outflows,
        net: values.net
      })),
    dateRange: { start, end },
    currency
  };
}

function truncateText(value, maxLength) {
  const text = String(value ?? "");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

async function getDeviceRecord(deviceIdentity) {
  const result = await query(
    `SELECT phone_number, status, revoked_at FROM device_identities WHERE device_identity = $1 LIMIT 1`,
    [deviceIdentity]
  );
  return result.rows[0] || null;
}

async function getLedgerEntries(deviceIdentity, windowDays) {
  if (windowDays === 0) {
    const result = await query(
      `
        SELECT entry_id, entry_hash, confirmed_at, payload
        FROM ledger_entries
        WHERE device_identity = $1
        ORDER BY entry_id ASC
      `,
      [deviceIdentity]
    );
    return result.rows;
  }

  const result = await query(
    `
      SELECT entry_id, entry_hash, confirmed_at, payload
      FROM ledger_entries
      WHERE device_identity = $1
        AND confirmed_at >= NOW() - ($2 || ' days')::interval
      ORDER BY entry_id ASC
    `,
    [deviceIdentity, String(windowDays)]
  );
  return result.rows;
}

async function createAttestation(phoneNumber, deviceIdentity, windowDays) {
  const entries = await getLedgerEntries(deviceIdentity, windowDays);

  if (!entries.length) {
    const error = new Error("No entries in this window.");
    error.statusCode = 400;
    throw error;
  }

  const entryCount = entries.length;
  const ledgerRootHash = entries[entryCount - 1].entry_hash;
  const windowStart = new Date(entries[0].confirmed_at);
  const windowEnd = new Date(entries[entryCount - 1].confirmed_at);
  const vtId = crypto.randomBytes(16).toString("hex");
  const serverSignature = buildReceiptSignature([
    vtId,
    deviceIdentity,
    ledgerRootHash,
    windowStart.toISOString(),
    windowEnd.toISOString()
  ]);
  const issuedAt = new Date();

  await query(
    `
      INSERT INTO attestations (
        vt_id,
        device_identity,
        phone_number,
        ledger_root_hash,
        window_start,
        window_end,
        entry_count,
        server_signature,
        status,
        issued_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'VALID', $9)
    `,
    [
      vtId,
      deviceIdentity,
      phoneNumber,
      ledgerRootHash,
      windowStart.toISOString(),
      windowEnd.toISOString(),
      entryCount,
      serverSignature,
      issuedAt.toISOString()
    ]
  );

  return {
    vt_id: vtId,
    verify_url: `${VERIFY_BASE_URL}/verify/${vtId}`,
    ledger_root_hash: ledgerRootHash,
    window_start: windowStart.toISOString(),
    window_end: windowEnd.toISOString(),
    entry_count: entryCount,
    issued_at: issuedAt.toISOString(),
    server_signature: serverSignature,
    device_identity: deviceIdentity,
    device_fingerprint: deviceIdentity.slice(0, 8),
    entries
  };
}

async function getKeyRotationCount(deviceIdentity) {
  const result = await query(
    `SELECT COUNT(*)::int AS rotation_count FROM key_rotation_events WHERE old_device_identity = $1 OR new_device_identity = $1`,
    [deviceIdentity]
  );
  return result.rows[0]?.rotation_count || 0;
}

async function upsertPaymentRecord(payment) {
  await query(
    `
      INSERT INTO payments (
        phone_number,
        device_identity,
        reference,
        amount_kobo,
        tier,
        window_days,
        paystack_status,
        vt_id,
        completed_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (reference)
      DO UPDATE SET
        phone_number = EXCLUDED.phone_number,
        device_identity = EXCLUDED.device_identity,
        amount_kobo = EXCLUDED.amount_kobo,
        tier = EXCLUDED.tier,
        window_days = EXCLUDED.window_days,
        paystack_status = EXCLUDED.paystack_status,
        vt_id = COALESCE(EXCLUDED.vt_id, payments.vt_id),
        completed_at = COALESCE(EXCLUDED.completed_at, payments.completed_at)
    `,
    [
      payment.phone_number,
      payment.device_identity,
      payment.reference,
      payment.amount_kobo,
      payment.tier,
      payment.window_days,
      payment.paystack_status,
      payment.vt_id || null,
      payment.completed_at || null
    ]
  );
}

function drawStatusBadge(doc, x, y, text) {
  doc.save();
  doc.roundedRect(x, y, 90, 28, 14).fillAndStroke("#E8F5E9", "#52B788");
  doc.fillColor("#1B4332").fontSize(11).text(text, x, y + 8, {
    width: 90,
    align: "center"
  });
  doc.restore();
}

function drawEntryTableHeader(doc, y) {
  doc
    .fontSize(10)
    .fillColor("#6B7C6B")
    .text("ID", 50, y)
    .text("Type", 92, y)
    .text("Label", 160, y)
    .text("Amount", 325, y)
    .text("Date", 408, y)
    .text("Signed", 500, y);

  doc
    .moveTo(50, y + 16)
    .lineTo(545, y + 16)
    .strokeColor("#D4CDB8")
    .stroke();
}

function drawEntryPageFooter(doc, runningTotal, currency) {
  doc
    .fontSize(10)
    .fillColor("#1B2F1F")
    .text(`Running total: ${formatMoney(runningTotal, currency)}`, 50, doc.page.height - 54, {
      width: 495,
      align: "right"
    });
}

function drawPatentFooter(doc, options = {}) {
  const { y = doc.page.height - 90, fontSize = 9, lineGap = 2, color = "#6B7C6B" } = options;
  doc.font("Helvetica").fontSize(fontSize).fillColor(color).text(PATENT_NOTICE, 50, y, {
    width: 495,
    lineGap
  });
}

function drawStatementRow(doc, y, label, value, options = {}) {
  const { bold = false, emphasized = false } = options;
  const labelFont = emphasized ? 13 : 11;
  const valueFont = emphasized ? 13 : 11;
  doc.font(bold || emphasized ? "Helvetica-Bold" : "Helvetica").fontSize(labelFont).fillColor("#0F1A10").text(label, 50, y, {
    width: 260
  });
  doc.font(bold || emphasized ? "Helvetica-Bold" : "Helvetica").fontSize(valueFont).fillColor("#0F1A10").text(value, 350, y, {
    width: 195,
    align: "right"
  });
}

async function buildVerifiedReportPdf({
  attestation,
  businessName,
  phoneNumber,
  email,
  tier,
  windowDays,
  amountKobo,
  keyRotationEvents
}) {
  const PDFDocument = await getPdfDocumentConstructor();
  const QRCode = await getQrCodeModule();
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const chunks = [];

  const pdfReady = new Promise((resolve, reject) => {
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const qrBuffer = await QRCode.toBuffer(attestation.verify_url, { width: 200, margin: 1 });
  const entries = attestation.entries;
  const reportCurrency = entries[0]?.payload?.currency || "NGN";
  const statements = computeFinancialStatements(entries, reportCurrency);
  const totalInflows = statements.incomeStatement.grossRevenue + statements.incomeStatement.otherIncome;
  const totalOutflows = statements.incomeStatement.costOfGoods + statements.incomeStatement.operatingExpenses;
  const cashFlowTotals = statements.cashFlowByMonth.reduce((totals, month) => {
    totals.inflows += month.inflows;
    totals.outflows += month.outflows;
    totals.net += month.net;
    return totals;
  }, { inflows: 0, outflows: 0, net: 0 });
  const periodLabel = statements.dateRange.start && statements.dateRange.end
    ? `${formatDateOnly(new Date(statements.dateRange.start * 1000))} to ${formatDateOnly(new Date(statements.dateRange.end * 1000))}`
    : "No confirmed entries";

  doc.fontSize(24).fillColor("#1B2F1F").text("Konfirmata Verified Report", 50, 60);
  doc.fontSize(13).fillColor("#6B7C6B").text("Server-Attested Business Activity Ledger", 50, 96);

  let infoY = 150;
  const coverRows = [
    ["Business", businessName || "Not provided"],
    ["Phone", phoneNumber],
    ["Email", email || "Not provided"],
    ["Tier", tier ? tier[0].toUpperCase() + tier.slice(1) : "Unknown"],
    ["Report date range", `${formatDateOnly(attestation.window_start)} to ${formatDateOnly(attestation.window_end)}`],
    ["Generated", formatDateTime(attestation.issued_at)],
    ["Device fingerprint", attestation.device_fingerprint],
    ["Entry count", String(attestation.entry_count)],
    ["Verification ticket", attestation.vt_id],
    ["Amount paid", formatMoney(amountKobo, "NGN")],
    ["Window days", windowDays === 0 ? "Full history" : String(windowDays)]
  ];

  coverRows.forEach(([label, value]) => {
    doc.fontSize(10).fillColor("#6B7C6B").text(label.toUpperCase(), 50, infoY);
    doc.fontSize(12).fillColor("#0F1A10").text(String(value), 50, infoY + 14, { width: 260 });
    infoY += 42;
  });

  drawStatusBadge(doc, 50, infoY + 8, "VALID");

  doc.image(qrBuffer, 380, 150, { width: 120 });
  doc.fontSize(10).fillColor("#6B7C6B").text("Verification URL", 380, 284);
  doc.fontSize(10).fillColor("#1B2F1F").text(attestation.verify_url, 380, 300, {
    width: 140
  });

  drawPatentFooter(doc);

  doc.addPage();
  doc.font("Helvetica-Bold").fontSize(18).fillColor("#1B2F1F").text("Income Statement", 50, 50);
  doc.font("Helvetica").fontSize(10).fillColor("#6B7C6B").text(`Period: ${periodLabel}`, 50, 74);
  doc.moveTo(50, 94).lineTo(545, 94).strokeColor("#D4CDB8").stroke();

  let statementY = 116;
  drawStatementRow(doc, statementY, "Revenue (Sales)", fmt(statements.incomeStatement.grossRevenue, reportCurrency));
  statementY += 24;
  drawStatementRow(doc, statementY, "Other Receipts", fmt(statements.incomeStatement.otherIncome, reportCurrency));
  statementY += 22;
  doc.moveTo(50, statementY).lineTo(545, statementY).strokeColor("#D4CDB8").stroke();
  statementY += 12;
  drawStatementRow(doc, statementY, "Total Inflows", fmt(totalInflows, reportCurrency), { bold: true });
  statementY += 34;
  drawStatementRow(doc, statementY, "Cost of Goods / Purchases", fmt(statements.incomeStatement.costOfGoods, reportCurrency));
  statementY += 24;
  drawStatementRow(doc, statementY, "Operating Expenses", fmt(statements.incomeStatement.operatingExpenses, reportCurrency));
  statementY += 22;
  doc.moveTo(50, statementY).lineTo(545, statementY).strokeColor("#D4CDB8").stroke();
  statementY += 12;
  drawStatementRow(doc, statementY, "Total Outflows", fmt(totalOutflows, reportCurrency), { bold: true });
  statementY += 34;
  drawStatementRow(doc, statementY, "NET INCOME", fmt(statements.incomeStatement.netIncome, reportCurrency), { emphasized: true });
  drawPatentFooter(doc);

  doc.addPage();
  doc.font("Helvetica-Bold").fontSize(18).fillColor("#1B2F1F").text("Monthly Cash Flow", 50, 50);
  doc.font("Helvetica").fontSize(10).fillColor("#6B7C6B").text(`Period: ${periodLabel}`, 50, 74);
  doc
    .font("Helvetica-Bold")
    .fontSize(10)
    .fillColor("#6B7C6B")
    .text("Month", 50, 104)
    .text("Inflows", 180, 104, { width: 110, align: "right" })
    .text("Outflows", 305, 104, { width: 110, align: "right" })
    .text("Net Cash", 435, 104, { width: 110, align: "right" });
  doc.moveTo(50, 120).lineTo(545, 120).strokeColor("#D4CDB8").stroke();

  let cashFlowY = 136;
  doc.font("Helvetica").fontSize(10).fillColor("#0F1A10");
  statements.cashFlowByMonth.forEach((row) => {
    doc
      .text(row.month, 50, cashFlowY, { width: 90 })
      .text(fmt(row.inflows, reportCurrency), 180, cashFlowY, { width: 110, align: "right" })
      .text(fmt(row.outflows, reportCurrency), 305, cashFlowY, { width: 110, align: "right" })
      .text(fmt(row.net, reportCurrency), 435, cashFlowY, { width: 110, align: "right" });
    cashFlowY += 20;
  });

  doc.moveTo(50, cashFlowY).lineTo(545, cashFlowY).strokeColor("#D4CDB8").stroke();
  cashFlowY += 12;
  doc
    .font("Helvetica-Bold")
    .fontSize(10)
    .fillColor("#0F1A10")
    .text("TOTAL", 50, cashFlowY, { width: 90 })
    .text(fmt(cashFlowTotals.inflows, reportCurrency), 180, cashFlowY, { width: 110, align: "right" })
    .text(fmt(cashFlowTotals.outflows, reportCurrency), 305, cashFlowY, { width: 110, align: "right" })
    .text(fmt(cashFlowTotals.net, reportCurrency), 435, cashFlowY, { width: 110, align: "right" });
  drawPatentFooter(doc);

  doc.addPage();
  doc.font("Helvetica-Bold").fontSize(18).fillColor("#1B2F1F").text("Appendix: Full Transaction Ledger", 50, 50);
  doc.font("Helvetica").fontSize(10).fillColor("#6B7C6B").text("Oldest to newest confirmed entries", 50, 74);

  let y = 100;
  let runningTotal = 0;
  let entryPageNumber = 1;

  drawEntryTableHeader(doc, y);
  y += 26;

  entries.forEach((entry, index) => {
    const payload = entry.payload || {};
    const amountMinor = Number(payload.amount_minor || 0);
    runningTotal += amountMinor;

    if (y > doc.page.height - 90) {
      drawEntryPageFooter(doc, runningTotal, reportCurrency);
      doc.addPage();
      entryPageNumber += 1;
      doc.font("Helvetica-Bold").fontSize(18).fillColor("#1B2F1F").text("Appendix: Full Transaction Ledger", 50, 50);
      doc.font("Helvetica").fontSize(10).fillColor("#6B7C6B").text(`Continued - page ${entryPageNumber}`, 50, 74);
      y = 100;
      drawEntryTableHeader(doc, y);
      y += 26;
    }

    doc
      .fontSize(9)
      .fillColor("#0F1A10")
      .text(String(payload.id || entry.entry_id || index + 1), 50, y, { width: 36 })
      .text(truncateText(payload.transaction_type || "", 11), 92, y, { width: 62 })
      .text(truncateText(payload.label || payload.normalized_label || "", 30), 160, y, { width: 155 })
      .text(formatMoney(amountMinor, payload.currency || reportCurrency), 325, y, { width: 74 })
      .text(formatDateTime(entry.confirmed_at), 408, y, { width: 84 })
      .text(payload.signature ? "Yes" : "No", 500, y, { width: 45 });

    y += 18;
  });

  drawEntryPageFooter(doc, runningTotal, reportCurrency);

  doc.addPage();
  doc.fontSize(20).fillColor("#1B2F1F").text("Integrity Footer", 50, 60);
  doc.fontSize(11).fillColor("#6B7C6B").text("Attestation and verification details", 50, 92);

  const footerRows = [
    ["Ledger Root Hash", attestation.ledger_root_hash],
    ["Server Signature", attestation.server_signature],
    ["Attestation Timestamp", formatDateTime(attestation.issued_at)],
    ["Device Fingerprint", attestation.device_fingerprint],
    ["Key Rotation Events", String(keyRotationEvents)],
    ["Verification Ticket", attestation.vt_id],
    ["Verification URL", attestation.verify_url]
  ];

  let footerY = 140;
  footerRows.forEach(([label, value]) => {
    doc.fontSize(10).fillColor("#6B7C6B").text(label.toUpperCase(), 50, footerY);
    doc.fontSize(11).fillColor("#0F1A10").text(String(value), 50, footerY + 14, {
      width: 495
    });
    footerY += 46;
  });

  doc.fontSize(10).fillColor("#0F1A10").text(PATENT_NOTICE, 50, footerY + 18, {
    width: 495,
    lineGap: 4
  });

  doc.end();

  return pdfReady;
}

async function sendVerifiedReportEmail({ email, filename, pdfBuffer, vtId, verifyUrl }) {
  if (!email || !process.env.RESEND_API_KEY) return;

  const resend = await getResendClient(process.env.RESEND_API_KEY);
  if (!resend) return;
  await resend.emails.send({
    from: "Konfirmata <reports@konfirmata.com>",
    to: email,
    subject: "Your Konfirmata Verified Report",
    html: `
      <p>Your Verified Report is attached.</p>
      <p>Verification ID: ${vtId}</p>
      <p>Verify online: <a href="${verifyUrl}">${verifyUrl}</a></p>
      <p>— Konfirmata</p>
    `,
    attachments: [
      {
        filename,
        content: pdfBuffer
      }
    ]
  });
}

export async function registerPaymentRoutes(app) {
  app.addHook("preParsing", async (request, reply, payload) => {
    const isWebhookRequest = request.method === "POST" && String(request.url || "").split("?")[0] === "/payment/webhook";
    if (!isWebhookRequest) {
      return payload;
    }

    const chunks = [];
    for await (const chunk of payload) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks);
    request.rawBody = raw;
    return Readable.from(raw);
  });

  app.post("/payment/webhook", async (request, reply) => {
    if (!process.env.PAYSTACK_SECRET_KEY) {
      return reply.code(500).send({ error: "PAYSTACK_SECRET_KEY is not configured." });
    }

    const providedSignature = String(request.headers["x-paystack-signature"] || "").trim();
    const expectedSignature = crypto
      .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY)
      .update(request.rawBody || Buffer.from(""))
      .digest("hex");

    if (!providedSignature || !safeCompareHex(expectedSignature, providedSignature)) {
      return reply.code(401).send({ error: "Invalid Paystack signature." });
    }

    try {
      const event = request.body || JSON.parse(String(request.rawBody || ""));
      if (event?.event === "charge.success") {
        const metadataFields = getMetadataFields(event.data?.metadata);
        const phoneNumber = String(metadataFields.phone || "").trim();
        const deviceIdentity = String(metadataFields.device_identity || "").trim();
        const tier = String(metadataFields.tier || "unknown").trim();
        const windowDays = parseWindowDays(metadataFields.window_days, 30);

        if (phoneNumber && deviceIdentity && event.data?.reference) {
          await upsertPaymentRecord({
            phone_number: phoneNumber,
            device_identity: deviceIdentity,
            reference: String(event.data.reference),
            amount_kobo: Number(event.data.amount || 0),
            tier,
            window_days: windowDays,
            paystack_status: String(event.data.status || "success"),
            vt_id: null,
            completed_at: event.data?.paid_at || new Date().toISOString()
          });
        }
      }
    } catch (error) {
      request.log.error({ err: error }, "Payment webhook processing failed after signature verification.");
    }

    return reply.code(200).send({ ok: true });
  });

  app.post("/payment/generate-pdf", async (request, reply) => {
    const auth = await authenticateRequest(request, reply);
    if (!auth) return reply;

    const reference = String(request.body?.reference || "").trim();
    const requestedWindowDays = parseWindowDays(request.body?.window_days, 90);

    if (!reference) {
      return reply.code(400).send({ error: "reference is required." });
    }

    if (!process.env.PAYSTACK_SECRET_KEY) {
      return reply.code(500).send({ error: "PAYSTACK_SECRET_KEY is not configured." });
    }

    let verification;
    try {
      verification = await fetch(
        `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
        {
          headers: {
            Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`
          }
        }
      );
    } catch (error) {
      return reply.code(502).send({ error: "Unable to verify payment right now." });
    }

    const result = await verification.json().catch(() => ({}));
    if (!result.data || result.data.status !== "success") {
      return reply.code(402).send({ error: "Payment not confirmed" });
    }

    const metadataFields = getMetadataFields(result.data.metadata);
    const deviceIdentity = String(metadataFields.device_identity || "").trim();
    const tier = String(metadataFields.tier || "custom").trim();
    const effectiveWindowDays = parseWindowDays(
      metadataFields.window_days ?? requestedWindowDays,
      requestedWindowDays
    );

    if (!deviceIdentity) {
      return reply.code(400).send({ error: "device_identity is required in payment metadata." });
    }

    const device = await getDeviceRecord(deviceIdentity);
    if (!device || device.phone_number !== auth.phone_number) {
      return reply.code(403).send({ error: "Device does not belong to this account." });
    }

    if (device.status !== "ACTIVE") {
      return reply.code(403).send({ error: "Device is not active." });
    }

    if (device.revoked_at) {
      return reply.code(403).send({ error: "Device has been revoked." });
    }

    const attestation = await createAttestation(auth.phone_number, deviceIdentity, effectiveWindowDays);
    const keyRotationEvents = await getKeyRotationCount(deviceIdentity);
    const email = String(
      result.data.customer?.email
      || metadataFields.email
      || ""
    ).trim();
    const businessName = String(
      metadataFields.display_name
      || metadataFields.business_name
      || result.data.customer?.first_name
      || ""
    ).trim();
    const filename = `confirma-verified-report-${new Date().toISOString().slice(0, 10)}.pdf`;

    const pdfBuffer = await buildVerifiedReportPdf({
      attestation,
      businessName,
      phoneNumber: auth.phone_number,
      email,
      tier,
      windowDays: effectiveWindowDays,
      amountKobo: Number(result.data.amount || 0),
      keyRotationEvents
    });

    await upsertPaymentRecord({
      phone_number: auth.phone_number,
      device_identity: deviceIdentity,
      reference,
      amount_kobo: Number(result.data.amount || 0),
      tier,
      window_days: effectiveWindowDays,
      paystack_status: String(result.data.status || "success"),
      vt_id: attestation.vt_id,
      completed_at: result.data.paid_at || new Date().toISOString()
    });

    sendVerifiedReportEmail({
      email,
      filename,
      pdfBuffer,
      vtId: attestation.vt_id,
      verifyUrl: attestation.verify_url
    }).catch((error) => {
      request.log.error({ err: error }, "Verified report email delivery failed.");
    });

    return {
      ok: true,
      pdf_base64: pdfBuffer.toString("base64"),
      filename,
      vt_id: attestation.vt_id
    };
  });
}
