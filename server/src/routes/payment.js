import crypto from "node:crypto";
import { authenticateRequest } from "../auth-utils.js";
import {
  ACCOUNT_DEVICES_ATTESTATION_SCOPE,
  ACCOUNT_DEVICES_ATTESTATION_SCOPE_DESCRIPTION,
  buildAttestationEnvelope
} from "../attestation-signing.js";
import { query, withTransaction } from "../db.js";
import { maskPhone, maskEmail } from "../utils/mask.js";

const VERIFY_BASE_URL = process.env.VERIFY_BASE_URL || "https://konfirmata.com";
const PATENT_NOTICE = "Protected under USPTO Provisional Application 63/987,858. Konfirmata Temporal Attestation System (TAS). Unauthorized reproduction of this attestation mechanism is prohibited.";
const VERIFIED_REPORT_TEMPLATE_VERSION = "2026-05-16-redesign";
let resendModulePromise = null;
let pdfkitModulePromise = null;
let qrCodeModulePromise = null;
let reportProfileColumnsReady = false;
let reportAttestationColumnsReady = false;

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
  return Math.min(365, Math.floor(parsed));
}

function formatMoney(amountMinor, currency = "NGN") {
  // Use ISO currency codes rather than glyphs: PDFKit's built-in Helvetica
  // cannot render the ₦ (Naira) sign, which previously produced garbage output.
  return fmt(amountMinor, currency);
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
  let borrowedIn = 0;
  let loanRepaid = 0;
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
    } else if (transactionType === "liability_in") {
      // Borrowing is recorded separately — never revenue/income/inflow.
      borrowedIn += amountMinor;
    } else if (transactionType === "liability_out") {
      // Loan repayment is recorded separately — never expense/outflow.
      loanRepaid += amountMinor;
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
    borrowing: {
      borrowedIn,
      loanRepaid
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

function getEntryCurrency(entry, fallbackCurrency = "NGN") {
  return String(entry?.payload?.currency || entry?.currency || fallbackCurrency || "NGN").toUpperCase();
}

function groupEntriesByCurrency(entries, fallbackCurrency = "NGN") {
  const grouped = new Map();
  entries.forEach((entry) => {
    const currency = getEntryCurrency(entry, fallbackCurrency);
    if (!grouped.has(currency)) grouped.set(currency, []);
    grouped.get(currency).push(entry);
  });
  return [...grouped.entries()].sort(([currencyA], [currencyB]) => currencyA.localeCompare(currencyB));
}

function formatLedgerEntryRef(entry, payload, index) {
  const devicePrefix = getEntryDeviceFingerprint(entry).slice(0, 4) || "unk";
  const entryId = payload?.id || entry?.entry_id || index + 1;
  return `${devicePrefix}-${entryId}`;
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

async function ensureReportAttestationColumns(db = null) {
  const runner = db || { query };
  if (!db && reportAttestationColumnsReady) return;
  await runner.query(`ALTER TABLE attestations ADD COLUMN IF NOT EXISTS attestation_scope TEXT`);
  await runner.query(`ALTER TABLE attestations ADD COLUMN IF NOT EXISTS scope_description TEXT`);
  if (!db) reportAttestationColumnsReady = true;
}

function getEntryDeviceFingerprint(entry) {
  return String(entry?.device_identity || "").slice(0, 8) || "unknown";
}

function computeAccountLedgerRootHash(entries) {
  const digest = crypto.createHash("sha256");
  for (const entry of entries) {
    digest.update([
      String(entry.device_identity || ""),
      String(entry.entry_id || ""),
      String(entry.entry_hash || "")
    ].join(":"));
    digest.update("\n");
  }
  return `sha256:${digest.digest("hex")}`;
}

async function getLedgerEntries(phoneNumber, windowDays, db = null) {
  const runner = db || { query };
  if (windowDays === 0) {
    const result = await runner.query(
      `
        SELECT
          le.device_identity,
          le.entry_id,
          le.entry_hash,
          le.confirmed_at,
          le.evidence_level,
          le.public_key_fingerprint,
          le.payload
        FROM ledger_entries le
        INNER JOIN device_identities di
          ON di.device_identity = le.device_identity
        WHERE di.phone_number = $1
        ORDER BY le.confirmed_at ASC, le.device_identity ASC, le.entry_id ASC
      `,
      [phoneNumber]
    );
    return result.rows;
  }

  const result = await runner.query(
    `
      SELECT
        le.device_identity,
        le.entry_id,
        le.entry_hash,
        le.confirmed_at,
        le.evidence_level,
        le.public_key_fingerprint,
        le.payload
      FROM ledger_entries le
      INNER JOIN device_identities di
        ON di.device_identity = le.device_identity
      WHERE di.phone_number = $1
        AND le.confirmed_at >= NOW() - ($2 || ' days')::interval
      ORDER BY le.confirmed_at ASC, le.device_identity ASC, le.entry_id ASC
    `,
    [phoneNumber, String(windowDays)]
  );
  return result.rows;
}

async function createAttestation(phoneNumber, deviceIdentity, windowDays, db = null) {
  const runner = db || { query };
  await ensureReportAttestationColumns(runner);
  const entries = await getLedgerEntries(phoneNumber, windowDays, runner);

  if (!entries.length) {
    const error = new Error("No entries in this window.");
    error.statusCode = 400;
    throw error;
  }

  const entryCount = entries.length;
  const ledgerRootHash = computeAccountLedgerRootHash(entries);
  const windowStart = new Date(entries[0].confirmed_at);
  const windowEnd = new Date(entries[entryCount - 1].confirmed_at);
  const vtId = crypto.randomBytes(16).toString("hex");
  const issuedAt = new Date();
  const attestation = buildAttestationEnvelope({
    vt_id: vtId,
    device_identity: deviceIdentity,
    ledger_root_hash: ledgerRootHash,
    entry_count: entryCount,
    window_start: windowStart.toISOString(),
    window_end: windowEnd.toISOString(),
    issued_at: issuedAt.toISOString(),
    status: "VALID",
    attestation_scope: ACCOUNT_DEVICES_ATTESTATION_SCOPE,
    scope_description: ACCOUNT_DEVICES_ATTESTATION_SCOPE_DESCRIPTION
  });

  await runner.query(
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
        issued_at,
        attestation_scope,
        scope_description
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'VALID', $9, $10, $11)
    `,
    [
      attestation.vt_id,
      deviceIdentity,
      phoneNumber,
      attestation.ledger_root_hash,
      attestation.window_start,
      attestation.window_end,
      attestation.entry_count,
      attestation.server_signature,
      attestation.issued_at,
      attestation.attestation_scope,
      attestation.scope_description
    ]
  );

  return {
    ...attestation,
    entries
  };
}

async function getKeyRotationCount(phoneNumber, db = null) {
  const runner = db || { query };
  const result = await runner.query(
    `
      SELECT COUNT(*)::int AS rotation_count
      FROM key_rotation_events
      WHERE old_device_identity IN (
        SELECT device_identity FROM device_identities WHERE phone_number = $1
      )
      OR new_device_identity IN (
        SELECT device_identity FROM device_identities WHERE phone_number = $1
      )
    `,
    [phoneNumber]
  );
  return result.rows[0]?.rotation_count || 0;
}

async function ensureReportProfileColumns() {
  if (reportProfileColumnsReady) return;

  await query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS phone_number TEXT`);
  await query(
    `
      UPDATE profiles p
      SET phone_number = u.phone_number
      FROM users u
      WHERE p.user_id = u.id
        AND (p.phone_number IS NULL OR p.phone_number <> u.phone_number)
    `
  );

  reportProfileColumnsReady = true;
}

async function ensureProfileRowForPhone(phoneNumber) {
  await ensureReportProfileColumns();
  await query(
    `
      INSERT INTO profiles (
        user_id,
        phone_number,
        updated_at
      )
      SELECT
        u.id,
        u.phone_number,
        NOW()
      FROM users u
      WHERE u.phone_number = $1
      ON CONFLICT (user_id)
      DO UPDATE SET
        phone_number = EXCLUDED.phone_number
    `,
    [phoneNumber]
  );
}

async function getFreeReportContext(phoneNumber) {
  await ensureProfileRowForPhone(phoneNumber);
  const result = await query(
    `
      SELECT
        u.email,
        COALESCE(p.business_name, p.name, '') AS business_name,
        (
          SELECT MIN(di.created_at)
          FROM device_identities di
          WHERE di.phone_number = u.phone_number
        ) AS first_device_created_at
      FROM users u
      LEFT JOIN profiles p
        ON p.user_id = u.id
      WHERE u.phone_number = $1
      LIMIT 1
    `,
    [phoneNumber]
  );
  return result.rows[0] || null;
}

const REPORT = {
  ink: "#0F1A10",
  dark: "#0D1F17",
  green: "#2D6A4F",
  accent: "#52B788",
  muted: "#6B7C6B",
  faint: "#9DB4A6",
  line: "#D8E1DA",
  soft: "#EAF1EC",
  panel: "#F4F7F5",
  white: "#FFFFFF"
};
const REPORT_LEFT = 50;
const REPORT_RIGHT = 545;
const REPORT_WIDTH = REPORT_RIGHT - REPORT_LEFT;
const REPORT_BAND_H = 64;
const REPORT_BOTTOM = 778;

function drawReportBand(doc, pageLabel) {
  doc.save();
  doc.rect(0, 0, doc.page.width, REPORT_BAND_H).fill(REPORT.dark);
  doc.roundedRect(REPORT_LEFT, 18, 28, 28, 6).fill(REPORT.accent);
  doc.fillColor(REPORT.dark).font("Helvetica-Bold").fontSize(15)
    .text("K", REPORT_LEFT, 24.5, { width: 28, align: "center" });
  doc.fillColor(REPORT.white).font("Helvetica-Bold").fontSize(13)
    .text("KONFIRMATA", REPORT_LEFT + 38, 21, { characterSpacing: 0.5 });
  doc.fillColor(REPORT.faint).font("Helvetica").fontSize(8)
    .text("Server-Attested Business Activity Ledger", REPORT_LEFT + 38, 38);
  doc.fillColor(REPORT.faint).font("Helvetica-Bold").fontSize(8.5)
    .text(String(pageLabel || "").toUpperCase(), REPORT_RIGHT - 220, 30, {
      width: 220, align: "right", characterSpacing: 1
    });
  doc.restore();
}

function drawReportStatusBadge(doc, x, y, status) {
  const ok = String(status || "VALID").toUpperCase() === "VALID";
  const palette = ok
    ? { bg: "#E8F5EC", border: "#52B788", fg: "#1B4332" }
    : { bg: "#FBEDED", border: "#D98C8C", fg: "#7A2E2E" };
  const w = 96;
  const h = 30;
  doc.save();
  doc.roundedRect(x, y, w, h, 15).fillAndStroke(palette.bg, palette.border);
  doc.fillColor(palette.fg).font("Helvetica-Bold").fontSize(11)
    .text(String(status || "VALID").toUpperCase(), x, y + 9.5, {
      width: w, align: "center", characterSpacing: 1
    });
  doc.restore();
}

function drawReportSectionTitle(doc, y, kicker, title, sub) {
  doc.fillColor(REPORT.green).font("Helvetica-Bold").fontSize(8.5)
    .text(String(kicker).toUpperCase(), REPORT_LEFT, y, { characterSpacing: 1 });
  doc.fillColor(REPORT.ink).font("Helvetica-Bold").fontSize(18)
    .text(String(title), REPORT_LEFT, y + 13);
  let endY = y + 38;
  if (sub) {
    doc.fillColor(REPORT.muted).font("Helvetica").fontSize(9.5)
      .text(String(sub), REPORT_LEFT, endY);
    endY += 16;
  }
  doc.moveTo(REPORT_LEFT, endY).lineTo(REPORT_RIGHT, endY)
    .strokeColor(REPORT.line).lineWidth(1).stroke();
  return endY + 18;
}

function drawReportDetailRow(doc, x, y, width, label, value) {
  doc.font("Helvetica-Bold").fontSize(7.5).fillColor(REPORT.muted)
    .text(String(label).toUpperCase(), x, y, { width, characterSpacing: 0.5 });
  doc.font("Helvetica").fontSize(10.5).fillColor(REPORT.ink)
    .text(String(value == null || value === "" ? "—" : value), x, y + 11, { width });
}

function drawReportStatementRow(doc, y, label, value, opts = {}) {
  const { strong = false, total = false } = opts;
  if (total) {
    doc.save();
    doc.rect(REPORT_LEFT, y - 6, REPORT_WIDTH, 28).fill(REPORT.soft);
    doc.restore();
  }
  const font = strong || total ? "Helvetica-Bold" : "Helvetica";
  const size = total ? 12 : 10.5;
  const pad = total ? 12 : 0;
  const textY = total ? y + 1 : y;
  doc.font(font).fontSize(size).fillColor(REPORT.ink)
    .text(String(label), REPORT_LEFT + pad, textY, { width: 320 });
  doc.font(font).fontSize(size).fillColor(total ? REPORT.green : REPORT.ink)
    .text(String(value), REPORT_LEFT, textY, { width: REPORT_WIDTH - pad, align: "right" });
}

function drawReportTableHeader(doc, y, columns) {
  doc.save();
  doc.rect(REPORT_LEFT, y - 5, REPORT_WIDTH, 22).fill(REPORT.soft);
  doc.restore();
  doc.font("Helvetica-Bold").fontSize(8).fillColor(REPORT.green);
  columns.forEach((col) => {
    doc.text(col.label.toUpperCase(), col.x, y + 1, {
      width: col.width, align: col.align || "left", characterSpacing: 0.5
    });
  });
  return y + 22;
}

function drawReportIntegrityField(doc, y, label, value, mono) {
  const text = String(value == null ? "—" : value);
  doc.font("Helvetica-Bold").fontSize(7.5).fillColor(REPORT.muted)
    .text(String(label).toUpperCase(), REPORT_LEFT, y, { characterSpacing: 0.5 });
  const valueY = y + 12;
  if (mono) {
    doc.font("Courier").fontSize(8.5);
    const h = doc.heightOfString(text, { width: REPORT_WIDTH - 20, lineGap: 2 });
    doc.save();
    doc.roundedRect(REPORT_LEFT, valueY - 6, REPORT_WIDTH, h + 14, 4).fill(REPORT.panel);
    doc.restore();
    doc.font("Courier").fontSize(8.5).fillColor(REPORT.ink)
      .text(text, REPORT_LEFT + 10, valueY, { width: REPORT_WIDTH - 20, lineGap: 2 });
    return valueY + h + 14 + 12;
  }
  doc.font("Helvetica").fontSize(10).fillColor(REPORT.ink);
  const h = doc.heightOfString(text, { width: REPORT_WIDTH });
  doc.text(text, REPORT_LEFT, valueY, { width: REPORT_WIDTH });
  return valueY + h + 14;
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
  const doc = new PDFDocument({ size: "A4", margin: 50, bufferPages: true });
  doc.info.Title = "Konfirmata Verified Report";
  doc.info.Subject = `Verified report template ${VERIFIED_REPORT_TEMPLATE_VERSION}`;
  const chunks = [];

  const pdfReady = new Promise((resolve, reject) => {
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const qrBuffer = await QRCode.toBuffer(attestation.verify_url, { width: 240, margin: 1 });
  const entries = attestation.entries;
  const reportCurrency = entries[0]?.payload?.currency || "NGN";
  const overallStatements = computeFinancialStatements(entries, reportCurrency);
  const currencyGroups = groupEntriesByCurrency(entries, reportCurrency);
  const mixedCurrency = currencyGroups.length > 1;
  const statementsByCurrency = currencyGroups.map(([currency, currencyEntries]) => ({
    currency,
    statements: computeFinancialStatements(currencyEntries, currency)
  }));
  const statements = statementsByCurrency[0]?.statements || overallStatements;
  const evidenceCounts = { self_reported: 0, device_signed: 0, server_attested: 0, corroborated: 0 };
  entries.forEach((entry) => {
    const level = entry.evidence_level || "self_reported";
    if (evidenceCounts[level] !== undefined) evidenceCounts[level] += 1;
  });
  const totalEvidenceEntries = entries.length;
  const attestedEntries = evidenceCounts.server_attested + evidenceCounts.corroborated;
  const attestedPercent = totalEvidenceEntries ? Math.round((attestedEntries / totalEvidenceEntries) * 100) : 0;
  const totalInflows = statements.incomeStatement.grossRevenue + statements.incomeStatement.otherIncome;
  const totalOutflows = statements.incomeStatement.costOfGoods + statements.incomeStatement.operatingExpenses;
  const cashFlowTotals = statements.cashFlowByMonth.reduce((totals, month) => {
    totals.inflows += month.inflows;
    totals.outflows += month.outflows;
    totals.net += month.net;
    return totals;
  }, { inflows: 0, outflows: 0, net: 0 });
  const periodLabel = overallStatements.dateRange.start && overallStatements.dateRange.end
    ? `${formatDateOnly(new Date(overallStatements.dateRange.start * 1000))} to ${formatDateOnly(new Date(overallStatements.dateRange.end * 1000))}`
    : "No confirmed entries";

  // ---------- PAGE 1 — COVER ----------
  drawReportBand(doc, "Verified Report");

  doc.fillColor(REPORT.green).font("Helvetica-Bold").fontSize(8.5)
    .text("PUBLIC INTEGRITY RECORD", REPORT_LEFT, 88, { characterSpacing: 1 });
  doc.fillColor(REPORT.ink).font("Helvetica-Bold").fontSize(22)
    .text("Verified Report", REPORT_LEFT, 101);
  drawReportStatusBadge(doc, REPORT_RIGHT - 96, 94, attestation.status || "VALID");

  doc.moveTo(REPORT_LEFT, 138).lineTo(REPORT_RIGHT, 138)
    .strokeColor(REPORT.line).lineWidth(1).stroke();

  doc.fillColor(REPORT.green).font("Helvetica-Bold").fontSize(8.5)
    .text("REPORT DETAILS", REPORT_LEFT, 156, { characterSpacing: 1 });

  const detailRows = [
    ["Business", businessName || "Not provided"],
    ["Phone", maskPhone(phoneNumber)],
    ["Email", email ? maskEmail(email) : "Not provided"],
    ["Tier", tier ? tier[0].toUpperCase() + tier.slice(1) : "Unknown"],
    ["Report date range", `${formatDateOnly(attestation.window_start)} to ${formatDateOnly(attestation.window_end)}`],
    ["Generated", formatDateTime(attestation.issued_at)],
    ["Report device", attestation.device_fingerprint],
    ["Scope", "Account devices"],
    ["Entry count", String(attestation.entry_count)],
    ["Verification ticket", attestation.vt_id],
    ["Report fee", amountKobo ? formatMoney(amountKobo, "NGN") : "Free"],
    ["Active since", overallStatements.dateRange.start ? formatDateOnly(new Date(overallStatements.dateRange.start * 1000)) : "No confirmed entries"]
  ];
  let detailY = 178;
  detailRows.forEach(([label, value]) => {
    drawReportDetailRow(doc, REPORT_LEFT, detailY, 270, label, value);
    detailY += 30;
  });

  const cardX = 350;
  const cardW = 195;
  doc.save();
  doc.roundedRect(cardX, 156, cardW, 212, 8).lineWidth(1).fillAndStroke(REPORT.white, REPORT.line);
  doc.restore();
  doc.image(qrBuffer, cardX + (cardW - 132) / 2, 172, { width: 132 });
  doc.fillColor(REPORT.muted).font("Helvetica-Bold").fontSize(7.5)
    .text("SCAN TO VERIFY ONLINE", cardX, 314, { width: cardW, align: "center", characterSpacing: 1 });
  doc.fillColor(REPORT.green).font("Helvetica").fontSize(7.5)
    .text(attestation.verify_url, cardX + 12, 330, { width: cardW - 24, align: "center", lineGap: 1 });

  const evY = 380;
  doc.save();
  doc.roundedRect(cardX, evY, cardW, 204, 8).fill(REPORT.soft);
  doc.restore();
  doc.fillColor(REPORT.green).font("Helvetica-Bold").fontSize(8.5)
    .text("EVIDENCE SUMMARY", cardX + 14, evY + 14, { characterSpacing: 1 });
  const evidenceLines = [
    ["Total entries", String(totalEvidenceEntries)],
    ["Server-attested", String(evidenceCounts.server_attested)],
    ["Device-signed", String(evidenceCounts.device_signed)],
    ["Self-reported", String(evidenceCounts.self_reported)]
  ];
  let evLineY = evY + 34;
  evidenceLines.forEach(([label, value]) => {
    doc.font("Helvetica").fontSize(9).fillColor(REPORT.muted)
      .text(label, cardX + 14, evLineY, { width: cardW - 28 });
    doc.font("Helvetica-Bold").fontSize(9).fillColor(REPORT.ink)
      .text(value, cardX + 14, evLineY, { width: cardW - 28, align: "right" });
    evLineY += 16;
  });
  doc.font("Helvetica").fontSize(8).fillColor(REPORT.muted)
    .text(`${attestedEntries} of ${totalEvidenceEntries} entries (${attestedPercent}%) carry server attestation.`,
      cardX + 14, evLineY + 4, { width: cardW - 28, lineGap: 1 });

  const evLegendY = evY + 132;
  doc.moveTo(cardX + 14, evLegendY).lineTo(cardX + cardW - 14, evLegendY)
    .strokeColor(REPORT.line).lineWidth(0.5).stroke();
  doc.fillColor(REPORT.green).font("Helvetica-Bold").fontSize(7)
    .text("EVIDENCE LEVELS", cardX + 14, evLegendY + 8, { characterSpacing: 0.8 });
  const evidenceTiers = [
    ["Server-attested", "Verified by Konfirmata server"],
    ["Device-signed", "Signed on device, pending sync"],
    ["Self-reported", "Before phone verification"]
  ];
  let evTierY = evLegendY + 22;
  evidenceTiers.forEach(([tier, desc]) => {
    doc.font("Helvetica-Bold").fontSize(7).fillColor(REPORT.ink)
      .text(tier, cardX + 14, evTierY, { width: cardW - 28 });
    doc.font("Helvetica").fontSize(7).fillColor(REPORT.muted)
      .text(desc, cardX + 14, evTierY + 9, { width: cardW - 28 });
    evTierY += 22;
  });

  const scopeY = 600;
  doc.save();
  doc.roundedRect(REPORT_LEFT, scopeY, REPORT_WIDTH, 128, 6).fill(REPORT.panel);
  doc.restore();
  doc.fillColor(REPORT.green).font("Helvetica-Bold").fontSize(8)
    .text("ABOUT THIS REPORT", REPORT_LEFT + 14, scopeY + 12, { characterSpacing: 0.8 });

  const colW = Math.floor((REPORT_WIDTH - 28) / 2) - 6;
  const col2X = REPORT_LEFT + 14 + colW + 12;
  doc.fillColor(REPORT.ink).font("Helvetica-Bold").fontSize(7.5)
    .text("What Konfirmata confirms:", REPORT_LEFT + 14, scopeY + 28);
  doc.fillColor(REPORT.muted).font("Helvetica").fontSize(7.5)
    .text(
      "· Record integrity (hash chain)\n· Entry sequence\n· Device origin\n· User confirmation at time of entry",
      REPORT_LEFT + 14, scopeY + 40, { width: colW, lineGap: 2 }
    );

  doc.fillColor(REPORT.ink).font("Helvetica-Bold").fontSize(7.5)
    .text("What Konfirmata does not confirm:", col2X, scopeY + 28);
  doc.fillColor(REPORT.muted).font("Helvetica").fontSize(7.5)
    .text(
      "· Whether the underlying transaction occurred\n· Whether the amounts are true\n· Financial statements or accounting records\n· Lending, underwriting, or institutional decisions",
      col2X, scopeY + 40, { width: colW, lineGap: 2 }
    );

  doc.fillColor(REPORT.muted).font("Helvetica").fontSize(7.5)
    .text(
      "Konfirmata produces user-confirmed, tamper-evident business activity records whose integrity, sequence, and device origin can be checked. Konfirmata does not independently verify that an underlying transaction occurred, does not produce financial statements, and does not make lending, underwriting, credit, tax, eligibility, or institutional decisions.",
      REPORT_LEFT + 14, scopeY + 92, { width: REPORT_WIDTH - 28, lineGap: 1.5 }
    );

  // ---------- PAGE 2 — ACTIVITY SUMMARY ----------
  doc.addPage();
  drawReportBand(doc, "Activity Summary");
  let y = drawReportSectionTitle(doc, 88, "Section 1", "Inflow / Outflow Summary", `Period: ${periodLabel}`);

  if (mixedCurrency) {
    doc.font("Helvetica").fontSize(9.5).fillColor(REPORT.muted)
      .text("Mixed currencies detected. Amounts are shown per currency and are not converted or combined.",
        REPORT_LEFT, y, { width: REPORT_WIDTH });
    y += 26;
    const summaryColumns = [
      { label: "Currency", x: REPORT_LEFT, width: 70, align: "left" },
      { label: "Inflows", x: 166, width: 110, align: "right" },
      { label: "Outflows", x: 292, width: 110, align: "right" },
      { label: "Net Activity", x: 418, width: 127, align: "right" }
    ];
    y = drawReportTableHeader(doc, y, summaryColumns) + 6;
    statementsByCurrency.forEach(({ currency, statements: currencyStatements }, index) => {
      const currencyInflows = currencyStatements.incomeStatement.grossRevenue + currencyStatements.incomeStatement.otherIncome;
      const currencyOutflows = currencyStatements.incomeStatement.costOfGoods + currencyStatements.incomeStatement.operatingExpenses;
      if (index % 2 === 1) {
        doc.save();
        doc.rect(REPORT_LEFT, y - 4, REPORT_WIDTH, 20).fill(REPORT.panel);
        doc.restore();
      }
      doc.font("Helvetica").fontSize(9.5).fillColor(REPORT.ink)
        .text(currency, summaryColumns[0].x, y, { width: summaryColumns[0].width })
        .text(fmt(currencyInflows, currency), summaryColumns[1].x, y, { width: summaryColumns[1].width, align: "right" })
        .text(fmt(currencyOutflows, currency), summaryColumns[2].x, y, { width: summaryColumns[2].width, align: "right" })
        .text(fmt(currencyInflows - currencyOutflows, currency), summaryColumns[3].x, y, { width: summaryColumns[3].width, align: "right" });
      y += 20;
    });
    y += 34;
  } else {
    drawReportStatementRow(doc, y, "Recorded Sales Inflows", fmt(statements.incomeStatement.grossRevenue, reportCurrency));
    y += 22;
    drawReportStatementRow(doc, y, "Other Recorded Inflows", fmt(statements.incomeStatement.otherIncome, reportCurrency));
    y += 20;
    doc.moveTo(REPORT_LEFT, y).lineTo(REPORT_RIGHT, y).strokeColor(REPORT.line).lineWidth(1).stroke();
    y += 12;
    drawReportStatementRow(doc, y, "Total Recorded Inflows", fmt(totalInflows, reportCurrency), { strong: true });
    y += 26;
    drawReportStatementRow(doc, y, "Recorded Purchase Outflows", fmt(statements.incomeStatement.costOfGoods, reportCurrency));
    y += 22;
    drawReportStatementRow(doc, y, "Recorded Operating Outflows", fmt(statements.incomeStatement.operatingExpenses, reportCurrency));
    y += 20;
    doc.moveTo(REPORT_LEFT, y).lineTo(REPORT_RIGHT, y).strokeColor(REPORT.line).lineWidth(1).stroke();
    y += 12;
    drawReportStatementRow(doc, y, "Total Recorded Outflows", fmt(totalOutflows, reportCurrency), { strong: true });
    y += 30;
    drawReportStatementRow(doc, y, "Net Recorded Activity", fmt(statements.incomeStatement.netIncome, reportCurrency), { total: true });
    y += 54;
  }

  const reportBorrowing = statements.borrowing || { borrowedIn: 0, loanRepaid: 0 };
  if (reportBorrowing.borrowedIn || reportBorrowing.loanRepaid) {
    y = drawReportSectionTitle(doc, y, "Section 1b", "Recorded Borrowing Activity", null);
    drawReportStatementRow(doc, y, "Money Borrowed (recorded)", fmt(reportBorrowing.borrowedIn, reportCurrency));
    y += 22;
    drawReportStatementRow(doc, y, "Loan Repayments (recorded)", fmt(reportBorrowing.loanRepaid, reportCurrency));
    y += 22;
    doc.font("Helvetica").fontSize(8).fillColor(REPORT.muted)
      .text("Borrowed funds are recorded money movements, not sales, receipts, revenue, income, or verified liabilities. Konfirmata does not independently verify that the underlying borrowing occurred. Records labelled \"Business Loan\" confirmed before the borrowing taxonomy was introduced may have been recorded as receipts.",
        REPORT_LEFT, y, { width: REPORT_WIDTH, lineGap: 1.5 });
    y += 50;
  }

  y = drawReportSectionTitle(doc, y, "Section 2", "Monthly Recorded Activity", null);
  const cashColumns = mixedCurrency
    ? [
      { label: "Month", x: REPORT_LEFT, width: 80, align: "left" },
      { label: "Currency", x: 138, width: 60, align: "left" },
      { label: "Inflows", x: 206, width: 95, align: "right" },
      { label: "Outflows", x: 314, width: 95, align: "right" },
      { label: "Net Recorded Activity", x: 422, width: 123, align: "right" }
    ]
    : [
      { label: "Month", x: REPORT_LEFT, width: 120, align: "left" },
      { label: "Inflows", x: 180, width: 110, align: "right" },
      { label: "Outflows", x: 300, width: 110, align: "right" },
      { label: "Net Recorded Activity", x: 420, width: 125, align: "right" }
    ];
  const cashRows = mixedCurrency
    ? statementsByCurrency.flatMap(({ currency, statements: currencyStatements }) =>
      currencyStatements.cashFlowByMonth.map((row) => ({ ...row, currency }))
    ).sort((rowA, rowB) => rowA.month.localeCompare(rowB.month) || rowA.currency.localeCompare(rowB.currency))
    : statements.cashFlowByMonth.map((row) => ({ ...row, currency: reportCurrency }));
  y = drawReportTableHeader(doc, y, cashColumns) + 6;
  if (cashRows.length === 0) {
    doc.font("Helvetica").fontSize(9.5).fillColor(REPORT.muted)
      .text("No confirmed cash flow in this period.", REPORT_LEFT, y);
    y += 20;
  } else {
    cashRows.forEach((row, index) => {
      if (index % 2 === 1) {
        doc.save();
        doc.rect(REPORT_LEFT, y - 4, REPORT_WIDTH, 20).fill(REPORT.panel);
        doc.restore();
      }
      doc.font("Helvetica").fontSize(9.5).fillColor(REPORT.ink);
      if (mixedCurrency) {
        doc.text(row.month, cashColumns[0].x, y, { width: cashColumns[0].width })
          .text(row.currency, cashColumns[1].x, y, { width: cashColumns[1].width })
          .text(fmt(row.inflows, row.currency), cashColumns[2].x, y, { width: cashColumns[2].width, align: "right" })
          .text(fmt(row.outflows, row.currency), cashColumns[3].x, y, { width: cashColumns[3].width, align: "right" })
          .text(fmt(row.net, row.currency), cashColumns[4].x, y, { width: cashColumns[4].width, align: "right" });
      } else {
        doc.text(row.month, cashColumns[0].x, y, { width: cashColumns[0].width })
          .text(fmt(row.inflows, reportCurrency), cashColumns[1].x, y, { width: cashColumns[1].width, align: "right" })
          .text(fmt(row.outflows, reportCurrency), cashColumns[2].x, y, { width: cashColumns[2].width, align: "right" })
          .text(fmt(row.net, reportCurrency), cashColumns[3].x, y, { width: cashColumns[3].width, align: "right" });
      }
      y += 20;
    });
  }
  doc.moveTo(REPORT_LEFT, y).lineTo(REPORT_RIGHT, y).strokeColor(REPORT.line).lineWidth(1).stroke();
  if (!mixedCurrency) {
    y += 8;
    doc.save();
    doc.rect(REPORT_LEFT, y - 4, REPORT_WIDTH, 24).fill(REPORT.soft);
    doc.restore();
    doc.font("Helvetica-Bold").fontSize(9.5).fillColor(REPORT.ink)
      .text("TOTAL", cashColumns[0].x + 6, y + 3, { width: cashColumns[0].width });
    doc.font("Helvetica-Bold").fontSize(9.5).fillColor(REPORT.green)
      .text(fmt(cashFlowTotals.inflows, reportCurrency), cashColumns[1].x, y + 3, { width: cashColumns[1].width, align: "right" })
      .text(fmt(cashFlowTotals.outflows, reportCurrency), cashColumns[2].x, y + 3, { width: cashColumns[2].width, align: "right" })
      .text(fmt(cashFlowTotals.net, reportCurrency), cashColumns[3].x, y + 3, { width: cashColumns[3].width, align: "right" });
  }

  // ---------- PAGE 3 — TRANSACTION LEDGER ----------
  doc.addPage();
  drawReportBand(doc, "Transaction Ledger");
  const ledgerColumns = [
    { label: "Ref", x: REPORT_LEFT, width: 46, align: "left" },
    { label: "Device", x: 100, width: 58, align: "left" },
    { label: "Type", x: 162, width: 54, align: "left" },
    { label: "Label", x: 220, width: 96, align: "left" },
    { label: "Amount", x: 318, width: 82, align: "right" },
    { label: "Date", x: 404, width: 86, align: "right" },
    { label: "Signed", x: 500, width: 45, align: "right" }
  ];
  let ly = drawReportSectionTitle(doc, 88, "Appendix", "Transaction Ledger", "All confirmed account entries, oldest to newest");

  doc.save();
  doc.roundedRect(REPORT_LEFT, ly, REPORT_WIDTH, 82, 6).fill(REPORT.panel);
  doc.restore();
  doc.fillColor(REPORT.green).font("Helvetica-Bold").fontSize(7.5)
    .text("TRANSACTION TYPE GUIDE", REPORT_LEFT + 14, ly + 10, { characterSpacing: 0.8 });
  const typeGuideLeft = [
    ["sale", "Revenue from goods or services sold"],
    ["purchase", "Goods or stock bought"],
    ["payment", "Expense or service payment"],
    ["receipt", "Money received, not a sale"]
  ];
  const typeGuideRight = [
    ["transfer_in / out", "Internal money movement (not income or expense)"],
    ["reversal", "Correction — reverses a prior entry (both retained)"],
    ["liability_in", "Recorded borrowing"],
    ["liability_out", "Recorded loan repayment"]
  ];
  const tgCol2X = REPORT_LEFT + 255;
  let tgY = ly + 24;
  typeGuideLeft.forEach(([code, desc]) => {
    doc.font("Helvetica-Bold").fontSize(7.5).fillColor(REPORT.ink)
      .text(code, REPORT_LEFT + 14, tgY, { width: 68 });
    doc.font("Helvetica").fontSize(7.5).fillColor(REPORT.muted)
      .text(desc, REPORT_LEFT + 86, tgY, { width: 155 });
    tgY += 13;
  });
  tgY = ly + 24;
  typeGuideRight.forEach(([code, desc]) => {
    doc.font("Helvetica-Bold").fontSize(7.5).fillColor(REPORT.ink)
      .text(code, tgCol2X, tgY, { width: 82 });
    doc.font("Helvetica").fontSize(7.5).fillColor(REPORT.muted)
      .text(desc, tgCol2X + 86, tgY, { width: 163 });
    tgY += 13;
  });
  ly += 90;

  ly = drawReportTableHeader(doc, ly, ledgerColumns) + 6;
  const ledgerTotalsByCurrency = new Map();

  entries.forEach((entry, index) => {
    if (ly > REPORT_BOTTOM - 40) {
      doc.addPage();
      drawReportBand(doc, "Transaction Ledger");
      ly = drawReportSectionTitle(doc, 88, "Appendix", "Transaction Ledger (continued)", null);
      ly = drawReportTableHeader(doc, ly, ledgerColumns) + 6;
    }
    const payload = entry.payload || {};
    const amountMinor = Number(payload.amount_minor || 0);
    const entryCurrency = getEntryCurrency(entry, reportCurrency);
    ledgerTotalsByCurrency.set(entryCurrency, (ledgerTotalsByCurrency.get(entryCurrency) || 0) + amountMinor);
    if (index % 2 === 1) {
      doc.save();
      doc.rect(REPORT_LEFT, ly - 4, REPORT_WIDTH, 20).fill(REPORT.panel);
      doc.restore();
    }
    doc.font("Helvetica").fontSize(8.5).fillColor(REPORT.ink)
      .text(formatLedgerEntryRef(entry, payload, index), ledgerColumns[0].x, ly, { width: ledgerColumns[0].width })
      .text(getEntryDeviceFingerprint(entry), ledgerColumns[1].x, ly, { width: ledgerColumns[1].width })
      .text(truncateText(payload.transaction_type || "", 10), ledgerColumns[2].x, ly, { width: ledgerColumns[2].width })
      .text(truncateText(payload.label || payload.normalized_label || "", 22), ledgerColumns[3].x, ly, { width: ledgerColumns[3].width })
      .text(formatMoney(amountMinor, entryCurrency), ledgerColumns[4].x, ly, { width: ledgerColumns[4].width, align: "right" })
      .text(formatDateOnly(entry.confirmed_at), ledgerColumns[5].x, ly, { width: ledgerColumns[5].width, align: "right" })
      .text(payload.signature ? "Yes" : "No", ledgerColumns[6].x, ly, { width: ledgerColumns[6].width, align: "right" });
    ly += 20;
  });

  const ledgerTotals = [...ledgerTotalsByCurrency.entries()].sort(([currencyA], [currencyB]) => currencyA.localeCompare(currencyB));
  if (ly > REPORT_BOTTOM - ((ledgerTotals.length + 1) * 22 + 20)) {
    doc.addPage();
    drawReportBand(doc, "Transaction Ledger");
    ly = drawReportSectionTitle(doc, 88, "Appendix", "Transaction Ledger totals", null);
  }
  doc.moveTo(REPORT_LEFT, ly).lineTo(REPORT_RIGHT, ly).strokeColor(REPORT.line).lineWidth(1).stroke();
  ly += 8;
  doc.save();
  doc.rect(REPORT_LEFT, ly - 4, REPORT_WIDTH, 24 + Math.max(0, ledgerTotals.length - 1) * 20).fill(REPORT.soft);
  doc.restore();
  doc.font("Helvetica-Bold").fontSize(9.5).fillColor(REPORT.ink)
    .text(ledgerTotals.length > 1 ? "TOTAL RECORDED AMOUNTS BY CURRENCY" : "TOTAL RECORDED AMOUNT",
      REPORT_LEFT + 6, ly + 3, { width: 260 });
  ledgerTotals.forEach(([currency, amountMinor], index) => {
    doc.font("Helvetica-Bold").fontSize(9.5).fillColor(REPORT.green)
      .text(formatMoney(amountMinor, currency), REPORT_LEFT, ly + 3 + (index * 20), {
        width: REPORT_WIDTH - 6,
        align: "right"
      });
  });

  // ---------- PAGE 4 — INTEGRITY & VERIFICATION ----------
  doc.addPage();
  drawReportBand(doc, "Integrity & Verification");
  let iy = drawReportSectionTitle(doc, 88, "Cryptographic Record", "Integrity & Verification",
    "Compare these values against the public verification page.");

  const integrityFields = [
    ["Ledger root hash", attestation.ledger_root_hash, true],
    ["Attestation payload (canonical JSON)", attestation.attestation_payload, true],
    ["Attestation signature (ECDSA P-256)", attestation.server_signature, true],
    ["Signature algorithm", attestation.signature_algorithm || "ECDSA_P256_SHA256_P1363", false],
    ["Verification key URL", attestation.verification_key_url || `${VERIFY_BASE_URL}/.well-known/verification-key.json`, false],
    ["Attestation timestamp", formatDateTime(attestation.issued_at), false],
    ["Attestation scope", attestation.scope_description || ACCOUNT_DEVICES_ATTESTATION_SCOPE_DESCRIPTION, false],
    ["Report device fingerprint", attestation.device_fingerprint, false],
    ["Key rotation events", String(keyRotationEvents), false],
    ["Verification ticket", attestation.vt_id, true],
    ["Verification URL", attestation.verify_url, false]
  ];

  integrityFields.forEach(([label, value, mono]) => {
    if (iy + (mono ? 74 : 36) > REPORT_BOTTOM) {
      doc.addPage();
      drawReportBand(doc, "Integrity & Verification");
      iy = drawReportSectionTitle(doc, 88, "Cryptographic Record", "Integrity & Verification (continued)", null);
    }
    iy = drawReportIntegrityField(doc, iy, label, value, mono);
  });

  if (iy + 56 > REPORT_BOTTOM) {
    doc.addPage();
    drawReportBand(doc, "Integrity & Verification");
    iy = 88;
  }
  doc.moveTo(REPORT_LEFT, iy + 2).lineTo(REPORT_RIGHT, iy + 2)
    .strokeColor(REPORT.line).lineWidth(1).stroke();
  doc.font("Helvetica").fontSize(7.5).fillColor(REPORT.muted)
    .text(PATENT_NOTICE, REPORT_LEFT, iy + 12, { width: REPORT_WIDTH, lineGap: 2 });

  // ---------- PAGE FOOTERS ----------
  const pageRange = doc.bufferedPageRange();
  for (let i = 0; i < pageRange.count; i += 1) {
    doc.switchToPage(pageRange.start + i);
    // Drawing in the bottom margin would otherwise make PDFKit append a blank page.
    doc.page.margins.bottom = 0;
    const fy = doc.page.height - 38;
    doc.save();
    doc.moveTo(REPORT_LEFT, fy).lineTo(REPORT_RIGHT, fy)
      .strokeColor(REPORT.line).lineWidth(1).stroke();
    doc.font("Helvetica").fontSize(7).fillColor(REPORT.muted)
      .text("Konfirmata Verified Report  ·  USPTO Provisional Application 63/987,858", REPORT_LEFT, fy + 8, {
        width: 380, lineBreak: false
      });
    doc.font("Helvetica-Bold").fontSize(7).fillColor(REPORT.muted)
      .text(`Page ${i + 1} of ${pageRange.count}`, REPORT_RIGHT - 120, fy + 8, {
        width: 120, align: "right", lineBreak: false
      });
    doc.restore();
  }

  doc.end();

  return pdfReady;
}

async function assertActiveDevice(phoneNumber, deviceIdentity) {
  const device = await getDeviceRecord(deviceIdentity);
  if (!device || device.phone_number !== phoneNumber) {
    const error = new Error("Device does not belong to this account.");
    error.statusCode = 403;
    throw error;
  }

  if (device.status !== "ACTIVE") {
    const error = new Error("Device is not active.");
    error.statusCode = 403;
    throw error;
  }

  if (device.revoked_at) {
    const error = new Error("Device has been revoked.");
    error.statusCode = 403;
    throw error;
  }

  return device;
}

async function generateVerifiedReport({
  phoneNumber,
  deviceIdentity,
  businessName,
  email,
  tier,
  windowDays,
  amountKobo,
  db = null
}) {
  const attestation = await createAttestation(phoneNumber, deviceIdentity, windowDays, db);
  const keyRotationEvents = await getKeyRotationCount(phoneNumber, db);
  const filename = `konfirmata-verified-report-${new Date().toISOString().slice(0, 10)}.pdf`;
  const pdfBuffer = await buildVerifiedReportPdf({
    attestation,
    businessName,
    phoneNumber,
    email,
    tier,
    windowDays,
    amountKobo,
    keyRotationEvents
  });

  return {
    attestation,
    filename,
    pdfBuffer
  };
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
  app.post("/report/generate-pdf", async (request, reply) => {
    const auth = await authenticateRequest(request, reply);
    if (!auth) return reply;

    const requestedWindowDays = parseWindowDays(request.body?.window_days, 0);
    const deviceIdentity = String(auth.device_identity || request.headers["x-device-identity"] || "").trim();
    if (!deviceIdentity) {
      return reply.code(400).send({ error: "device_identity is required." });
    }

    const freeReportContext = await getFreeReportContext(auth.phone_number);
    if (!freeReportContext) {
      return reply.code(404).send({ error: "User account not found." });
    }

    try {
      await assertActiveDevice(auth.phone_number, deviceIdentity);
    } catch (error) {
      return reply.code(error.statusCode || 500).send({ error: error.message });
    }

    let report;
    try {
      report = await withTransaction(async (client) => {
        return generateVerifiedReport({
          phoneNumber: auth.phone_number,
          deviceIdentity,
          businessName: String(freeReportContext.business_name || "").trim(),
          email: String(freeReportContext.email || "").trim(),
          tier: "free",
          windowDays: requestedWindowDays,
          amountKobo: 0,
          db: client
        });
      });
    } catch (error) {
      return reply.code(error.statusCode || 500).send({ error: error.message || "Unable to generate report." });
    }

    sendVerifiedReportEmail({
      email: String(freeReportContext.email || "").trim(),
      filename: report.filename,
      pdfBuffer: report.pdfBuffer,
      vtId: report.attestation.vt_id,
      verifyUrl: report.attestation.verify_url
    }).catch((error) => {
      request.log.error({ err: error }, "Verified report email delivery failed.");
    });

    return {
      ok: true,
      pdf_base64: report.pdfBuffer.toString("base64"),
      filename: report.filename,
      vt_id: report.attestation.vt_id
    };
  });
}
