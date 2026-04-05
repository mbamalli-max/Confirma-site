# AJAMIX — Technical Architecture Specification

## 1. System Architecture

AJAMIX is a static, offline-first PWA with no backend server in Phase 1. Content is pre-built as a JSON bundle and served alongside the app shell from Vercel. All computation (quiz generation, progress tracking, streak calculation) happens client-side in the browser.

```
┌─────────────────────────────────────────────────────┐
│  AJAMIX PWA (Vanilla JS, Single HTML File)          │
│                                                     │
│  ┌─────────────┐ ┌─────────────┐ ┌──────────────┐  │
│  │ Audio Player │ │ Quiz Engine │ │ Flame Streak │  │
│  │ + Micro-    │ │ + Randomized│ │ (Structural  │  │
│  │   Pause     │ │   Variants  │ │  Decay)      │  │
│  │   (TMSE)    │ │             │ │              │  │
│  └─────────────┘ └─────────────┘ └──────────────┘  │
│                                                     │
│  ┌─────────────────────────────────────────────────┐│
│  │ IndexedDB                                       ││
│  │ modules | audioCache | progress | glossary      ││
│  └─────────────────────────────────────────────────┘│
│                                                     │
│  ┌──────────────────┐ ┌───────────────────────────┐ │
│  │ Service Worker   │ │ Content Sync (future)     │ │
│  │ (cache shell +   │ │ (version check + delta    │ │
│  │  audio + fonts)  │ │  download when online)    │ │
│  └──────────────────┘ └───────────────────────────┘ │
└─────────────────────────────────────────────────────┘
         │
         ▼  (static hosting, no server logic)
┌─────────────────────────────────────────────────────┐
│  Vercel (Static Hosting)                            │
│  /app/index.html   — PWA shell                      │
│  /app/content.json — Content bundle                 │
│  /app/audio/*.mp3  — Audio files                    │
│  /app/images/*     — Ajami key term cards           │
└─────────────────────────────────────────────────────┘
```

### Deployment

| Asset | Host | URL |
|-------|------|-----|
| PWA (app shell + content) | Vercel (free) | `ajamix.ng/app/` |
| Audio files | Vercel or Cloudflare R2 | `ajamix.ng/app/audio/` or `cdn.ajamix.ng/audio/` |
| Marketing site (future) | Vercel | `ajamix.ng/` |

### Why No Backend (Phase 1)
- Tsangaya students may not have phone numbers for account creation
- All learning content is static (no dynamic generation needed)
- Quiz evaluation is client-side (parameterized templates)
- Progress is device-local (no multi-device sync needed yet)
- Eliminates server hosting costs and complexity
- Backend added in Phase 3 for progress sync and teacher dashboards

---

## 2. Data Models

### 2.1 Content Bundle (content.json)

The entire content library is a single JSON file downloaded on first launch.

```json
{
  "version": "1.0.0",
  "generatedAt": "2026-04-10T12:00:00Z",
  "gradeBands": [
    {
      "id": "foundation",
      "nameHa": "Tushe",
      "nameAjami": "تُسْهٜ",
      "nameEn": "Foundation Stage",
      "sortOrder": 1,
      "moduleRange": [1, 15]
    }
  ],
  "modules": [
    {
      "id": 1,
      "slug": "foundation-01-number-recognition-1-10",
      "gradeBand": "foundation",
      "moduleNumber": 1,
      "titleHa": "Gane Lambobi 1-10",
      "titleAjami": "غَنٜ لَمْبٛبِ ١-١٠",
      "titleEn": "Number Recognition 1-10",
      "textExplanationHa": "A wannan darasi, za mu koyi gane lambobi daga 1 zuwa 10...",
      "audioFile": "audio/foundation-01.mp3",
      "audioDurationMs": 180000,
      "imageCard": "images/foundation-01-card.webp",
      "curriculumRef": "NERDC-BEC-M-F-01",
      "isAdultVariant": false,
      "parentModuleId": null,
      "microPauses": [
        {
          "pauseAtMs": 45000,
          "questionHa": "Wane lamba ne wannan?",
          "questionAjami": "وَنٜ لَمْبَ نٜ وَنَّنْ؟",
          "correctAnswer": "5",
          "options": ["3", "5", "7", "10"],
          "sortOrder": 1
        },
        {
          "pauseAtMs": 120000,
          "questionHa": "Bayan 7, wane lamba ne?",
          "correctAnswer": "8",
          "options": ["6", "8", "9", "10"],
          "sortOrder": 2
        }
      ],
      "quizQuestions": [
        {
          "templateHa": "Wane lamba ne ya zo bayan {a}?",
          "templateAjami": "وَنٜ لَمْبَ نٜ يَ زٛ بَيَنْ {a}؟",
          "answerFormula": "{a} + 1",
          "variableRanges": {
            "a": { "min": 1, "max": 8 }
          },
          "distractorFormulas": ["{a} - 1", "{a} + 2", "{a}"],
          "answerType": "multiple_choice",
          "sortOrder": 1
        }
      ]
    }
  ],
  "glossary": [
    {
      "id": 1,
      "termAjami": "لَمْبَ",
      "termHausa": "lamba",
      "termEnglish": "number",
      "definitionHa": "Alama da ake amfani da ita wajen kidaya ko auna yawan abu",
      "category": "lissafi",
      "relatedModules": [1, 2, 3],
      "audioFile": null
    }
  ]
}
```

