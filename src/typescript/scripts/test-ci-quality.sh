#!/usr/bin/env bash
set -u

pnpm db:check:migration-drift &
pid_drift=$!

pnpm run test:unit:shared:coverage &
pid_shared=$!

pnpm run test:unit:extension:coverage &
pid_extension=$!

pnpm --filter @openerrata/api run test:merged:coverage &
pid_api=$!

pnpm run test:unit:pulumi &
pid_pulumi=$!

pnpm --filter @openerrata/frontend run test:unit &
pid_frontend=$!

status=0
wait "$pid_drift" || status=$?
wait "$pid_shared" || status=$?
wait "$pid_extension" || status=$?
wait "$pid_api" || status=$?
wait "$pid_pulumi" || status=$?
wait "$pid_frontend" || status=$?
exit "$status"
