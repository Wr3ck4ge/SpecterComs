# Node.js Build Stage
FROM node:18-alpine AS builder
WORKDIR /app
COPY web-portal/package.json web-portal/package-lock.json .
# Copy the local wasm-crypto package before npm install so the file: reference resolves
COPY web-portal/wasm-crypto/pkg ./wasm-crypto/pkg
# package.json's "@spectercoms/shared-web" is "file:../packages/shared-web" —
# relative to WORKDIR /app, that resolves to /packages/shared-web, so it must
# land there (not under /app) before npm install, same reasoning as wasm-crypto above.
COPY packages/shared-web /packages/shared-web
# npm ci (not install) so this always resolves the exact versions already
# tested in package-lock.json instead of re-resolving from the registry on
# every cache-miss build. That drift is exactly what broke this build: with
# no lockfile in the image, a no-cache build silently picked up whatever
# @swc/core version currently satisfies vite-plugin-top-level-await's ^range
# at build time, and a later @swc/core release changed its AST shape enough
# to break that plugin ("missing field `type`" from its printSync call) —
# invisible for months while Docker's layer cache kept reusing the old
# install, then a hard failure the moment a clean build (new machine, no
# cache) actually re-resolved dependencies.
RUN npm ci
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
