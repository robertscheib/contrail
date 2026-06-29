# Updating radar-dash (Docker)

When the dashboard header shows an **"↑ Update"** badge, a newer version has been
published. Your flight data, stats databases, and settings all live in the mounted
`./data` volume, so updating the container is safe and non-destructive.

## Docker Compose (recommended)

From the directory containing your `docker-compose.yml`:

```bash
docker compose pull          # fetch the latest image
docker compose up -d         # recreate the container with the new image
docker image prune -f        # (optional) remove the old image layers
```

That's it — `./data` is reattached automatically, so your history and settings carry over.

## Plain `docker run`

```bash
docker pull tempeduck/radar-dash:latest

docker stop radar-dash && docker rm radar-dash

docker run -d --name radar-dash \
  -p 3010:3010 \
  -v "$(pwd)/data:/app/data" \
  --env-file .env \
  --restart unless-stopped \
  tempeduck/radar-dash:latest
```

## Verifying the update

- The header **"↑ Update"** badge disappears once you're on the latest version.
- Or check the running version: `curl -s localhost:3010/api/update` →
  `{"current":"…","latest":"…","updateAvailable":false,…}`.

## Notes

- **Pin a version** instead of `latest` by using a tag (e.g. `tempeduck/radar-dash:1.9.0`)
  if you prefer to control exactly when you upgrade.
- **Back up** `./data` before a major upgrade if you want a restore point —
  copying the folder while the container is stopped is sufficient.
- The update check is best-effort and can be turned off with `UPDATE_CHECK_ENABLED=false`.
  It only reads a published version number; it never auto-updates anything.
- Self-hosting a fork? Point `UPDATE_CHECK_URL` at your own `raw…/package.json` and
  `UPDATE_DOC_URL` at your own instructions.