### 2.2 IndexedDB Schema (Client-Side)

```
Database: "ajamix-db"
Version: 1

Object Stores:

┌─────────────┬──────────────┬─────────────────────────────────────┐
│ Store        │ keyPath      │ Purpose                             │
├─────────────┼──────────────┼─────────────────────────────────────┤
│ settings     │ "key"        │ App config, streak state, last      │
│              │              │ content version, onboarding state   │
├─────────────┼──────────────┼─────────────────────────────────────┤
│ modules      │ "id"         │ Module metadata (from content.json) │
│              │              │ Indexes: gradeBand, moduleNumber    │
├─────────────┼──────────────┼─────────────────────────────────────┤
│ audioCache   │ "moduleId"   │ Audio file blobs (large, separate   │
│              │              │ from module metadata for storage     │
│              │              │ management)                         │
├─────────────┼──────────────┼─────────────────────────────────────┤
│ progress     │ "moduleId"   │ Per-module learning progress:       │
│              │              │ audioListenedPct, microPause1Correct│
│              │              │ microPause2Correct, quizScore,      │
│              │              │ quizAttempts, bestQuizScore,        │
│              │              │ completedAt, lastAccessedAt,        │
│              │              │ microPauseResponseTimes (TMSE data) │
├─────────────┼──────────────┼─────────────────────────────────────┤
│ glossary     │ "id"         │ All glossary terms                  │
│              │              │ Indexes: termHausa, termEnglish,    │
│              │              │ category                            │
└─────────────┴──────────────┴─────────────────────────────────────┘
```

### 2.3 Settings Store Keys

```javascript
// Stored in IndexedDB 'settings' store
{
  key: "onboardingComplete",   value: true/false
  key: "selectedGradeBand",    value: "foundation" | "p1" | "p2" | "p3"
  key: "learnerType",          value: "child" | "adult"
  key: "displayName",          value: "Ahmad"
  key: "displayNameAjami",     value: "أحْمَد"
  key: "contentVersion",       value: "1.0.0"
  key: "lastContentCheck",     value: "2026-04-10T12:00:00Z"
  key: "streakData",           value: {
    lastActivityDate: "2026-04-05",
    streakDays: 7,
    streakState: "bright"  // "bright" | "dim" | "out"
  }
  key: "audioDownloadState",   value: {
    gradeBand: "foundation",
    completedModuleIds: [1, 2, 3],
    totalModules: 15,
    status: "complete"  // "pending" | "downloading" | "complete" | "partial"
  }
}
```

---

## 3. Ajami Rendering

### Challenge
Ajami uses Arabic script with additional characters specific to Hausa. Sounds like "ts" (TS), "gw", "kw", and nasalized vowels require extended Arabic Unicode characters that standard Arabic fonts may not render. Text is RTL, but embedded numerals in math expressions are LTR.

