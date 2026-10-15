# Q & M Lawncare

Marketing site for Q & M Lawncare (Quinlan Marsh) with an owner portal at
`/admin` for uploading and managing gallery photos.

- `public/index.html` — the original hand-built page. The gallery is filled
  in by the server at the `<!--GALLERY_FILTERS-->` / `<!--GALLERY_SECTIONS-->`
  markers using the same markup the static site had.
- `public/admin.*` — the owner portal.
- `server/` — Express + Neon Postgres. Login copied from Classic Cleanz.
- `seed/` — the 18 launch photos, imported once on first boot.

Run locally: copy `.env.example` to `.env`, fill it in, `npm install`,
`npm run dev`. Deploying: see [DEPLOY.md](DEPLOY.md).
