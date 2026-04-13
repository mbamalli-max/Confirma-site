# Konfirmata — Developer Handover

## Active Folders
- app-v3/       → PWA app (deploys to Vercel)
- website-v2/   → Marketing site (deploys to Vercel)
- server/       → Fastify backend (deploys to Railway)
- docs/         → PRD, TAS, implementation plans

## Start Here
Read docs/PRD.md and docs/TAS.md before touching any code.

## Environment Variables Required
- PAYSTACK_SECRET_KEY
- TERMII_API_KEY
- RESEND_API_KEY
- DATABASE_URL (PostgreSQL)
- JWT_SECRET
- ALLOW_DEV_OTP=false (production)

## Recent Changes
- Website copy simplified for Nigerian traders
- OG/Twitter meta tags added to all pages
- Sync status badge added to app nav
- Service worker updated to stale-while-revalidate (cache-v4)
- Testimonial section added to homepage
