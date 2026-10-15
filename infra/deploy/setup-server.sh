#!/bin/sh
# Prepara un servidor Ubuntu 24.04 recién creado para correr Turnos.
# Uso (como root en el servidor):  REPO=https://github.com/<usuario>/turnos.git sh setup-server.sh
set -e
: "${REPO:?Pasá REPO=https://github.com/<usuario>/turnos.git}"

echo "== Docker"
if ! command -v docker >/dev/null; then
  apt-get update
  apt-get install -y ca-certificates curl git
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
fi

echo "== Swap de 2 GB (Kafka y los servicios entran justos en 4 GB de RAM)"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "== Firewall: solo SSH, HTTP y HTTPS"
apt-get install -y ufw
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp
ufw --force enable

echo "== Usuario de deploy (lo usa GitHub Actions por SSH)"
id deploy >/dev/null 2>&1 || useradd -m -s /bin/bash -G docker deploy
mkdir -p /home/deploy/.ssh && touch /home/deploy/.ssh/authorized_keys
chmod 700 /home/deploy/.ssh && chmod 600 /home/deploy/.ssh/authorized_keys && chown -R deploy:deploy /home/deploy/.ssh

echo "== Código"
if [ ! -d /opt/turnos ]; then git clone "$REPO" /opt/turnos; fi
chown -R deploy:deploy /opt/turnos

echo "== Backup diario de Postgres a las 4:00"
cp /opt/turnos/infra/deploy/backup.sh /usr/local/bin/turnos-backup && chmod +x /usr/local/bin/turnos-backup
echo '0 4 * * * root /usr/local/bin/turnos-backup >> /var/log/turnos-backup.log 2>&1' > /etc/cron.d/turnos-backup

cat <<'MSG'

Listo. Faltan tres cosas (ver docs/deploy.md):
  1. Pegar la clave pública de GitHub Actions en /home/deploy/.ssh/authorized_keys
  2. Crear /opt/turnos/infra/.env.prod a partir de infra/.env.prod.example
  3. Primer arranque:  cd /opt/turnos && docker compose -f infra/docker-compose.prod.yml --env-file infra/.env.prod up -d --build
MSG
