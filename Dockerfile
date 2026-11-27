FROM node:22.23.4-bookworm-slim@sha256:5ec23b7c622b0753bc6ffd78085dd868a05d6a1418f033e13d96d
WORKDIR /app
COPY --chown=node:node . .
RUN mkdir -p /home/node/state && chown node:node /home/node/state
USER node
ENV SERVICE_HOST=0.0.0.0
ENV PORT=4100
ENV SERVICE_STATE=/home/node/state/service.json
ENV PEER_HOST=0.0.0.0
ENV PEER_STATE=/home/node/state/peer.json
EXPOSE 4100
EXPOSE 4300
CMD ["npm", "start"]
