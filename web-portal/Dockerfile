# Node.js Build Stage
FROM node:18-alpine AS builder
WORKDIR /app
COPY web-portal/package.json .
# Copy the local wasm-crypto package before npm install so the file: reference resolves
COPY web-portal/wasm-crypto/pkg ./wasm-crypto/pkg
# package.json's "@spectercoms/shared-web" is "file:../packages/shared-web" —
# relative to WORKDIR /app, that resolves to /packages/shared-web, so it must
# land there (not under /app) before npm install, same reasoning as wasm-crypto above.
COPY packages/shared-web /packages/shared-web
# Install dependencies (including devDependencies for build)
RUN npm install
COPY web-portal/ .
# Bake the API URL at build time (Vite replaces import.meta.env.VITE_* at build)
ARG VITE_API_URL=/api
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build

# Nginx Production Stage
FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
# Custom default.conf for React routing support
RUN echo 'server { \
    listen 80; \
    location / { \
        root /usr/share/nginx/html; \
        index index.html index.htm; \
        try_files $uri $uri/ /index.html; \
    } \
}' > /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
