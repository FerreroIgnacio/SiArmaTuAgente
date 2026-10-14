#!/usr/bin/env bash
# Correr en la VM (Ubuntu) como ubuntu, dentro de ~/SiArmaTuAgente. Uso: ORIGIN_SECRET=xxx bash deploy/vm/setup.sh
set -euo pipefail
: "${ORIGIN_SECRET:?definí ORIGIN_SECRET}"
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs debian-keyring debian-archive-keyring apt-transport-https curl gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy.gpg --yes
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy.list
sudo apt-get update && sudo apt-get install -y caddy
npm ci
# Apps de escritorio del agente local que se ofrecen para descargar
npm run build:local
sudo cp deploy/vm/siarma.service /etc/systemd/system/
sudo cp deploy/vm/Caddyfile /etc/caddy/Caddyfile
echo "ORIGIN_SECRET=$ORIGIN_SECRET" | sudo tee /etc/caddy/env >/dev/null
sudo mkdir -p /etc/systemd/system/caddy.service.d
printf '[Service]\nEnvironmentFile=/etc/caddy/env\n' | sudo tee /etc/systemd/system/caddy.service.d/env.conf >/dev/null
# Oracle trae iptables restrictivo además del Security List
sudo iptables -I INPUT -p tcp -m multiport --dports 80,443 -j ACCEPT && sudo netfilter-persistent save || true
sudo systemctl daemon-reload
sudo systemctl enable --now siarma caddy
sudo systemctl restart caddy