### Font Selection
**Primary:** Noto Naskh Arabic (Google Fonts, OFL license)
- Covers standard Arabic + most extended Arabic Unicode ranges
- Regular + Bold weights bundled (~200KB per weight as woff2)
- Cached by service worker for offline use

**Fallback:** Scheherazade New (SIL International)
- Better coverage of non-standard Arabic-script characters
- Fallback if Noto Naskh misses specific Hausa Ajami characters

### CSS Implementation

```css
/* Ajami text (RTL) */
.ajami {
  font-family: 'Noto Naskh Arabic', 'Scheherazade New', serif;
  direction: rtl;
  unicode-bidi: bidi-override;
  text-align: right;
  font-size: 1.25rem;    /* 20px — minimum for readability */
  line-height: 1.8;       /* Generous for Arabic script */
}

/* Large Ajami (titles) */
.ajami-title {
  font-size: 1.75rem;     /* 28px */
  font-weight: 700;
}

/* LTR numbers embedded in RTL Ajami text */
.ajami .math-num {
  direction: ltr;
  unicode-bidi: embed;
  font-family: 'Inter', system-ui, sans-serif;
}

/* Hausa text (LTR) */
.hausa {
  font-family: 'Inter', system-ui, sans-serif;
  direction: ltr;
  font-size: 1rem;
  line-height: 1.6;
}
```

### Mixed-Direction Rendering
When quiz questions mix Ajami text with numerals, the quiz engine wraps numbers in `<span class="math-num">` elements automatically during template interpolation:

```javascript
function renderAjamiWithNumbers(template, vars) {
  let text = template;
  for (const [key, val] of Object.entries(vars)) {
    text = text.replaceAll(`{${key}}`, `<span class="math-num">${val}</span>`);
  }
  return text;
}
```

### Character Testing
Before pilot, render all glossary terms (100–150) at body and heading sizes on:
- Samsung Galaxy A03 (Chrome Android 90+)
- Tecno Spark 8C (Chrome Android)
- Infinix Hot 11 (Chrome Android)

Any character that doesn't render correctly gets a fallback: either the Scheherazade New font covers it, or an SVG/image is substituted for that specific character (last resort).

---

## 4. Audio Player with TMSE (Temporal Micro-Signature Engine)

### Architecture

```
┌─────────────────────────────────────────────┐
│  Lesson Screen                              │
│                                             │
│  ┌───────────────────────────────────────┐  │
│  │ <audio> element                       │  │
│  │  src: IndexedDB blob or network URL   │  │
│  │  events: timeupdate, ended, seeked    │  │
│  └───────────────────────────────────────┘  │
│           │                                 │
│           ▼ timeupdate (~250ms intervals)   │
│  ┌───────────────────────────────────────┐  │
│  │ Micro-Pause Controller                │  │
│  │                                       │  │
│  │ pendingPauses = [                     │  │
│  │   { ms: 45000, question: {...} },     │  │
│  │   { ms: 120000, question: {...} }     │  │
│  │ ]                                     │  │
│  │                                       │  │
│  │ if (currentTime*1000 >= next.ms-500   │  │
│  │     && currentTime*1000 <= next.ms+500│  │
│  │ ) → trigger pause                     │  │
│  └───────────────────────────────────────┘  │
│           │                                 │
│           ▼ pause triggered                 │
│  ┌───────────────────────────────────────┐  │
│  │ Question Overlay                      │  │
│  │                                       │  │
│  │ audio.pause()                         │  │
│  │ Show question + options               │  │
│  │ Record: startTime = Date.now()        │  │
│  │ On answer:                            │  │
│  │   responseTimeMs = Date.now() - start │  │
│  │   correct = selected === answer       │  │
│  │   Store in IndexedDB progress         │  │
│  │   audio.play()                        │  │
│  │   Remove from pendingPauses           │  │
│  └───────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
```

### Seek Protection
If a user seeks past a micro-pause point, the `seeked` event handler checks:

```javascript
audio.addEventListener('seeked', () => {
  const currentMs = audio.currentTime * 1000;
  const skipped = pendingPauses.filter(p => p.ms < currentMs);
  if (skipped.length > 0) {
    // Pause and trigger skipped questions in sequence
    audio.pause();
    triggerQuestionsSequentially(skipped);
  }
});
```

