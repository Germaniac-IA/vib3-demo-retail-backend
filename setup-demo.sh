#!/bin/bash
# ===============================================================
# setup-demo.sh — VIB3 Demo Retail — Deploy script
# ===============================================================
# Uso:
#   1. ssh root@<server-demo>
#   2. Copiar este script al server
#   3. bash setup-demo.sh
# ===============================================================
set -euo pipefail

# ─── Config ────────────────────────────────────────────────────
APP_NAME="vib3-demo-retail"
BACKEND_REPO="https://github.com/Germaniac-IA/vib3-demo-retail-backend.git"
DASHBOARD_REPO="https://github.com/Germaniac-IA/vib3-demo-retail-dashboard.git"
BACKEND_PORT=4200
DASHBOARD_PORT=4201
DB_NAME="demo_retail"
DB_USER="demo_user"
DB_PASS="cambiar_en_produccion_123"   # ← cambiar antes de deploy

# ─── Colores ────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()  { echo -e "  ${GREEN}✓${NC} $1"; }
info(){ echo -e "  ${YELLOW}→${NC} $1"; }

# ─── 1. Verificar requisitos ────────────────────────────────────
info "Verificando requisitos..."
for cmd in node npm git pm2 psql; do
  if ! command -v $cmd &>/dev/null; then
    echo "ERROR: $cmd no está instalado."
    echo "  Instalá lo necesario: node, npm, git, pm2, postgresql-client"
    exit 1
  fi
done
ok "Requisitos OK"

# ─── 2. Clonar repos ────────────────────────────────────────────
info "Clonando repos..."
cd /var/www
rm -rf "$APP_NAME" 2>/dev/null || true
mkdir -p "$APP_NAME"
cd "$APP_NAME"

git clone "$BACKEND_REPO" backend
git clone "$DASHBOARD_REPO" dashboard
ok "Repos clonados"

# ─── 3. Configurar backend ──────────────────────────────────────
info "Configurando backend..."
cd /var/www/$APP_NAME/backend

cat > .env <<EOF
DATABASE_URL=postgresql://${DB_USER}:${DB_PASS}@localhost:5432/${DB_NAME}
JWT_SECRET=$(openssl rand -hex 32)
EOF

# node_modules ya vienen en el repo

# Verificar syntax
node --check server.js && ok "Backend syntax OK"

# ─── 4. Configurar dashboard ────────────────────────────────────
info "Configurando dashboard..."
cd /var/www/$APP_NAME/dashboard

# node_modules
if [ ! -d node_modules ]; then
  npm install 2>&1 | tail -3
fi

# .env.local
cat > .env.local <<EOF
NEXT_PUBLIC_API_URL=/api
EOF

# Build
npm run build 2>&1 | tail -5 && ok "Dashboard build OK"

# ─── 5. Crear DB ────────────────────────────────────────────────
info "Creando base de datos..."
if sudo -u postgres psql -t -c "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1; then
  info "DB ya existe, omitiendo creación"
else
  sudo -u postgres psql -c "CREATE USER ${DB_USER} WITH PASSWORD '${DB_PASS}';" 2>/dev/null || true
  sudo -u postgres psql -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};"
  sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};"
  # Estructura desde Baver (dump de schema)
  info "Para copiar estructura: pg_dump -s -h <baver_host> -U cristal baver_retail | psql -h localhost -U ${DB_USER} ${DB_NAME}"
  info "  (ejecutar manualmente desde el server de Baver)"
fi
ok "DB lista"

# ─── 6. Iniciar PM2 ─────────────────────────────────────────────
info "Iniciando servicios en PM2..."
pm2 delete "$APP_NAME-backend" "$APP_NAME-dashboard" 2>/dev/null || true

pm2 start /var/www/$APP_NAME/backend/server.js \
  --name "$APP_NAME-backend" \
  --interpreter node \
  --watch false \
  -- -p $BACKEND_PORT

# Dashboard con nginx necesita server.js que sirva build
# Si no tiene server propio, usar next start
cd /var/www/$APP_NAME/dashboard
pm2 start npm --name "$APP_NAME-dashboard" \
  -- start \
  -- -p $DASHBOARD_PORT

pm2 save
ok "PM2 iniciado"

# ─── 7. Nginx (opcional) ────────────────────────────────────────
info "Recordá configurar nginx si es necesario:"
echo "  /etc/nginx/sites-available/$APP_NAME"
echo "  server {
    listen 80;
    server_name demo-tu-cliente.com;

    location /api/ {
        proxy_pass http://127.0.0.1:$BACKEND_PORT/;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
    }

    location / {
        proxy_pass http://127.0.0.1:$DASHBOARD_PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
    }
  }"

# ─── Resumen ────────────────────────────────────────────────────
echo ""
echo "============================================"
echo -e "  ${GREEN}✅ VIB3 Demo Retail desplegado${NC}"
echo "============================================"
echo "  Backend:  http://127.0.0.1:$BACKEND_PORT"
echo "  Dashboard: http://127.0.0.1:$DASHBOARD_PORT"
echo ""
echo "  PM2:"
pm2 status "$APP_NAME-backend" "$APP_NAME-dashboard" --no-color 2>/dev/null | tail -15
echo ""
echo "  Próximo paso:"
echo "    1. Copiar estructura DB (ver paso 5)"
echo "    2. Configurar nginx (opcional)"
echo "    3. Cambiar DB_PASS en .env"
echo "============================================"
