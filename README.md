# SoleMart Backend API

Node.js + Express + PostgreSQL backend for the SoleMart shoe rental, authentication and cleaning platform.

---

## Quick Start

### Prerequisites
- Node.js 18+
- PostgreSQL 15+
- A Stripe account (test keys are fine to start)

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
# Fill in your values — DATABASE_URL and JWT_SECRET are the minimum required to run
```

### 3. Create the database
```bash
createdb solemart
npm run db:migrate     # runs db/schema.sql
npm run db:seed        # creates demo users and shoes
```

### 4. Start the server
```bash
npm run dev            # nodemon — restarts on changes
npm start              # production
```

The API runs on `http://localhost:3001` by default.

---

## Architecture

```
solemart-backend/
├── server.js               # Express app, middleware, route mounting
├── config/
│   ├── db.js               # PostgreSQL connection pool
│   └── logger.js           # Winston logger
├── middleware/
│   ├── auth.js             # JWT authenticate, requireRole, optionalAuth
│   └── errorHandler.js     # Global error handler
├── routes/
│   ├── auth.js             # Register, login, refresh, logout, /me
│   ├── users.js            # Profile update, bank details
│   ├── shoes.js            # Browse, single shoe, owner listings, delist
│   ├── submissions.js      # Multi-shoe listing submissions
│   ├── orders.js           # Create order, list orders, initiate return
│   ├── cleans.js           # Book a clean, list bookings, cancel
│   ├── reviews.js          # Submit and fetch reviews
│   ├── admin.js            # Dashboard, intake queue, auth/clean/reject/dispatch
│   ├── payouts.js          # Owner payout history and summary
│   ├── postcodes.js        # Postcode lookup proxy
│   └── webhooks.js         # Stripe webhook handler
├── services/
│   ├── email.js            # All transactional email templates (Nodemailer)
│   ├── stripe.js           # Stripe payment intent and refund helpers
│   ├── label.js            # Shipping label generation (PDF stub)
│   └── activityLog.js      # Audit trail writer
└── db/
    ├── schema.sql          # Full PostgreSQL schema
    └── seed.js             # Development seed data
```

---

## User Roles

| Role       | Access                                                     |
|------------|------------------------------------------------------------|
| `customer` | Browse, order, book cleans, review, manage their account   |
| `owner`    | All customer permissions + list shoes, view payouts        |
| `staff`    | All owner permissions + full admin queue and intake tools  |
| `admin`    | Full access including user management                      |

---

## API Reference

All routes are prefixed with `/api`.

### Auth
| Method | Route            | Auth     | Description                    |
|--------|------------------|----------|--------------------------------|
| POST   | /auth/register   | —        | Create account                 |
| POST   | /auth/login      | —        | Login, get tokens              |
| POST   | /auth/refresh    | —        | Rotate refresh token           |
| POST   | /auth/logout     | Required | Revoke all refresh tokens      |
| GET    | /auth/me         | Required | Current user profile           |

### Shoes
| Method | Route                | Auth      | Description                     |
|--------|----------------------|-----------|---------------------------------|
| GET    | /shoes               | Optional  | Browse listed shoes (paginated) |
| GET    | /shoes/:id           | Optional  | Single shoe with reviews        |
| GET    | /shoes/owner/mine    | Required  | Owner's own listings            |
| PATCH  | /shoes/:id           | Required  | Update price / description      |
| POST   | /shoes/:id/delist    | Required  | Request delist                  |

**Query params for GET /shoes:**
- `q` — text search (brand, model, colour)
- `type` — `rent` | `buy` | `both` | `all`
- `condition` — `Brand New` | `Like New` | `Very Good` | `Good`
- `size` — UK size string
- `sort` — `newest` | `price-asc` | `price-desc` | `auth`
- `page`, `limit` — pagination

### Listing Submissions
| Method | Route            | Auth     | Description                         |
|--------|------------------|----------|-------------------------------------|
| POST   | /submissions     | Required | Submit multiple shoes for listing   |
| GET    | /submissions     | Required | Owner's submission history          |
| GET    | /submissions/:id | Required | Single submission + shoes           |

### Orders
| Method | Route                 | Auth     | Description                   |
|--------|-----------------------|----------|-------------------------------|
| POST   | /orders               | Required | Create rental or purchase     |
| GET    | /orders               | Required | Customer's order history      |
| GET    | /orders/:id           | Required | Single order detail           |
| POST   | /orders/:id/return    | Required | Initiate rental return        |

