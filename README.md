# Link Africa — Kenya marketplace MVP

This is the working full-stack foundation for Link Africa: goods + services, buyer/seller accounts, seller profiles, listings, protected order states, 15% commission calculation, order chat, disputes, payout records, and payment-provider integration boundaries.

## Run locally
1. Install Node.js 20+.
2. Copy `.env.example` to `.env`.
3. Set a strong `JWT_SECRET` and `WEBHOOK_SECRET`.
4. Run `npm install`.
5. Run `npm start`.
6. Open `http://localhost:3000`.

A development-only demo seller is seeded on an empty database. Change/remove the demo credentials before any real deployment.

## Payment architecture
The app is designed so buyer payment is confirmed by a provider callback before the order becomes `paid`. The seller can only mark a paid order completed. The buyer can then approve it, which creates a pending seller payout record for the 85% balance after the 15% Link Africa commission.

M-Pesa Daraja credentials are read from environment variables only. No PIN, OTP, consumer secret, passkey, or initiator credential should ever be placed in the frontend or committed to source control.

### Current live-money status
**Not live yet.** The application currently stops at the payment integration boundary. To enable real money movement, Link Africa needs approved merchant/provider accounts, production credentials, public HTTPS callback URLs, signed/idempotent webhook processing, reconciliation, and payout authorization. Safaricom's current Daraja documentation confirms sandbox testing and production onboarding requirements, including the appropriate M-Pesa account/short code and callback setup.

## Production hardening still required
- Managed PostgreSQL/database + backups instead of SQLite
- HTTPS, secrets manager and environment separation
- Real Daraja M-Pesa Express + B2C adapters and signed callback verification
- Airtel Money, card and bank provider adapters
- OTP/email verification and KYC/identity workflow
- Delivery partner API + tracking
- Refund/reversal rules and admin dispute resolution
- Rate limiting, fraud/risk controls, audit logs and monitoring
- Object storage for product images/files
- Privacy policy, terms, seller agreement and Kenyan legal/tax/compliance review
