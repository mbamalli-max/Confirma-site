const SAFE_FORMULA_PATTERN = /^[\d\s+\-*/().]+$/;
const MAX_GENERATION_ATTEMPTS = 50;

export function generateQuizInstance(template) {
  const quizTemplate = template || {};
  let lastError = null;

  for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt += 1) {
    try {
      const variables = buildVariables(quizTemplate.variableRanges || {});
      const questionText = substituteTemplate(quizTemplate.templateHa, variables);
      const correctAnswer = evaluateFormula(quizTemplate.answerFormula, variables);
      const distractorAnswers = (quizTemplate.distractorFormulas || []).map((formula) =>
        evaluateFormula(formula, variables)
      );
      const options = buildOptions(correctAnswer, distractorAnswers);

      return {
        questionText,
        correctAnswer: String(correctAnswer),
        options: shuffle(options).map((value) => String(value)),
        variables,
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    lastError instanceof Error
      ? `Could not generate quiz question: ${lastError.message}`
      : "Could not generate quiz question."
  );
}

export function generateQuiz(moduleQuizTemplates) {
  return (moduleQuizTemplates || []).slice(0, 5).map((template) => generateQuizInstance(template));
}

function buildVariables(variableRanges) {
  return Object.keys(variableRanges || {}).reduce((variables, key) => {
    const range = variableRanges[key] || {};
    variables[key] = randomInteger(range.min, range.max);
    return variables;
  }, {});
}

function randomInteger(minimum, maximum) {
  const rawMin = Number.isFinite(minimum) ? minimum : 0;
  const rawMax = Number.isFinite(maximum) ? maximum : rawMin;
  const min = Math.ceil(Math.min(rawMin, rawMax));
  const max = Math.floor(Math.max(rawMin, rawMax));
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function substituteTemplate(template, variables) {
  return String(template || "").replace(/\{([a-z_][a-z0-9_]*)\}/gi, (_, key) => {
    return Object.prototype.hasOwnProperty.call(variables, key) ? String(variables[key]) : "";
  });
}

function substituteFormula(formula, variables) {
  let expression = String(formula || "");
  const keys = Object.keys(variables).sort((left, right) => right.length - left.length);

  keys.forEach((key) => {
    const value = String(variables[key]);
    const bracePattern = new RegExp(`\\{${escapeRegExp(key)}\\}`, "g");
    const barePattern = new RegExp(`\\b${escapeRegExp(key)}\\b`, "g");
    expression = expression.replace(bracePattern, value).replace(barePattern, value);
  });

  return expression.trim();
}

function evaluateFormula(formula, variables) {
  const expression = substituteFormula(formula, variables);

  if (!SAFE_FORMULA_PATTERN.test(expression)) {
    throw new Error(`Unsafe formula: ${expression}`);
  }

  if (containsDirectDivisionByZero(expression)) {
    throw new Error(`Division by zero detected: ${expression}`);
  }

  const evaluator = new Function(`"use strict"; return (${expression});`);
  const result = evaluator();

  if (!Number.isFinite(result)) {
    throw new Error(`Invalid formula result: ${expression}`);
  }

  if (!Number.isInteger(result)) {
    throw new Error(`Quiz answers must be whole numbers: ${expression}`);
  }

  if (result < 0) {
    throw new Error(`Negative answers are not allowed: ${expression}`);
  }

  return result;
}

function containsDirectDivisionByZero(expression) {
  return /\/\s*0+(?:\.0+)?(?:\D|$)/.test(expression);
}

function buildOptions(correctAnswer, distractorAnswers) {
  const options = [correctAnswer];

  distractorAnswers.forEach((value) => {
    if (value >= 0 && options.indexOf(value) === -1) {
      options.push(value);
    }
  });

  let offset = 1;
  while (options.length < 4 && offset < 20) {
    const larger = correctAnswer + offset;
    const smaller = correctAnswer - offset;

    if (options.indexOf(larger) === -1) {
      options.push(larger);
    }

    if (options.length < 4 && smaller >= 0 && options.indexOf(smaller) === -1) {
      options.push(smaller);
    }

    offset += 1;
  }

  if (options.length < 4) {
    throw new Error("Not enough unique quiz options could be generated.");
  }

  return options.slice(0, 4);
}

function shuffle(values) {
  const copy = values.slice();

  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    const temp = copy[index];
    copy[index] = copy[swapIndex];
    copy[swapIndex] = temp;
  }

  return copy;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
