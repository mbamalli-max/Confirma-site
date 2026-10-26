"""Search-text normalisation for the Python alias tools. Must match app-v3/business-text.js (tested)."""
import re
import unicodedata

HOOKED = str.maketrans({"ɓ": "b", "ɗ": "d", "ƙ": "k", "ƴ": "y", "'": "", "’": ""})


def norm(text):
    text = unicodedata.normalize("NFD", text.lower().translate(HOOKED))
    text = "".join(c for c in text if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", " ", text).strip()