### TMSE Data Collection
Even in Phase 1 (basic), the micro-pause system records temporal micro-signature data:

```javascript
// Stored in IndexedDB progress store per module
{
  moduleId: 1,
  microPauseData: [
    {
      pauseIndex: 1,
      pauseAtMs: 45000,
      actualPauseMs: 45230,      // When pause actually triggered
      responseTimeMs: 2340,       // Time to answer
      selectedAnswer: "5",
      correct: true,
      timestamp: "2026-04-05T10:23:45Z"
    }
  ]
}
```

This data has no analysis layer yet but is collected from day one. In Phase 6 (SEDA integration), this feeds into the full Temporal Micro-Signature analysis for learner attention profiling.

### Audio Progress Persistence

```javascript
audio.addEventListener('timeupdate', () => {
  const pct = Math.round((audio.currentTime / audio.duration) * 100);
  // Throttle writes to every 5% change
  if (pct - lastSavedPct >= 5) {
    updateProgress(moduleId, { audioListenedPct: pct });
    lastSavedPct = pct;
  }
});
```

### Audio Format
- **Codec:** MP3
- **Bitrate:** 64kbps CBR
- **Channels:** Mono
- **Sample rate:** 22050 Hz
- **Duration:** ~3 minutes per module
- **File size:** ~1.4MB per module
- **Total for 60 modules:** ~84MB
- **Per grade band (15 modules):** ~21MB

---

## 5. Quiz Engine

### Template Format

```json
{
  "templateHa": "Idan kana da {a} kwallo, sai ka samu {b} kari. Kwallonka nawa yanzu?",
  "templateAjami": "إِدَنْ كَنَ دَ {a} كْوَلّٛ...",
  "answerFormula": "{a} + {b}",
  "variableRanges": {
    "a": { "min": 3, "max": 15 },
    "b": { "min": 1, "max": 10 }
  },
  "distractorFormulas": ["{a} - {b}", "{a} * 2", "{b} + 1"],
  "answerType": "multiple_choice",
  "sortOrder": 1
}
```

### Generation Algorithm

```javascript
// quiz-engine.js (ES module)

export function generateQuizInstance(template) {
  const vars = {};

  // 1. Generate random variable values
  for (const [name, range] of Object.entries(template.variableRanges)) {
    const min = resolveValue(range.min, vars);
    const max = resolveValue(range.max, vars);
    vars[name] = min + Math.floor(Math.random() * (max - min + 1));
  }

  // 2. Create question text
  const questionText = interpolate(template.templateHa, vars);
  const questionAjami = template.templateAjami
    ? renderAjamiWithNumbers(template.templateAjami, vars)
    : null;

  // 3. Evaluate correct answer
  const correctAnswer = evalFormula(template.answerFormula, vars);

  // 4. Generate distractors
  let distractors = template.distractorFormulas.map(f => evalFormula(f, vars));

  // 5. Validate: no negatives, no duplicates
  distractors = distractors.filter(d => d >= 0 && d !== correctAnswer);
  while (distractors.length < 3) {
    // Generate fallback distractors
    const offset = Math.floor(Math.random() * 5) + 1;
    const candidate = correctAnswer + (Math.random() > 0.5 ? offset : -offset);
    if (candidate >= 0 && candidate !== correctAnswer && !distractors.includes(candidate)) {
      distractors.push(candidate);
    }
  }

  // 6. Shuffle options
  const options = shuffle([correctAnswer, ...distractors.slice(0, 3)]);

  return { questionText, questionAjami, correctAnswer, options, variables: vars };
}

// Safe formula evaluation
function evalFormula(formula, vars) {
  let expr = formula;
  for (const [k, v] of Object.entries(vars)) {
    expr = expr.replaceAll(`{${k}}`, v);
  }
  // SECURITY: Whitelist — only digits, operators, parentheses, decimals, spaces
  if (!/^[\d\s+\-*/().]+$/.test(expr)) {
    throw new Error(`Invalid formula: ${expr}`);
  }
  return Math.round(Function(`"use strict"; return (${expr})`)());
}

export function generateQuiz(templates) {
  return templates.map(t => generateQuizInstance(t));
}
```

