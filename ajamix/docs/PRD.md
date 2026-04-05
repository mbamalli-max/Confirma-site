# AJAMIX — Product Requirements Document

## 1. Vision

AJAMIX is an offline-first mobile application that delivers mathematics education in Ajami (Arabic script for Hausa) to tsangaya students and adult learners across Northern Nigeria. It bridges the gap between the Islamic schooling system and formal numeracy by presenting mathematics in the script and language these learners already know.

The app covers Foundation Stage (pre-Primary 1) through SS3 Mathematics, starting with 60 modules covering Foundation through P3. Content is audio-primary with interactive micro-pause questions, randomized quizzes, and a flame streak engagement system — all functioning fully offline on low-end Android phones.

---

## 2. Target Users

### Primary: Tsangaya Students (Ages 8–18)
- Enrolled in traditional Islamic schools (tsangaya) across Northern Nigeria
- Literate in Ajami (Arabic script for Hausa) but with limited or no formal numeracy education
- Access to shared or personal low-end Android phones (Samsung Galaxy A03, Tecno Spark, Infinix Hot)
- Intermittent or no internet connectivity
- Hausa is their primary language; English may be limited

### Secondary: Adult Learners
- Market traders, artisans, and household managers in Northern Nigeria
- Functionally literate in Ajami but need practical numeracy skills
- Motivated by real-world applications: market calculations, household budgeting, fabric measurements
- Same device and connectivity constraints as primary users

### Tertiary: Mallams (Teachers)
- Traditional Islamic school teachers who oversee student learning
- Need visibility into student progress without complex dashboards
- May use the app to guide classroom sessions

---

## 3. User Stories

### Onboarding
- As a student, I want to select my grade level so I see content appropriate for my knowledge
- As a student, I want to use the app without creating an account so I can start learning immediately
- As an adult learner, I want to select adult mode so word problems use market/household contexts

### Learning
- As a student, I want to see a clear learning path so I know which topic to study next
- As a student, I want to listen to audio lessons in Hausa so I can learn through my strongest modality
- As a student, I want to see key terms in Ajami script so I connect mathematics to my existing literacy
- As a student, I want micro-pause questions during audio to keep me engaged and check my understanding
- As a student, I want to resume a lesson where I left off so I don't lose my place

### Assessment
- As a student, I want to take a quiz with different numbers each time so I can practice the concept, not memorize answers
- As a student, I want to see my score immediately after a quiz so I know if I understood the material
- As a student, I want to retake a quiz if I scored below 3/5 so I can improve before moving on

### Progress & Motivation
- As a student, I want to see my flame streak so I'm motivated to practice daily
- As a student, I want to see which modules I've completed so I can track my progress
- As a student, I want the next module to unlock after I pass a quiz so I feel a sense of achievement

### Glossary
- As a student, I want to look up mathematical terms in Ajami, Hausa, and English so I can build my vocabulary
- As a student, I want to tap a term during a lesson to see its definition without leaving the lesson

### Offline
- As a student, I want to download all audio for my grade level at once so I can learn without internet
- As a student, I want the app to work completely offline after the initial download
- As a student, I want to delete audio for completed modules to free up phone storage

---

## 4. Feature Requirements

### 4.1 Content Delivery

| Feature | Priority | Description |
|---------|----------|-------------|
| Learning path UI | P0 | Vertical scrolling path showing all modules in selected grade band. States: locked, available (pulsing gold), in-progress, completed (green checkmark). |
| Audio lessons | P0 | 3-minute Hausa audio explanations. MP3 64kbps mono. Play/pause/seek controls. Resume from last position. |
| Text explanations | P0 | Full Hausa text explanation displayed below audio player. Scrollable. |
| Ajami key term cards | P0 | Image cards showing key mathematical terms in Ajami script. Displayed in lesson view. |
| Micro-pause questions | P0 | 2 questions per lesson that interrupt audio at predefined timestamps. Multiple choice. Response time recorded. |
| Grade band selection | P0 | Foundation, P1, P2, P3. Selected during onboarding. Changeable in settings. |
| Adult learner mode | P1 | Alternative word problem contexts (market, household, fabric) for the same mathematical concepts. |
| Content updates | P1 | Detect new content versions when online. Non-intrusive update banner. |

