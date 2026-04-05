#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

let csvParse = null;
try {
  csvParse = require("csv-parse/sync").parse;
} catch (error) {
  csvParse = null;
}

const VERSION = "1.0.0";
const GRADE_BAND_ORDER = ["Foundation", "P1", "P2", "P3"];
const GRADE_BAND_MAP = {
  foundation: "Foundation",
  p1: "P1",
  p2: "P2",
  p3: "P3",
};
const MODULE_COLUMNS = [
  "module_number",
  "grade_band",
  "title_en",
  "title_ha",
  "title_ajami",
  "text_explanation_ha",
  "audio_filename",
  "image_card_filename",
  "curriculum_ref",
  "status",
  "micro_pause_1_ms",
  "micro_pause_1_question_ha",
  "micro_pause_1_answer",
  "micro_pause_1_options",
  "micro_pause_2_ms",
  "micro_pause_2_question_ha",
  "micro_pause_2_answer",
  "micro_pause_2_options",
];
const QUIZ_COLUMNS = [
  "module_number",
  "question_number",
  "template_ha",
  "template_ajami",
  "answer_formula",
  "var_a_min",
  "var_a_max",
  "var_b_min",
  "var_b_max",
  "distractor_1",
  "distractor_2",
  "distractor_3",
];
const GLOSSARY_COLUMNS = [
  "term_ajami",
  "term_hausa",
  "term_english",
  "definition_ha",
  "category",
  "related_modules",
];
const EVALUATED_FORMULA_PATTERN = /^[\d\s+\-*/().]+$/;
const PUBLISHED_STATUS = new Set(["draft", "review", "published", "archived"]);

main();