### Clean Bookings
| Method | Route          | Auth     | Description                        |
|--------|----------------|----------|------------------------------------|
| POST   | /cleans        | Optional | Book a clean (logged in or guest)  |
| GET    | /cleans        | Required | Customer's clean bookings          |
| GET    | /cleans/:id    | Required | Single booking                     |
| DELETE | /cleans/:id    | Required | Cancel booking                     |

### Reviews
| Method | Route                  | Auth     | Description              |
|--------|------------------------|----------|--------------------------|
| POST   | /reviews               | Required | Submit a review          |
| GET    | /reviews/shoe/:shoeId  | —        | Reviews for a shoe       |

### Users
| Method | Route         | Auth     | Description              |
|--------|---------------|----------|--------------------------|
| PATCH  | /users/me     | Required | Update profile           |
| POST   | /users/me/bank| Required | Save bank details        |

### Payouts
| Method | Route            | Auth     | Description              |
|--------|------------------|----------|--------------------------|
| GET    | /payouts         | Required | Owner payout history     |
| GET    | /payouts/summary | Required | Payout totals            |

### Admin (staff + admin only)
| Method | Route                             | Description                   |
|--------|-----------------------------------|-------------------------------|
| GET    | /admin/dashboard                  | Counts, revenue summary       |
| GET    | /admin/queue                      | Intake processing queue       |
| POST   | /admin/shoes/:id/authenticate     | Record auth result            |
| POST   | /admin/shoes/:id/clean            | Record clean, set to listed   |
| POST   | /admin/shoes/:id/reject           | Reject with reason            |
| POST   | /admin/orders/:id/dispatch        | Mark dispatched + tracking    |
| GET    | /admin/users                      | All users (admin only)        |
| GET    | /admin/activity                   | Audit log                     |

### Utility
| Method | Route               | Description                     |
|--------|---------------------|---------------------------------|
| GET    | /postcodes/:postcode| Postcode lookup (proxies API)   |
| POST   | /webhooks/stripe    | Stripe webhook receiver         |
| GET    | /health             | Health check                    |

---

## Authentication Flow

1. `POST /auth/register` or `POST /auth/login` → returns `accessToken` (15 min) + `refreshToken` (30 days)
2. Include `Authorization: Bearer <accessToken>` on all authenticated requests
3. When access token expires (401 + `code: TOKEN_EXPIRED`), call `POST /auth/refresh` with `{ refreshToken }` → new token pair (rotation)
4. `POST /auth/logout` revokes all refresh tokens for the user

---

## Database Schema Summary

| Table                 | Purpose                                              |
|-----------------------|------------------------------------------------------|
| `users`               | All users (customers, owners, staff, admin)          |
| `owner_bank_details`  | AES-256 encrypted bank details for payouts           |
| `shoes`               | Every shoe on the platform with full lifecycle state |
| `shoe_photos`         | Photos linked to shoes (S3/R2 URLs)                  |
| `listing_submissions` | Multi-shoe owner intake submissions                  |
| `submission_shoes`    | Junction: submissions ↔ shoes                        |
| `orders`              | Rental and purchase orders with Stripe refs          |
| `payouts`             | Owner earnings per order (85%)                       |
| `clean_bookings`      | Public cleaning service bookings                     |
| `reviews`             | One review per order                                 |
| `activity_log`        | Full audit trail (JSONB meta)                        |
| `refresh_tokens`      | JWT refresh token rotation with revocation           |

---

## Connecting the Frontend

Replace the `localStorage` calls in `solemart-customer.html` with `fetch()` calls to the API.

Example — loading shoes on browse:
```js
// Replace: const shoes = loadShoes()
const res = await fetch('http://localhost:3001/api/shoes?sort=newest&limit=20');
const { shoes } = await res.json();
```

Example — login:
```js
const res = await fetch('http://localhost:3001/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password }),
});
const { user, accessToken, refreshToken } = await res.json();
// Store tokens in memory (accessToken) and httpOnly cookie (refreshToken)
```

---

## What to Plug In Next

| Feature           | What to do                                                    |
|-------------------|---------------------------------------------------------------|
| **Payments**      | Add Stripe.js to frontend, use `clientSecret` from POST /orders |
| **File uploads**  | Add `multer` + AWS S3 / Cloudflare R2 for shoe photos         |
| **Real labels**   | Replace `label.js` stub with `pdfkit` or Puppeteer PDF gen    |
| **Postcode data** | Swap postcodes.io for GetAddress.io for full address lists    |
| **Email**         | Point SMTP settings at SendGrid / Resend / AWS SES            |
| **Hosting**       | Railway, Render or Fly.io — all support Node + Postgres       |
