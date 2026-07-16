# Local UI preview

Run the dashboard with deterministic mock applications and no login, Docker, or SQLite:

```bash
npm run preview
```

Open <http://localhost:4173>. Set `PREVIEW_PORT` to use another port. This command only serves local fixtures; production continues to use `npm start`.