### 4.2 Assessment

| Feature | Priority | Description |
|---------|----------|-------------|
| Randomized quizzes | P0 | 5 questions per module. Parameterized templates with variable ranges. Client-side generation. |
| Auto-grading | P0 | Immediate scoring. Green/red feedback per question. Final score with star rating. |
| Pass/fail gating | P0 | Score >= 3/5 unlocks next module. Below 3/5 offers retake. |
| Quiz history | P1 | Best score, attempt count, last attempt date per module. |

### 4.3 Progress & Engagement

| Feature | Priority | Description |
|---------|----------|-------------|
| Flame streak | P0 | Visual indicator: bright (active today), dim (2 days inactive), out (5+ days inactive). Streak day counter. |
| Module progress | P0 | Audio listen %, micro-pause accuracy, quiz score per module. |
| Grade band progress | P0 | Progress bar showing completed/total modules per grade band. |

### 4.4 Glossary

| Feature | Priority | Description |
|---------|----------|-------------|
| Glossary browser | P1 | Searchable by Ajami, Hausa, or English. Shows definition, category, related modules. |
| In-lesson glossary | P2 | Tap a term during lesson to see its definition inline. |

### 4.5 Offline & Storage

| Feature | Priority | Description |
|---------|----------|-------------|
| App shell caching | P0 | Service worker caches HTML, CSS, JS, fonts for instant offline load. |
| Content bundle download | P0 | Download content.json with all module metadata, quiz templates, glossary on first launch. |
| Audio pack download | P0 | Download all audio files for selected grade band. Sequential download with per-file progress. Resumable. |
| Storage management | P1 | Show storage used. Option to delete audio for completed modules. |
| Streaming fallback | P2 | Stream audio on-demand if not pre-downloaded (requires network). |

---

## 5. Content Model

### Module Structure
Each module contains:
- **Identifiers:** module number, slug, grade band
- **Titles:** Hausa, Ajami, English
- **Text explanation:** Full Hausa text
- **Audio:** 3-minute MP3 file (64kbps mono, ~1.4MB)
- **Image card:** Ajami key terms visual (WebP, ~50KB)
- **Micro-pauses:** 2 per module, each with: timestamp (ms), question (Hausa), correct answer, options
- **Quiz questions:** 5 per module, each with: template (Hausa), answer formula, variable ranges, distractor formulas
- **Metadata:** curriculum reference (NERDC/WAEC), status, sort order

### Grade Bands

| Band | Modules | Topics |
|------|---------|--------|
| Foundation | 1–15 | Number recognition 1–100, counting, one-to-one correspondence, basic shapes, simple patterns |
| P1 | 16–30 | Addition/subtraction to 20, place value, measurement, time, money (naira) |
| P2 | 31–45 | Addition/subtraction to 100, multiplication intro, fractions (half, quarter), basic geometry |
| P3 | 46–60 | Multiplication tables, division, fractions, measurement units, basic data handling |

### Curriculum Alignment
- **Primary (Foundation–P6):** NERDC Basic Education Curriculum (BEC) Mathematics
- **Junior Secondary (JSS1–3):** NERDC Junior Secondary Curriculum
- **Senior Secondary (SS1–3):** WAEC/NECO Mathematics Syllabus

### Ajami Technical Glossary
- Target: 100–150 terms by end of Phase 1
- Each term: Ajami script, Hausa transliteration, English equivalent, definition in Hausa, category, related modules
- Categories: Lissafi (Arithmetic), Geometry, Auna (Measurement), Gabadaya (General)
- Reviewed and approved by TIMSAN members
- Standalone asset with value beyond the app

### Adult Learner Variants
- Same mathematical concepts as child modules
- Different word problem contexts: market calculations, household budgeting, fabric measurements, transport fare calculations
- Same quiz templates with adult-appropriate variable ranges (larger numbers, naira amounts)
- Adds ~15 minutes production time per module

---

## 6. Accessibility Requirements

