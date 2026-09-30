# One image for both lanes. Which lane a container polls is decided by the task definition's
# command override, not by anything baked in here (DESIGN.md §1, "one image, two task definitions").
FROM node:22-slim

WORKDIR /app

# Dependencies first, so source edits do not invalidate the npm layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src/ ./src/

# No build step: Node strips the types at load time, same as the local runs.
# The task definition overrides the lane argument for the export service.
CMD ["node", "--experimental-strip-types", "src/poll-loop.ts", "import"]
