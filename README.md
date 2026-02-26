# Ekklesia — Backend

Express.js REST API with PostgreSQL and real-time Socket.io for the Ekklesia event check-in system.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20 |
| Framework | Express.js 4 |
| Database | PostgreSQL 16 |
| Real-time | Socket.io 4 |
| File parsing | xlsx (SheetJS) |
| File upload | Multer |
| Password hashing | bcryptjs |
| Validation | express-validator |

---

## Project Structure

```
backend/
├── src/
│   ├── index.js        # Entry point — Express app, Socket.io setup, server start
│   ├── db.js           # PostgreSQL connection pool (pg)
│   ├── migrate.js      # Auto-runs on startup — creates tables and indexes
│   └── routes/
│       ├── events.js   # CRUD for events + password verification
│       └── attendees.js # CRUD for attendees + CSV/Excel import + check-in
├── Dockerfile
└── package.json
```

---

## Database Schema

### `events`

| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL PK | |
| `name` | VARCHAR(255) | Required |
| `description` | TEXT | Optional |
| `date` | DATE | Optional |
| `time` | TIME | Optional |
| `location` | VARCHAR(255) | Optional |
| `password_hash` | VARCHAR(255) | bcrypt hash; `NULL` = unprotected |
| `created_at` | TIMESTAMP | |
| `updated_at` | TIMESTAMP | |

### `attendees`

| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL PK | |
| `event_id` | INTEGER FK | Cascades on event delete |
| `name` | VARCHAR(255) | Required |
| `phone_number` | VARCHAR(50) | Optional |
| `email` | VARCHAR(255) | Optional |
| `checked_in` | BOOLEAN | Default `false` |
| `checked_in_at` | TIMESTAMP | Set on check-in, cleared on undo |
| `created_at` | TIMESTAMP | |
| `updated_at` | TIMESTAMP | |

Indexes: `event_id`, `LOWER(name)`, `phone_number`.

---

## API Reference

Base path: `/api`

### Events

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/events` | List all events with attendee stats |
| `GET` | `/events/:id` | Get single event with stats |
| `POST` | `/events` | Create event |
| `PUT` | `/events/:id` | Update event |
| `DELETE` | `/events/:id` | Delete event and all its attendees |
| `POST` | `/events/:id/verify-password` | Verify password for a protected event |

#### `POST /events` body

```json
{
  "name": "Youth Conference 2025",
  "date": "2025-08-10",
  "time": "09:00",
  "location": "Main Hall",
  "description": "Annual youth gathering",
  "password": "secret123"
}
```

Only `name` is required. Omit or leave `password` empty for an unprotected event.

#### `POST /events/:id/verify-password` body

```json
{ "password": "secret123" }
```

Returns `200` on success, `401` on wrong password.

---

### Attendees

All attendee routes are nested under `/events/:eventId/attendees`.

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/events/:eventId/attendees` | List attendees (supports `?search=` and `?checked_in=true/false`) |
| `POST` | `/events/:eventId/attendees` | Add single attendee |
| `POST` | `/events/:eventId/attendees/import` | Import attendees from CSV / XLS / XLSX |
| `PATCH` | `/events/:eventId/attendees/:id/checkin` | Check in an attendee |
| `PATCH` | `/events/:eventId/attendees/:id/undo-checkin` | Undo a check-in |
| `DELETE` | `/events/:eventId/attendees/:id` | Delete single attendee |
| `DELETE` | `/events/:eventId/attendees` | Delete all attendees for an event |

#### Import file format

The import endpoint accepts `multipart/form-data` with a `file` field. Supported formats: `.csv`, `.xls`, `.xlsx`.

Column headers are matched **case-insensitively** and by keyword. The following headers are recognised:

| Field | Recognised header keywords |
|---|---|
| Name (**required**) | `name`, `full name`, `fullname`, `nama`, `nama lengkap`, `your name`, `participant name` |
| Phone | `phone`, `phone number`, `hp`, `no hp`, `nomor hp`, `whatsapp`, `no telepon`, `handphone` |
| Email | `email`, `email address`, `e-mail` |

Rows with a blank name are skipped. All inserts run inside a single transaction — if anything fails, the entire import is rolled back.

---

## Real-time Events (Socket.io)

Clients join a per-event room by emitting `join_event` with the event ID as a string. The server broadcasts the following events to that room:

| Event | Payload | Trigger |
|---|---|---|
| `attendee:checked_in` | `{ eventId, attendee, stats }` | Attendee checked in |
| `attendee:unchecked` | `{ eventId, attendee, stats }` | Check-in undone |
| `attendee:added` | `{ eventId, attendee, stats }` | Single attendee added |
| `attendee:deleted` | `{ eventId, attendeeId, stats }` | Attendee deleted |
| `attendees:imported` | `{ eventId, imported, skipped, stats }` | Bulk import completed |
| `attendees:cleared` | `{ eventId, stats }` | All attendees deleted |

`stats` shape: `{ total_attendees: number, checked_in_count: number }`

---

## Environment Variables

Create a `.env` file in the `backend/` directory:

```env
PORT=4000
DB_HOST=localhost
DB_PORT=5432
DB_NAME=event_management
DB_USER=postgres
DB_PASSWORD=your_password
FRONTEND_URL=http://localhost:3000
```

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4000` | HTTP server port |
| `DB_HOST` | `localhost` | PostgreSQL host |
| `DB_PORT` | `5432` | PostgreSQL port |
| `DB_NAME` | `event_management` | Database name |
| `DB_USER` | `postgres` | Database user |
| `DB_PASSWORD` | _(empty)_ | Database password |
| `FRONTEND_URL` | `http://localhost:3000` | Allowed CORS origin |

---

## Running Locally

### Prerequisites

- Node.js 20+
- PostgreSQL 16+ running locally

### Steps

```bash
# 1. Install dependencies
cd backend
npm install

# 2. Create the .env file (see above)

# 3. Start in development mode (nodemon auto-reload)
npm run dev

# 4. Or start in production mode
npm start
```

The database tables are created automatically on first start via `migrate.js`. No manual migration step is needed.

### Health check

```
GET http://localhost:4000/api/health
```

Returns server status and current connected Socket.io client count.

---

## Running with Docker

From the project root (see `docker-compose.yml`):

```bash
docker compose up --build
```

This starts PostgreSQL, the backend (port `4000`), and the frontend (port `3000`) together. The backend waits for the database health check to pass before starting.

---

## Password Protection

Event passwords are hashed with **bcrypt** (cost factor 10) before storage. The plaintext password is never stored or logged. The `password_hash` column is always stripped from API responses — clients only receive the boolean `is_protected` flag.