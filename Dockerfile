# Playground beta server. Build:  docker build -t forge-beta .
# Run:  docker run -p 8420:8420 forge-beta            (playground: writes allowed, resets on restart)
#       docker run -p 8420:8420 forge-beta --readonly (showcase: GET only)
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-yaml python3-jsonschema python3-pil git fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN git config --global user.name "playground" \
 && git config --global user.email "playground@beta" \
 && git config --global --add safe.directory /app \
 && (git rev-parse --git-dir >/dev/null 2>&1 || (git init -qb main && git add -A && git commit -qm "beta baseline"))
EXPOSE 8420
ENTRYPOINT ["node", "server.mjs", "--port", "8420"]
# Nightly sandbox reset (optional, host cron):
#   docker restart forge-beta   # container filesystem resets to image baseline if run with --rm + fresh start