### Authority Class
Quizzes use the **AUTO_VERIFIED** authority class from SEDA:
- Self-graded by the client
- Results are authoritative for module progression
- No external verification needed
- Score >= 3/5 = pass, unlocks next module

---

## 6. Flame Streak (Structural Decay Engine — Basic)

### State Machine

```
                 ┌──────────────────┐
  app open       │  Check last      │
  ─────────────►│  activity date   │
                 └────────┬─────────┘
                          │
            ┌─────────────┼─────────────┐
            ▼             ▼             ▼
     today/yesterday    2-4 days     5+ days
            │             │             │
            ▼             ▼             ▼
     ┌──────────┐  ┌──────────┐  ┌──────────┐
     │  BRIGHT  │  │   DIM    │  │   OUT    │
     │          │  │          │  │          │
     │ vivid    │  │ muted    │  │ grey     │
     │ orange/  │  │ orange,  │  │ no anim  │
     │ gold,    │  │ slow     │  │ streak=0 │
     │ flicker  │  │ pulse    │  │          │
     │ anim     │  │          │  │          │
     └──────────┘  └──────────┘  └──────────┘
```

### Implementation

```javascript
function updateStreak() {
  const streakData = await getFromDB('settings', 'streakData') || {
    lastActivityDate: null,
    streakDays: 0,
    streakState: 'out'
  };

  const today = new Date().toISOString().split('T')[0];
  const last = streakData.lastActivityDate;

  if (!last) {
    return { ...streakData, streakState: 'out' };
  }

  const daysSince = Math.floor(
    (new Date(today) - new Date(last)) / (1000 * 60 * 60 * 24)
  );

  if (daysSince === 0) {
    streakData.streakState = 'bright';
  } else if (daysSince === 1) {
    streakData.streakState = 'bright';
    streakData.streakDays += 1;
    streakData.lastActivityDate = today;
  } else if (daysSince <= 4) {
    streakData.streakState = 'dim';
  } else {
    streakData.streakState = 'out';
    streakData.streakDays = 0;
  }

  await putToDB('settings', 'streakData', streakData);
  return streakData;
}

function recordActivity() {
  const today = new Date().toISOString().split('T')[0];
  const streakData = await getFromDB('settings', 'streakData');
  streakData.lastActivityDate = today;
  streakData.streakState = 'bright';
  if (!streakData.streakDays) streakData.streakDays = 1;
  await putToDB('settings', 'streakData', streakData);
}
```

### CSS

```css
.flame {
  width: 60px;
  height: 80px;
  margin: 0 auto;
  position: relative;
}

.flame-bright {
  background: radial-gradient(ellipse at bottom, #E8A849 0%, #FF6B35 50%, transparent 70%);
  animation: flicker 0.3s infinite alternate;
}

.flame-dim {
  background: radial-gradient(ellipse at bottom, #C4956A 0%, #8B6914 50%, transparent 70%);
  opacity: 0.5;
  animation: pulse 2s infinite;
}

.flame-out {
  background: radial-gradient(ellipse at bottom, #888 0%, #555 50%, transparent 70%);
  opacity: 0.3;
}

@keyframes flicker {
  0% { transform: scaleY(1) scaleX(1); }
  100% { transform: scaleY(1.05) scaleX(0.95); }
}

@keyframes pulse {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 0.6; }
}
```

---

## 7. Offline Strategy

### Service Worker (sw.js)

