#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 VM (Lightsail 2 GB) for pamA Cloud. Run as the default
# user with sudo (PAMA_BRANCH picks another branch):  curl -fsSL https://raw.githubusercontent.com/TrH203/pamA/main/deploy/cloud/bootstrap.sh | bash
# Installs Docker and the AWS CLI, adds 2 GB swap, clones the repo to /opt/pama and schedules
# the nightly backup. It does not start pamA: fill in deploy/cloud/.env first.
set -euo pipefail
REPO="${PAMA_REPO:-https://github.com/TrH203/pamA.git}"
BRANCH="${PAMA_BRANCH:-main}"
DEST=/opt/pama

if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
fi
command -v aws >/dev/null || sudo snap install aws-cli --classic

# Swap keeps an image build or a busy hour from being killed on 2 GB of RAM.
if ! swapon --show | grep -q /swapfile; then
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

if [ ! -d "$DEST/.git" ]; then
  sudo git clone --branch "$BRANCH" "$REPO" "$DEST"
  sudo chown -R "$USER:$USER" "$DEST"
fi
[ -f "$DEST/deploy/cloud/.env" ] || cp "$DEST/deploy/cloud/.env.example" "$DEST/deploy/cloud/.env"
chmod 600 "$DEST/deploy/cloud/.env"

CRON="30 3 * * * $DEST/deploy/cloud/backup.sh >> $DEST/deploy/cloud/backup.log 2>&1"
(crontab -l 2>/dev/null | grep -v deploy/cloud/backup.sh; echo "$CRON") | crontab -

cat <<MSG
Done. Next:
  1. Log out and back in (docker group).
  2. Edit $DEST/deploy/cloud/.env (domain, secrets, SMTP, model keys, BACKUP_S3_URI).
  3. aws configure   (an IAM user that can only put objects into the backup bucket)
  4. docker compose -f $DEST/deploy/cloud/docker-compose.yml up -d
  5. curl -s https://\$PAMA_DOMAIN/v1/health
MSG
