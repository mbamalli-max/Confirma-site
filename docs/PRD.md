# Product Requirements Document (PRD)
**Project:** Konfirmata
**Date:** 2026-04-04

---

## Global Availability

Konfirmata supports a global country selector at onboarding.

Users may select any country from the ISO 3166-1 alpha-2 list. Country selection does not imply full feature parity across all regions.

Country availability is separated into three independent dimensions:

1. `phone_country`
   - Derived from the phone number prefix at OTP verification.
   - Governs phone number normalization only.

2. `operating_region`
   - Selected by the user during onboarding.
   - Defines business context, default currency, and availability of region-specific features such as payment integrations.

3. `language`
   - Selected independently of country.
   - Defines UI language and voice recognition configuration.

At launch, Konfirmata supports a limited set of languages. All other users default to English.

Example:
- `phone_country = NG`
- `operating_region = US`
- `language = en`

This is valid and supported.

---

## UI / UX Requirements

- Country dropdown shows all countries in the ISO 3166-1 alpha-2 list.
- No country is hidden because a feature is unsupported there.
- Unsupported regions display: "Some features are not yet available in your region".
- Language selector is separate from country.
- Default language is English.
- The app must not auto-switch language based on country.

---

## Constraints

- Do not restrict the country list based on SMS availability.
- Do not tie language availability to country.
- Do not infer currency from `phone_country`.
- Do not block users from selecting any country.

---

## Acceptance Tests

1. User selects any country such as Brazil, Germany, or Kenya and onboarding completes successfully.
2. Unsupported region such as `US` hides Paystack, keeps free export available, and report generation does not crash.
3. Language defaults to English when no local language pack exists.
4. Phone prefix remains independent of `operating_region`.
5. Currency follows `operating_region`, not `phone_country`.

---

## Implementation Notes

- Use a full ISO country list for the selector from static JSON or a maintained dataset.
- Do not filter the list based on capability.
- Store `operating_region` in the profile.
- Store `language` independently.
- Derive currency from `operating_region`.
