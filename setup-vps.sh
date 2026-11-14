#!/usr/bin/env bash
# =====================================================
#  Tube AutoPilot - Setup VPS (Ubuntu 20.04/22.04/24.04)
#  Para uso em VPS brasileira barata com PIX.
#
#  Uso: sudo chmod +x setup-vps.sh && sudo ./setup-vps.sh
# =====================================================
set -e

echo "=============================================="
echo "  TUBE AUTOPILOT - INSTALADOR VPS (Ubuntu)"
echo "=============================================="

if [[ $EUID -ne 0 ]]; then
  echo "Execute como root: sudo ./setup-vps.sh"
  exit 1
fi

# ---------- 1. Sistema ----------
echo "[1/8] Atualizando o sistema..."
apt update -y && apt upgrade -y

# ---------- 2. Dependencias ----------
echo "[2/8] Instalando dependências..."
apt install -y curl git nano unzip nginx certbot python3-certbot-nginx ufw

# ---------- 3. Node.js 22 ----------
echo "[3/8] Instalando Node.js 22 LTS..."
if ! command -v node &> /dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt install -y nodejs
fi
echo "Node: $(node --version)  NPM: $(npm --version)"

# ---------- 4. Clona o projeto ----------
PROJ_DIR="/opt/tube-autopilot"
if [[ ! -d "$PROJ_DIR/.git" ]]; then
  echo "[4/8] Clonando repositório..."
  git clone https://github.com/frestinhoaposta-cyber/tube-autopilot.git "$PROJ_DIR"
else
  echo "[4/8] Atualizando repositório..."
  cd "$PROJ_DIR" && git pull
fi

# ---------- 5. Dependencias Node ----------
cd "$PROJ_DIR"
echo "[5/8] Instalando dependências do Node..."
npm install --omit=dev

# ---------- 6. .env ----------
if [[ ! -f .env ]]; then
  cp .env.example .env
fi
# Guarda o IP publico para orientacao
IP=$(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
echo ""
echo ">>> IP público da VPS: $IP"
echo ">>> EDITE o arquivo .env em  $PROJ_DIR/.env  com suas credenciais:"
echo ">>>    YOUTUBE_REDIRECT_URI=https://SEU_DOMINIO/api/auth/google/callback"
echo ">>>    TIKTOK_REDIRECT_URI=https://SEU_DOMINIO/api/tiktok/auth/callback"
echo ">>>    SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY, SUPABASE_JWKS_URL"
echo ">>>    TOKEN_ENCRYPTION_KEY, YOUTUBE_CLIENT_ID/SECRET, TIKTOK_CLIENT_KEY/SECRET"
echo ">>>    SESSION_SECRET"
echo ""

# ---------- 7. Serviço systemd ----------
echo "[6/8] Configurando serviço systemd..."
cat > /etc/systemd/system/tube-autopilot.service <<'EOF'
[Unit]
Description=Tube AutoPilot - Upload e agendamento de videos
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/tube-autopilot
ExecStart=/usr/bin/node server/server.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production
EnvironmentFile=/opt/tube-autopilot/.env

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable tube-autopilot
systemctl restart tube-autopilot
echo "Serviço iniciado. Status:"
systemctl status tube-autopilot --no-pager | head -20

# ---------- 8. Firewall ----------
echo "[7/8] Configurando firewall (ufw)..."
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo ""
echo "=============================================="
echo "  INSTALAÇÃO DO APP CONCLUÍDA"
echo "=============================================="
echo ""
echo "PRÓXIMOS PASSOS (obrigatórios para OAuth):"
echo " 1) Edite o .env:  sudo nano /opt/tube-autopilot/.env"
echo " 2) Configure as URLs de redirecionamento apontando para seu domínio."
echo " 3) Crie um domínio gratuito em https://duckdns.org apontando para $IP"
echo " 4) Depois rode o script de HTTPS:  sudo ./duckdns-https.sh SEU.duckdns.org"
echo " 5) Reinicie o serviço:  sudo systemctl restart tube-autopilot"
echo ""