function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const args = parseArgs(argv.slice(1));

  if (!command || args.help) {
    printUsage();
    return;
  }

  try {
    if (command === "ingest") {
      runIngest(args);
      return;
    }

    if (command === "validate") {
      runValidate(args);
      return;
    }

    if (command === "status") {
      runStatus(args);
      return;
    }

    fail(`Unknown command "${command}".`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function runIngest(args) {
  requireArgs(args, ["input", "quizzes", "glossary", "audio-dir", "output"]);
  const report = buildBundleReport({
    modulesPath: resolveExistingFile(args.input),
    quizzesPath: resolveExistingFile(args.quizzes),
    glossaryPath: resolveExistingFile(args.glossary),
    audioDir: resolveExistingDirectory(args["audio-dir"]),
    mode: "ingest",
  });

  const outputPath = path.resolve(process.cwd(), args.output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report.bundle, null, 2) + "\n", "utf8");

  printSummary(report, {
    title: "AJAMIX content ingest complete",
    outputPath,
  });
}

function runValidate(args) {
  requireArgs(args, ["input", "quizzes", "glossary"]);
  const report = buildBundleReport({
    modulesPath: resolveExistingFile(args.input),
    quizzesPath: resolveExistingFile(args.quizzes),
    glossaryPath: resolveExistingFile(args.glossary),
    audioDir: args["audio-dir"] ? resolveExistingDirectory(args["audio-dir"]) : null,
    mode: "validate",
  });

  printSummary(report, {
    title: "AJAMIX validation passed",
  });
}

function runStatus(args) {
  requireArgs(args, ["input"]);
  const inputPath = resolveExistingFile(args.input);
  const bundle = readJsonFile(inputPath);
  const summary = summarizeBundle(bundle);

  console.log("AJAMIX bundle status");
  console.log(`Path: ${inputPath}`);
  console.log(`Version: ${summary.version}`);
  console.log(`Generated At: ${summary.generatedAt}`);
  console.log(`Total Modules: ${summary.totalModules}`);
  console.log(`Total Quiz Questions: ${summary.totalQuizQuestions}`);
  console.log(`Total Glossary Terms: ${summary.totalGlossaryTerms}`);
  console.log("By Grade Band:");
  GRADE_BAND_ORDER.forEach((gradeBand) => {
    if (summary.byGradeBand[gradeBand]) {
      console.log(`  ${gradeBand}: ${summary.byGradeBand[gradeBand]}`);
    }
  });

  if (summary.warnings.length) {
    console.log("Warnings:");
    summary.warnings.forEach((warning) => {
      console.log(`  - ${warning}`);
    });
  } else {
    console.log("Warnings: none");
  }
}

function buildBundleReport(options) {
  const warnings = [];
  if (!csvParse) {
    warnings.push("csv-parse not found; using built-in CSV parser fallback.");
  }
  if (options.mode === "validate" && !options.audioDir) {
    warnings.push("No --audio-dir supplied for validate; audio file existence checks were skipped.");
  }

  const modulesTable = loadCsvTable(options.modulesPath, MODULE_COLUMNS, "modules.csv");
  const quizzesTable = loadCsvTable(options.quizzesPath, QUIZ_COLUMNS, "quizzes.csv");
  const glossaryTable = loadCsvTable(options.glossaryPath, GLOSSARY_COLUMNS, "glossary.csv");

  const moduleBuild = buildModules(modulesTable.records, {
    audioDir: options.audioDir,
    warnings,
  });
  const quizBuild = buildQuizMap(quizzesTable.records, moduleBuild.moduleNumbers, warnings);
  const glossary = buildGlossary(glossaryTable.records, moduleBuild.moduleNumbers, warnings);

  moduleBuild.modules.forEach((module) => {
    const quizQuestions = quizBuild.byModuleNumber.get(module.moduleNumber);

    if (!quizQuestions || quizQuestions.length !== 5) {
      throw new Error(
        `Module ${module.moduleNumber} (${module.titleHa}) must have exactly 5 quiz questions in quizzes.csv.`
      );
    }

    module.quizQuestions = quizQuestions;
  });

  const bundle = {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    gradeBands: GRADE_BAND_ORDER.filter((gradeBand) => moduleBuild.byGradeBand[gradeBand] > 0),
    modules: moduleBuild.modules,
    glossary,
  };

  return {
    bundle,
    summary: summarizeBundle(bundle),
    warnings,
  };
}

function buildModules(records, options) {
  const warnings = options.warnings || [];
  const modules = [];
  const seenModuleNumbers = new Set();
  const byGradeBandNumbers = {
    Foundation: [],
    P1: [],
    P2: [],
    P3: [],
  };
  const countsByGradeBand = {
    Foundation: 0,
    P1: 0,
    P2: 0,
    P3: 0,
  };

  records.forEach((record, index) => {
    const rowNumber = index + 2;
    const moduleNumber = requireInteger(record.module_number, "module_number", rowNumber, { min: 1 });
    const gradeBand = normalizeGradeBand(record.grade_band, rowNumber);

    if (seenModuleNumbers.has(moduleNumber)) {
      throw new Error(`Duplicate module_number "${moduleNumber}" found at modules.csv row ${rowNumber}.`);
    }

    seenModuleNumbers.add(moduleNumber);
    byGradeBandNumbers[gradeBand].push(moduleNumber);
    countsByGradeBand[gradeBand] += 1;

    const audioFilename = requireNonEmpty(record.audio_filename, "audio_filename", rowNumber);
    if (options.audioDir) {
      const audioPath = path.resolve(options.audioDir, audioFilename);
      if (!fs.existsSync(audioPath)) {
        throw new Error(`Audio file not found for module ${moduleNumber}: ${audioPath}`);
      }
    }

    const status = requireNonEmpty(record.status, "status", rowNumber);
    if (!PUBLISHED_STATUS.has(status.toLowerCase())) {
      warnings.push(`modules.csv row ${rowNumber}: status "${status}" is not one of draft/review/published/archived.`);
    }

    const microPauses = [1, 2].map((pauseNumber) => {
      return buildMicroPause(record, rowNumber, pauseNumber);
    });

    if (microPauses.length !== 2) {
      throw new Error(`Module ${moduleNumber} at row ${rowNumber} must contain exactly 2 micro-pauses.`);
    }

    modules.push({
      id: buildModuleId(gradeBand, moduleNumber),
      gradeband: gradeBand,
      moduleNumber,
      titleEn: requireNonEmpty(record.title_en, "title_en", rowNumber),
      titleHa: requireNonEmpty(record.title_ha, "title_ha", rowNumber),
      titleAjami: requireNonEmpty(record.title_ajami, "title_ajami", rowNumber),
      textExplanationHa: requireNonEmpty(record.text_explanation_ha, "text_explanation_ha", rowNumber),
      audioFile: normalizeAssetPath(audioFilename, "audio"),
      imageCard: normalizeAssetPath(
        requireNonEmpty(record.image_card_filename, "image_card_filename", rowNumber),
        "images"
      ),
      curriculumRef: requireNonEmpty(record.curriculum_ref, "curriculum_ref", rowNumber),
      status,
      microPauses,
      quizQuestions: [],
    });
  });

  Object.keys(byGradeBandNumbers).forEach((gradeBand) => {
    validateSequentialNumbers(byGradeBandNumbers[gradeBand], gradeBand);
  });

  return {
    modules: modules.sort(sortModules),
    moduleNumbers: seenModuleNumbers,
    byGradeBand: countsByGradeBand,
  };
}

function buildMicroPause(record, rowNumber, pauseNumber) {
  const prefix = `micro_pause_${pauseNumber}`;
  const correctAnswer = requireNonEmpty(record[`${prefix}_answer`], `${prefix}_answer`, rowNumber);
  const options = parsePipeSeparated(record[`${prefix}_options`], `${prefix}_options`, rowNumber);

  if (options.length < 2) {
    throw new Error(`${prefix}_options at row ${rowNumber} must contain at least 2 options.`);
  }

  if (options.indexOf(correctAnswer) === -1) {
    throw new Error(`${prefix}_options at row ${rowNumber} must include the correct answer "${correctAnswer}".`);
  }

  return {
    pauseAtMs: requireInteger(record[`${prefix}_ms`], `${prefix}_ms`, rowNumber, { min: 0 }),
    questionHa: requireNonEmpty(record[`${prefix}_question_ha`], `${prefix}_question_ha`, rowNumber),
    correctAnswer,
    options,
  };
}

function buildQuizMap(records, moduleNumbers, warnings) {
  const grouped = new Map();

  records.forEach((record, index) => {
    const rowNumber = index + 2;
    const moduleNumber = requireInteger(record.module_number, "module_number", rowNumber, { min: 1 });
    const questionNumber = requireInteger(record.question_number, "question_number", rowNumber, {
      min: 1,
      max: 5,
    });

    if (!moduleNumbers.has(moduleNumber)) {
      throw new Error(`quizzes.csv row ${rowNumber} references module_number ${moduleNumber}, but no module exists.`);
    }

    const templateHa = requireNonEmpty(record.template_ha, "template_ha", rowNumber);
    const templateAjami = requireNonEmpty(record.template_ajami, "template_ajami", rowNumber);
    const answerFormula = requireNonEmpty(record.answer_formula, "answer_formula", rowNumber);
    const variableRanges = {
      a: {
        min: requireInteger(record.var_a_min, "var_a_min", rowNumber),
        max: requireInteger(record.var_a_max, "var_a_max", rowNumber),
      },
      b: {
        min: requireInteger(record.var_b_min, "var_b_min", rowNumber),
        max: requireInteger(record.var_b_max, "var_b_max", rowNumber),
      },
    };
    const distractorFormulas = [
      requireNonEmpty(record.distractor_1, "distractor_1", rowNumber),
      requireNonEmpty(record.distractor_2, "distractor_2", rowNumber),
      requireNonEmpty(record.distractor_3, "distractor_3", rowNumber),
    ];

    validateRange(variableRanges.a, "var_a", rowNumber);
    validateRange(variableRanges.b, "var_b", rowNumber);
    validateFormulaSet(answerFormula, distractorFormulas, variableRanges, rowNumber);

    if (!grouped.has(moduleNumber)) {
      grouped.set(moduleNumber, []);
    }

    const existingQuestion = grouped
      .get(moduleNumber)
      .find((question) => question.questionNumber === questionNumber);

    if (existingQuestion) {
      throw new Error(
        `Duplicate question_number ${questionNumber} for module_number ${moduleNumber} in quizzes.csv row ${rowNumber}.`
      );
    }

    grouped.get(moduleNumber).push({
      questionNumber,
      templateHa,
      templateAjami,
      answerFormula,
      variableRanges,
      distractorFormulas,
    });
  });

  grouped.forEach((questions, moduleNumber) => {
    if (questions.length !== 5) {
      throw new Error(`Module ${moduleNumber} must have exactly 5 quiz questions; found ${questions.length}.`);
    }

    const sortedNumbers = questions
      .map((question) => question.questionNumber)
      .slice()
      .sort((left, right) => left - right);

    for (let index = 0; index < 5; index += 1) {
      if (sortedNumbers[index] !== index + 1) {
        throw new Error(
          `Module ${moduleNumber} must have question_number values 1 through 5 exactly once in quizzes.csv.`
        );
      }
    }

    questions.sort((left, right) => left.questionNumber - right.questionNumber);
  });

  if (!grouped.size) {
    warnings.push("No quiz questions were found in quizzes.csv.");
  }

  return {
    byModuleNumber: grouped,
  };
}

function buildGlossary(records, moduleNumbers, warnings) {
  const glossary = [];
  const seenKeys = new Set();

  records.forEach((record, index) => {
    const rowNumber = index + 2;
    const termAjami = requireNonEmpty(record.term_ajami, "term_ajami", rowNumber);
    const termHausa = requireNonEmpty(record.term_hausa, "term_hausa", rowNumber);
    const termEnglish = requireNonEmpty(record.term_english, "term_english", rowNumber);
    const definitionHa = requireNonEmpty(record.definition_ha, "definition_ha", rowNumber);
    const category = requireNonEmpty(record.category, "category", rowNumber);
    const relatedModules = parseCommaSeparatedIntegers(record.related_modules, "related_modules", rowNumber);
    const glossaryKey = `${termHausa.toLowerCase()}::${termEnglish.toLowerCase()}`;

    if (seenKeys.has(glossaryKey)) {
      warnings.push(`Duplicate glossary term "${termHausa}" at glossary.csv row ${rowNumber}.`);
    }
    seenKeys.add(glossaryKey);

    relatedModules.forEach((moduleNumber) => {
      if (!moduleNumbers.has(moduleNumber)) {
        throw new Error(
          `glossary.csv row ${rowNumber} references related module ${moduleNumber}, but no matching module exists.`
        );
      }
    });

    glossary.push({
      id: buildGlossaryId(termHausa, index),
      term: termHausa,
      termAjami,
      termHausa,
      termEnglish,
      definitionHa,
      meaningHa: definitionHa,
      meaningEn: termEnglish,
      category,
      relatedModules,
    });
  });

  return glossary;
}

function summarizeBundle(bundle) {
  const summary = {
    version: bundle.version || "unknown",
    generatedAt: bundle.generatedAt || "unknown",
    totalModules: 0,
    totalQuizQuestions: 0,
    totalGlossaryTerms: Array.isArray(bundle.glossary) ? bundle.glossary.length : 0,
    byGradeBand: {},
    warnings: [],
  };

  GRADE_BAND_ORDER.forEach((gradeBand) => {
    summary.byGradeBand[gradeBand] = 0;
  });

  (bundle.modules || []).forEach((module) => {
    summary.totalModules += 1;
    summary.totalQuizQuestions += Array.isArray(module.quizQuestions) ? module.quizQuestions.length : 0;

    if (summary.byGradeBand[module.gradeband] == null) {
      summary.byGradeBand[module.gradeband] = 0;
    }
    summary.byGradeBand[module.gradeband] += 1;

    if (!Array.isArray(module.microPauses) || module.microPauses.length !== 2) {
      summary.warnings.push(`Module ${module.id || module.moduleNumber} does not have exactly 2 micro-pauses.`);
    }

    if (!Array.isArray(module.quizQuestions) || module.quizQuestions.length !== 5) {
      summary.warnings.push(`Module ${module.id || module.moduleNumber} does not have exactly 5 quiz questions.`);
    }
  });

  return summary;
}

function printSummary(report, options) {
  console.log(options.title);
  if (options.outputPath) {
    console.log(`Output: ${options.outputPath}`);
  }
  console.log(`Version: ${report.bundle.version}`);
  console.log(`Generated At: ${report.bundle.generatedAt}`);
  console.log(`Total Modules: ${report.summary.totalModules}`);
  console.log("By Grade Band:");
  GRADE_BAND_ORDER.forEach((gradeBand) => {
    if (report.summary.byGradeBand[gradeBand]) {
      console.log(`  ${gradeBand}: ${report.summary.byGradeBand[gradeBand]}`);
    }
  });
  console.log(`Total Quiz Questions: ${report.summary.totalQuizQuestions}`);
  console.log(`Total Glossary Terms: ${report.summary.totalGlossaryTerms}`);

  const warnings = report.warnings.concat(report.summary.warnings);
  if (warnings.length) {
    console.log("Warnings:");
    warnings.forEach((warning) => {
      console.log(`  - ${warning}`);
    });
  } else {
    console.log("Warnings: none");
  }
}

function loadCsvTable(filePath, requiredColumns, label) {
  const text = fs.readFileSync(filePath, "utf8");
  const rows = parseCsvRows(text)
    .map((row) => row.map((cell) => String(cell).trim()))
    .filter((row) => row.some((cell) => cell !== ""));

  if (!rows.length) {
    throw new Error(`${label} is empty.`);
  }

  const headers = rows[0];
  const missingHeaders = requiredColumns.filter((column) => headers.indexOf(column) === -1);

  if (missingHeaders.length) {
    throw new Error(`${label} is missing required columns: ${missingHeaders.join(", ")}`);
  }

  const records = rows.slice(1).map((row) => mapRow(headers, row));
  return { headers, records };
}

function parseCsvRows(text) {
  if (csvParse) {
    return csvParse(text, {
      bom: true,
      skip_empty_lines: true,
      relax_column_count: true,
    });
  }

  return parseCsvFallback(text);
}

function mapRow(headers, row) {
  const record = {};

  headers.forEach((header, index) => {
    record[header] = index < row.length ? String(row[index]).trim() : "";
  });

  return record;
}

function parseCsvFallback(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const nextCharacter = text[index + 1];

    if (character === "\"") {
      if (inQuotes && nextCharacter === "\"") {
        cell += "\"";
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (character === "," && !inQuotes) {
      row.push(cell);
      cell = "";
      continue;
    }

    if ((character === "\n" || character === "\r") && !inQuotes) {
      if (character === "\r" && nextCharacter === "\n") {
        index += 1;
      }
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    cell += character;
  }

  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

function validateSequentialNumbers(numbers, gradeBand) {
  if (!numbers.length) {
    return;
  }

  const sorted = numbers.slice().sort((left, right) => left - right);
  for (let index = 0; index < sorted.length; index += 1) {
    const expected = index + 1;
    if (sorted[index] !== expected) {
      throw new Error(
        `module_number must be sequential per grade_band. ${gradeBand} expected ${expected} but found ${sorted[index]}.`
      );
    }
  }
}

function validateRange(range, label, rowNumber) {
  if (range.max < range.min) {
    throw new Error(`${label}_max must be greater than or equal to ${label}_min at row ${rowNumber}.`);
  }
}

function validateFormulaSet(answerFormula, distractorFormulas, variableRanges, rowNumber) {
  const formulas = [answerFormula].concat(distractorFormulas);
  const sampleValues = buildSampleValues(variableRanges);

  formulas.forEach((formula, index) => {
    const label = index === 0 ? "answer_formula" : `distractor_${index}`;
    sampleValues.forEach((variables) => {
      try {
        evaluateFormula(formula, variables);
      } catch (error) {
        throw new Error(`${label} at quizzes.csv row ${rowNumber} is invalid for a=${variables.a}, b=${variables.b}: ${error.message}`);
      }
    });
  });
}

function buildSampleValues(variableRanges) {
  const values = [];
  const rawSamples = [
    { a: variableRanges.a.min, b: variableRanges.b.min },
    { a: variableRanges.a.max, b: variableRanges.b.max },
    { a: variableRanges.a.min, b: variableRanges.b.max },
    { a: variableRanges.a.max, b: variableRanges.b.min },
    {
      a: Math.floor((variableRanges.a.min + variableRanges.a.max) / 2),
      b: Math.floor((variableRanges.b.min + variableRanges.b.max) / 2),
    },
  ];
  const seen = new Set();

  rawSamples.forEach((variables) => {
    const key = `${variables.a}:${variables.b}`;
    if (!seen.has(key)) {
      seen.add(key);
      values.push(variables);
    }
  });

  return values;
}

function evaluateFormula(formula, variables) {
  let expression = String(formula || "").trim();

  Object.keys(variables)
    .sort((left, right) => right.length - left.length)
    .forEach((key) => {
      const value = String(variables[key]);
      const bracePattern = new RegExp(`\\{${escapeRegExp(key)}\\}`, "gi");
      const barePattern = new RegExp(`\\b${escapeRegExp(key)}\\b`, "gi");
      expression = expression.replace(bracePattern, value).replace(barePattern, value);
    });

  if (!EVALUATED_FORMULA_PATTERN.test(expression)) {
    throw new Error(`unsupported characters after substitution: ${expression}`);
  }

  if (/\/\s*0+(?:\.0+)?(?:\D|$)/.test(expression)) {
    throw new Error(`division by zero: ${expression}`);
  }

  const result = Function(`"use strict"; return (${expression});`)();

  if (!Number.isFinite(result)) {
    throw new Error(`non-finite result: ${expression}`);
  }

  if (!Number.isInteger(result)) {
    throw new Error(`non-integer result: ${expression}`);
  }

  if (result < 0) {
    throw new Error(`negative result: ${expression}`);
  }

  return result;
}

function normalizeGradeBand(value, rowNumber) {
  const normalized = GRADE_BAND_MAP[String(value || "").trim().toLowerCase()];
  if (!normalized) {
    throw new Error(
      `Invalid grade_band "${value}" at row ${rowNumber}. Expected one of foundation, p1, p2, p3.`
    );
  }
  return normalized;
}

function buildModuleId(gradeBand, moduleNumber) {
  return `${gradeBand.toLowerCase()}-${String(moduleNumber).padStart(2, "0")}`;
}

function buildGlossaryId(termHausa, index) {
  return (
    String(termHausa || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || `term-${index + 1}`
  );
}

function sortModules(left, right) {
  if (left.gradeband === right.gradeband) {
    return left.moduleNumber - right.moduleNumber;
  }

  return GRADE_BAND_ORDER.indexOf(left.gradeband) - GRADE_BAND_ORDER.indexOf(right.gradeband);
}

function normalizeAssetPath(filename, assetFolder) {
  if (/^(\/|https?:\/\/)/i.test(filename)) {
    return filename;
  }

  return `/app/assets/${assetFolder}/${filename}`;
}

function parsePipeSeparated(value, fieldName, rowNumber) {
  const parts = String(value || "")
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean);

  if (!parts.length) {
    throw new Error(`Field "${fieldName}" at row ${rowNumber} must contain pipe-separated values.`);
  }

  return parts;
}

function parseCommaSeparatedIntegers(value, fieldName, rowNumber) {
  const parts = String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  if (!parts.length) {
    throw new Error(`Field "${fieldName}" at row ${rowNumber} must contain at least one module number.`);
  }

  return parts.map((part) => requireInteger(part, fieldName, rowNumber, { min: 1 }));
}

function requireNonEmpty(value, fieldName, rowNumber) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new Error(`Missing required field "${fieldName}" at row ${rowNumber}.`);
  }
  return normalized;
}

function requireInteger(value, fieldName, rowNumber, options) {
  const numericOptions = Object.assign({}, options || {});
  const parsed = Number.parseInt(String(value || "").trim(), 10);

  if (!Number.isInteger(parsed)) {
    throw new Error(`Field "${fieldName}" at row ${rowNumber} must be an integer.`);
  }

  if (typeof numericOptions.min === "number" && parsed < numericOptions.min) {
    throw new Error(`Field "${fieldName}" at row ${rowNumber} must be at least ${numericOptions.min}.`);
  }

  if (typeof numericOptions.max === "number" && parsed > numericOptions.max) {
    throw new Error(`Field "${fieldName}" at row ${rowNumber} must be at most ${numericOptions.max}.`);
  }

  return parsed;
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read JSON from ${filePath}: ${error.message}`);
  }
}

function resolveExistingFile(filePath) {
  const resolved = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`File not found: ${resolved}`);
  }
  return resolved;
}

function resolveExistingDirectory(directoryPath) {
  const resolved = path.resolve(process.cwd(), directoryPath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Directory not found: ${resolved}`);
  }
  return resolved;
}

function requireArgs(args, requiredKeys) {
  const missing = requiredKeys.filter((key) => !args[key]);
  if (missing.length) {
    throw new Error(`Missing required argument(s): ${missing.map((key) => `--${key}`).join(", ")}`);
  }
}

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }

    if (token.startsWith("--")) {
      const key = token.slice(2);
      const value = argv[index + 1];
      if (value == null || String(value).startsWith("--")) {
        throw new Error(`Argument ${token} requires a value.`);
      }
      args[key] = value;
      index += 1;
    }
  }

  return args;
}

function printUsage() {
  console.log("Usage:");
  console.log(
    "  node content-pipeline.js ingest --input modules.csv --quizzes quizzes.csv --glossary glossary.csv --audio-dir ./audio/ --output ../app/content.json"
  );
  console.log(
    "  node content-pipeline.js validate --input modules.csv --quizzes quizzes.csv --glossary glossary.csv [--audio-dir ./audio/]"
  );
  console.log("  node content-pipeline.js status --input ../app/content.json");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fail(message) {
  console.error(`AJAMIX content pipeline error: ${message}`);
  process.exit(1);
}