```
Cache Name: "ajamix-v1"

INSTALL event:
  Pre-cache app shell:
  - /app/index.html
  - /app/styles.css
  - /app/app.js
  - /app/quiz-engine.js
  - /app/manifest.json
  - /app/fonts/NotoNaskhArabic-Regular.woff2
  - /app/fonts/NotoNaskhArabic-Bold.woff2

FETCH strategy by request type:
  ┌──────────────────────┬────────────────────────────┐
  │ Request Pattern       │ Strategy                   │
  ├──────────────────────┼────────────────────────────┤
  │ App shell files       │ Cache-first, network       │
  │ (.html, .css, .js)    │ fallback                   │
  ├──────────────────────┼────────────────────────────┤
  │ content.json          │ Network-first, cache       │
  │                       │ fallback (picks up updates)│
  ├──────────────────────┼────────────────────────────┤
  │ Audio files (.mp3)    │ Cache-first (large,        │
  │                       │ rarely change)             │
  ├──────────────────────┼────────────────────────────┤
  │ Image files (.webp)   │ Cache-first                │
  ├──────────────────────┼────────────────────────────┤
  │ Font files (.woff2)   │ Cache-first (pre-cached)   │
  ├──────────────────────┼────────────────────────────┤
  │ Everything else       │ Network-first, cache       │
  │                       │ fallback                   │
  └──────────────────────┴────────────────────────────┘

UPDATE event:
  On new SW version detected:
  - skipWaiting() in new SW
  - Post message to client: { type: 'SW_UPDATE_AVAILABLE' }
  - Client shows banner: "Sabon sigar AJAMIX yana samuwa" (New version available)
  - User taps → location.reload()
```

### Content Download Flow

```
First Launch:
  1. App shell loads from cache (instant)
  2. Fetch content.json (network, cached after)
  3. Parse → store modules in IndexedDB
  4. Parse → store glossary in IndexedDB
  5. Show grade band selection
  6. On selection → show audio download screen:
     ┌────────────────────────────────────┐
     │  Zazzaga Sautuka (Download Audio)  │
     │                                    │
     │  Tushe (Foundation) - 15 darusssa  │
     │  Girman: ~21 MB                    │
     │                                    │
     │  ████████████░░░░░░░  8/15         │
     │  foundation-08.mp3 (1.4 MB)        │
     │                                    │
     │  [Daina] [Ci gaba baya]            │
     │  (Stop)  (Continue later)          │
     └────────────────────────────────────┘
  7. Download audio files sequentially
  8. Store each as blob in IndexedDB audioCache
  9. Track progress in settings.audioDownloadState
  10. On complete: "An shirya! Kana iya koyo ba tare da intanet ba!"
      (Ready! You can learn without internet!)

Resume interrupted download:
  - Read audioDownloadState from settings
  - Skip already-downloaded moduleIds
  - Continue from next file
```

### Storage Estimates

| Content | Size | Notes |
|---------|------|-------|
| App shell (HTML + CSS + JS) | ~150KB | Cached by service worker |
| Fonts (2 weights) | ~400KB | Cached by service worker |
| content.json (60 modules) | ~200KB | Stored in IndexedDB |
| Audio per grade band (15 files) | ~21MB | Stored as blobs in IndexedDB |
| Audio all 60 modules | ~84MB | Only download selected band |
| Image cards (60 files) | ~3MB | Cached by service worker |
| **Total (one grade band)** | **~25MB** | Fits on 16GB phone |

### Storage Management
- Settings screen shows: "Wurin adanawa: 25.3 MB / 32 GB"
- Option: "Share sautukan darussa da ka gama" (Delete audio for completed modules)
- Deletes audio blobs from IndexedDB audioCache for modules with completedAt set
- Module metadata and progress are kept (tiny)

---

## 8. Content Pipeline

### Overview
Content team works in Google Sheets. Exports to CSV. CLI tool converts CSV → content.json.

```
Google Sheets ──► Export CSV ──► content-pipeline.js ──► content.json
                                      │
                                      ├── Validates all fields
                                      ├── Checks audio files exist
                                      ├── Tests formula syntax
                                      └── Outputs summary report
```

### CLI Tool (tools/content-pipeline.js)

```
COMMANDS:

  ingest    Convert CSV files to content.json bundle
            --input modules.csv
            --quizzes quizzes.csv
            --glossary glossary.csv
            --audio-dir ./audio/
            --output ../app/content.json

  validate  Dry run — check data without output
            --input modules.csv
            --quizzes quizzes.csv
            --glossary glossary.csv

  status    Show summary of existing content.json
            --input ../app/content.json
```

### Validation Rules
1. All required fields present and non-empty
2. module_number sequential within each grade_band
3. grade_band is one of: foundation, p1, p2, p3
4. Audio file exists in --audio-dir for each module
5. Each module has exactly 2 micro-pauses
6. Each module has exactly 5 quiz questions
7. Quiz formulas parse correctly (test with sample values)
8. No negative answers generated from quiz formulas (test 100 random instances)
9. No duplicate module numbers
10. Glossary term categories are valid
11. Related module IDs reference existing modules

