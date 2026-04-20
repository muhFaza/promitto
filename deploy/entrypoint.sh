#!/bin/sh
# Apply any pending migrations, then start the server.
set -e
cd /app/backend
node dist/db/migrate.js
exec node dist/main.js
