# SupaForge, with the PostgreSQL client tools --prove uses.
#
#   docker run --rm -v "$PWD:/work" -e PROD_DATABASE_URL ghcr.io/akalsoftware/supaforge diff
#
# Built from the published npm package, so the image is exactly what
# `npm install -g @akal/supaforge@<version>` gives.
FROM node:22-alpine

ARG SUPAFORGE_VERSION

# pg_dump 18 reads every PostgreSQL version Supabase runs.
RUN apk add --no-cache postgresql18-client \
 && npm install -g --omit=dev --no-audit --no-fund "@akal/supaforge@${SUPAFORGE_VERSION}" \
 && npm cache clean --force \
 && ln -s "$(find "$(npm root -g)/@akal/supaforge/node_modules/@dbdiff" -path '*-musl/dbdiff' -type f)" /usr/local/bin/dbdiff \
 && dbdiff --version && supaforge --version

# SupaForge's diff engine, called directly: the musl build npm installed for
# Alpine, also on PATH as `dbdiff`.
ENV SUPAFORGE_DBDIFF_BIN=/usr/local/bin/dbdiff

LABEL org.opencontainers.image.title="SupaForge" \
      org.opencontainers.image.description="Find and fix drift between Supabase environments" \
      org.opencontainers.image.source="https://github.com/akalsoftware/supaforge" \
      org.opencontainers.image.url="https://supaforge.dev" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${SUPAFORGE_VERSION}"

# Mount the project — supaforge.config.json and its snapshots — here.
WORKDIR /work
USER node
ENV NO_UPDATE_NOTIFIER=1
ENTRYPOINT ["supaforge"]
CMD ["--help"]