| Requirement | Implementation |
|-------------|----------------|
| Audio-primary content | All core learning delivered via audio for pre-literate or limited-literacy learners |
| Large tap targets | All interactive elements minimum 48px height. Quiz options minimum 56px. |
| High contrast | Dark text on cream background. Gold accent on deep green. WCAG AA contrast ratios. |
| Ajami readability | Noto Naskh Arabic font at minimum 1.25rem (20px) with 1.8 line-height |
| Low-end device support | Target: 1GB RAM, 16GB storage. App shell < 500KB. No heavy animations. |
| Offline-first | Full functionality after initial content download. No features require persistent connectivity. |
| Low bandwidth | Content packs downloadable on 2G (50kbps). Resumable downloads. Total ~22MB per grade band. |

---

## 7. Success Metrics

### Pilot Phase (3–5 tsangaya schools, 4 weeks)

| Metric | Target |
|--------|--------|
| Module completion rate | > 60% of started modules completed |
| Quiz pass rate (2nd attempt) | > 70% average score |
| Daily active users | > 50% of enrolled students active 3+ days/week |
| Audio listen-through rate | > 80% of audio listened per module |
| Content download success | > 90% complete grade band downloads without failure |
| Flame streak engagement | > 40% of students maintain 3+ day streaks |
| Mallam satisfaction | Positive qualitative feedback from 3+ of 5 mallams |

### Post-Pilot Growth

| Metric | Target |
|--------|--------|
| Schools onboarded (6 months) | 20+ tsangaya schools |
| Active learners | 500+ monthly active students |
| Content coverage | 120+ modules (through P6) |
| Glossary terms | 200+ reviewed terms |
| Adult learner adoption | 50+ active adult learners |

---

## 8. Non-Requirements (Explicit Exclusions)

- **No user accounts or login** — device-local identity only (Phase 1)
- **No backend server** — content delivered as static JSON bundle (Phase 1)
- **No social features** — no leaderboards, sharing, or messaging
- **No payment or subscription** — free for all users
- **No English-language interface** — Hausa and Ajami only
- **No video content** — audio and text only (bandwidth constraint)
- **No iOS optimization** — Android-first (target market reality)
- **No real-time sync** — progress is device-local until backend is added later

---

## 9. Content Production Pipeline

### Team
- **Content author:** Drafts modules in Hausa with AI assistance for structure
- **TIMSAN reviewers (2–3):** Review technical terms, subject accuracy, Ajami rendering
- **Fityanul Islam contact:** Provides access to pilot tsangaya schools

### Weekly Rhythm (Phase 1: Weeks 4–9)
- **Monday–Thursday:** Draft 2 modules per day (8 per week)
- **Friday:** Send batch to TIMSAN reviewers. Update glossary. Incorporate previous week's feedback.

### Production Target
- 2 modules/day x 5 days/week x 6 weeks = 60 modules
- Bottleneck: audio recording and TIMSAN review (not writing)

### Tools
- **Google Sheets:** Content Bible spreadsheet (topic map, all module data)
- **content-pipeline.js:** CLI tool converting CSV exports to content.json bundles
- **WhatsApp group:** TIMSAN reviewer communication
- **Shared Google Doc:** Ajami Technical Glossary with approval tracking

### Go/No-Go Gates

**Phase 0 Gate (end of Week 3):**
- One complete module meeting quality standard?
- At least 2 TIMSAN reviewers responsive within 5 days?
- Fityanul Islam positive initial response?

**Phase 1 Gate (end of Week 9):**
- 60 complete, TIMSAN-reviewed modules? (minimum 40 to proceed)
- Glossary at 100+ terms?
- Fityanul Islam confirmed one tsangaya for testing?

**Phase 2 Gate (end of Week 12):**
- Student on cheapest phone can complete full flow offline?
- Audio, micro-pauses, quiz, flame streak all functional?

---

## 10. Future Roadmap (Post-Pilot)

| Phase | Scope |
|-------|-------|
| Phase 3 | P4–P6 modules (60 more). Backend server for progress sync. Teacher dashboard. |
| Phase 4 | JSS1–JSS3 modules. Multi-device sync via phone number. Basic analytics. |
| Phase 5 | SS1–SS3 modules (WAEC/NECO aligned). Offline peer comparison. Certificate generation. |
| Phase 6 | SEDA integration: full Temporal Micro-Signature analysis, Structural Decay Engine with predictive modeling, evidence hierarchy beyond AUTO_VERIFIED. |