---

## 9. Screen Architecture

### Navigation (Hash-Based SPA)

```
#onboarding     → Welcome + grade band selection
#learning-path  → Module list for selected grade band
#lesson/:id     → Audio player + text + micro-pauses
#quiz/:id       → 5-question randomized quiz
#quiz-results/:id → Score, stars, pass/fail
#progress       → Flame streak + grade band overview
#glossary       → Searchable term list
#glossary/:id   → Term detail
#settings       → Grade band, audio management, storage
#download       → Audio pack download progress
```

### Screen Flow

```
App Open
  │
  ├── First time? → #onboarding → #download → #learning-path
  │
  └── Returning? → #learning-path
                        │
                        ├── Tap module → #lesson/:id
                        │                    │
                        │                    └── "Fara Jarrabawa" → #quiz/:id
                        │                                              │
                        │                                              └── #quiz-results/:id
                        │                                                      │
                        │                                                      └── Back → #learning-path
                        │
                        ├── Nav: Progress → #progress
                        │
                        ├── Nav: Glossary → #glossary
                        │
                        └── Nav: Settings → #settings
```

### Bottom Navigation Bar

```
┌──────────┬──────────┬──────────┬──────────┐
│  Koyo    │ Ci gaba  │ Kalmomi  │ Saituna  │
│ (Learn)  │(Progress)│(Glossary)│(Settings)│
│   📖     │   🔥     │   📝     │   ⚙️     │
└──────────┴──────────┴──────────┴──────────┘
```

---

## 10. Performance Budgets

| Metric | Target | Measured On |
|--------|--------|-------------|
| First Contentful Paint | < 2s | Samsung Galaxy A03, 3G |
| Time to Interactive | < 3s | Samsung Galaxy A03, 3G |
| App shell size (compressed) | < 150KB | gzip |
| IndexedDB read latency | < 50ms | Module metadata lookup |
| Audio start latency | < 500ms | From IndexedDB blob |
| Quiz generation time | < 100ms | 5 questions with variants |
| Lighthouse Performance score | > 80 | Mobile audit |
| Total JS (uncompressed) | < 200KB | No framework overhead |

### Low-End Device Constraints
- **1GB RAM (Nokia C01 Plus):** Keep DOM node count under 500. No heavy animations. Lazy-load module lists.
- **16GB storage:** One grade band (~25MB) fits. Warn if < 500MB free before download.
- **2G network (50kbps):** Content.json (~200KB) downloads in ~30s. Single audio file (~1.4MB) in ~3.5 minutes. Full grade band (~21MB) in ~56 minutes — show "connect to WiFi" recommendation.

---

## 11. Security Considerations

| Concern | Mitigation |
|---------|------------|
| Formula injection via quiz templates | Whitelist regex: only digits, operators, parentheses allowed before eval |
| Content.json tampering | SRI hash on content.json (future). Content authored by trusted team only. |
| Malicious service worker | Service worker served from same origin. CSP headers restrict script sources. |
| Local data privacy | No PII collected. No phone number. No account. Device-local only. |
| Audio file integrity | File size validation on download. Corrupted files trigger re-download. |

---

## 12. Future Architecture (Phase 3+)

When a backend is needed (for progress sync, teacher dashboards, multi-device):

```
Phase 3 additions:
  ├── server/
  │   ├── server.js        (Fastify, mirrors Konfirmata pattern)
  │   ├── src/routes/
  │   │   ├── auth.js      (OTP via phone, optional)
  │   │   ├── progress.js  (POST /sync, GET /progress)
  │   │   └── content.js   (GET /modules, versioned)
  │   └── migrations/
  │       └── 001_baseline.sql
  └── Railway deployment (Node.js + PostgreSQL)
```

The current IndexedDB schema is designed to be forward-compatible with server sync. The `progress` store structure maps directly to a future `module_progress` PostgreSQL table. Adding sync means adding a `syncQueue` IndexedDB store and a sync worker — the same pattern used in Konfirmata.
