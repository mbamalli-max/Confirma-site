// Search-text normalisation shared by the alias exporter and the business picker.
// Hausa hooked letters do not decompose under Unicode NFD, so they are mapped explicitly.
const HOOKED_LETTERS = { "ɓ": "b", "ɗ": "d", "ƙ": "k", "ƴ": "y" };

export function normalizeSearchText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[ɓɗƙƴ]/g, (letter) => HOOKED_LETTERS[letter])
    .replace(/['’]/g, "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
