# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation

FROM node:24-slim

# Install system dependencies for Chromium
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    postgresql \
    postgresql-client \
    sudo \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install agent-browser and claude-code globally
RUN npm install -g agent-browser @anthropic-ai/claude-code

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package*.json ./

# Install dependencies + googleapis for drive-tool.cjs and gmail-tool.cjs
RUN npm install && npm install googleapis

# Copy source code
COPY agent-runner/ ./

# Copy CLI tools (.cjs = CommonJS in ESM project)
COPY google-workspace-utils.cjs /app/google-workspace-utils.cjs
COPY drive-tool.cjs /app/drive-tool.cjs
COPY gmail-tool.cjs /app/gmail-tool.cjs
COPY github-token.cjs /app/github-token.cjs

# Build TypeScript
RUN npm run build

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input /workspace/output

# Create entrypoint script
# Container input (prompt, group info) is passed via stdin JSON.
# Credentials are injected by the host's credential proxy — never passed here.
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
# Git credential setup: GITHUB_INSTALLATION_TOKENS (JSON array of {account, token})
# configures git credential store so the agent can push to all installed repos.
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Move real gh binary so entrypoint can install a wrapper as /usr/bin/gh.
# This runs as root (before USER node) so it has write access to /usr/bin/.
# The wrapper script is written at runtime by entrypoint.sh with token data.
RUN mv /usr/bin/gh /usr/bin/gh.real 2>/dev/null || true

# Placeholder gh wrapper — replaced at runtime by entrypoint.sh with token routing.
# This ensures 'gh' is callable even if GITHUB_INSTALLATION_TOKENS is not set.
RUN printf '#!/bin/bash\nexec /usr/bin/gh.real "$@"\n' > /usr/bin/gh && chmod +x /usr/bin/gh

# Postgres setup: allow node user to start/stop pg via sudo (no password)
RUN echo "node ALL=(postgres) NOPASSWD: /usr/bin/pg_ctlcluster, /usr/bin/pg_isready, /usr/bin/createdb, /usr/bin/psql" > /etc/sudoers.d/postgres-for-node \
    && chmod 0440 /etc/sudoers.d/postgres-for-node

# Copy start-postgres script
COPY start-postgres.sh /app/start-postgres.sh
RUN chmod +x /app/start-postgres.sh

# Set ownership to node user (non-root) for writable directories
# Also make /usr/bin/gh writable by node so entrypoint can replace the wrapper
RUN chown -R node:node /workspace && chmod 777 /home/node && chown node:node /usr/bin/gh

# Set global git identity for agent commits
RUN git config --global user.name "Agent Fleet" \
    && git config --global user.email "fleet@your-domain.com"

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set git identity for the node user as well
RUN git config --global user.name "Agent Fleet" \
    && git config --global user.email "fleet@your-domain.com"

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
