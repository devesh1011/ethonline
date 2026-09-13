FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY src/api ./src/api
COPY src/worker ./src/worker
COPY src/db ./src/db
COPY src/domain ./src/domain
COPY src/hedera-native ./src/hedera-native
COPY src/hedera-ats ./src/hedera-ats
COPY src/contracts/artifacts/contracts/ReceivablePoolRegistry.sol/ReceivablePoolRegistry.json ./src/contracts/artifacts/contracts/ReceivablePoolRegistry.sol/ReceivablePoolRegistry.json
COPY src/contracts/artifacts/contracts/SnapshotPayoutAdapter.sol/SnapshotPayoutAdapter.json ./src/contracts/artifacts/contracts/SnapshotPayoutAdapter.sol/SnapshotPayoutAdapter.json
COPY fixtures/evidence/testnet-evidence.json ./fixtures/evidence/testnet-evidence.json
COPY scripts/deploy/aws/reserve-schema.mjs ./scripts/deploy/aws/reserve-schema.mjs
RUN npm ci --include=dev --workspace=@receivablex/api --workspace=@receivablex/worker --workspace=@receivablex/db --workspace=@receivablex/domain --workspace=@receivablex/hedera-native --workspace=@receivablex/hedera-ats --include-workspace-root=false --no-audit --no-fund
USER node
EXPOSE 3001
CMD ["npm", "run", "start", "--workspace", "@receivablex/api"]
