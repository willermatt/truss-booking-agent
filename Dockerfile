# For Railway (or any Docker host). Microsoft's Playwright image already has Chromium and the system
# libraries it needs. The tag must match the "playwright" version in package.json (1.63.0).
FROM mcr.microsoft.com/playwright:v1.63.0-noble

# tini as PID 1, so browser processes that exit are always cleaned up.
RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .

# The API listens on 8080 inside the container; the host's HTTPS proxy forwards to it.
ENV TRUSS_API_HOST=0.0.0.0 TRUSS_API_PORT=8080
EXPOSE 8080
ENTRYPOINT ["tini", "--"]
CMD ["npm", "run", "api"]
