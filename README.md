# masterapp

Purosangue ERP. Phase 1: the watch inventory, copied from Chrono Key and the
Watch vault and editable here: every field, every photo, with a history of who
changed what.

- **Inventory**: search by stock number, reference, serial, brand, model,
  supplier or client; filter by status, place and brand.
- **A watch**: every field, grouped; edit any of them; add photos by dropping,
  pasting or picking them, reorder, caption, remove; the full history; what
  Chrono Key and the vault hold for it; the same watch under its other stock
  numbers.
- **Import**: upload Chrono Key's Product List export, read each watch's page
  and photos live, import the Watch vault. Chrono Key stays the master until
  the switch-over. A field edited here is never overwritten by the sync.
- **Users**: viewer, editor and admin accounts.

See `CLAUDE.md` for how it works and why, and `.env.example` for settings.

**Run it on a PC**: install Node.js 20+ and Git, then double-click
`start-masterapp.cmd` (or `npm install` then `npm run local`). It brings its
own database, opens http://localhost:3300 and prints the first sign-in.

**On a server**:

```bash
npm install && cp .env.example .env && npm start
npm test   # needs a Postgres at TEST_DATABASE_URL; it is wiped
```
