#!/usr/bin/env bash
# =====================================================
#  Tube AutoPilot - Configura HTTPS com Duck DNS
#  Domínio gratuito + Let's Encrypt.
#
#  Uso: sudo ./duckdns-https.sh SEU_SUBDOMINIO.duckdns.org
#
#  ANTES: crie o subdomínio gratuito em https://duckdns.org
# =====================================================
set -e

DOMAIN="${1:-}"
if [[ -z "$DOMAIN" ]]; then
  echo "Uso: sudo ./duckdns-https.sh SEU_SUBDOMINIO.duckdns.org"
  exit 1
fi

echo "=============================================="
echo "  CONFIGURANDO HTTPS - $DOMAIN"
echo "=============================================="

# Verifica que o domínio resolve para este servidor
IP=$(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')

# ---------- Nginx ----------
echo "[1/4] Criando config Nginx para $DOMAIN ..."
cat > /etc/nginx/sites-available/tube-autopilot <<EOF
server {
    listen 80;
    server_name $DOMAIN;

    # Upload de vídeos grandes
    client_max_body_size 20G;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
    }
}
EOF

ln -sf /etc/nginx/sites-available/tube-autopilot /etc/nginx/sites-enabled/tube-autopilot
rm -f /etc/nginx/sites-enabled/default

nginx -t
systemctl reload nginx
echo "Nginx configurado e recarregado."

# ---------- Let's Encrypt ----------
echo "[2/4] Gerando certificado SSL (Let's Encrypt) para $DOMAIN ..."
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect
if [[ $? -ne 0 ]]; then
  echo "Falha ao gerar certificado. Verifique se o Duck DNS aponta para $IP"
  exit 1
fi

echo "[3/4] Agendando renovação automática do certificado..."
systemctl enable certbot.timer
systemctl start certbot.timer

# ---------- Atualiza .env ----------
echo "[4/4] Atualizando URLs de redirecionamento no .env..."
ENV_FILE="/opt/tube-autopilot/.env"
if [[ -f "$ENV_FILE" ]]; then
  sed -i "s|YOUTUBE_REDIRECT_URI=.*|YOUTUBE_REDIRECT_URI=https://$DOMAIN/api/auth/google/callback|" "$ENV_FILE"
  sed -i "s|YOUTUBE_REDIRECT_URI_2=.*|YOUTUBE_REDIRECT_URI_2=https://$DOMAIN/api/auth/google/callback|" "$ENV_FILE"
  sed -i "s|TIKTOK_REDIRECT_URI=.*|TIKTOK_REDIRECT_URI=https://$DOMAIN/api/tiktok/auth/callback|" "$ENV_FILE"
  systemctl restart tube-autopilot
  echo "Serviço reiniciado com novas URLs."
else
  echo "ATENÇÃO: .env não encontrado em $ENV_FILE. Edite manualmente as URLs de redirecionamento."
fi

echo ""
echo "=============================================="
echo "  HTTPS CONFIGURADO!"
echo "=============================================="
echo " Acesse: https://$DOMAIN"
echo ""
echo " IMPORTANTE - adicione no Google Cloud Console"
echo " e no TikTok o redirect URI:"
echo "   https://$DOMAIN/api/auth/google/callback"
echo "   https://$DOMAIN/api/tiktok/auth/callback"
echo ""
echo " Compartilhe o endereço https://$DOMAIN  no Google/TikTok"
echo " para autorizar as credenciais."
echo ""
