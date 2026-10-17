#!/usr/bin/env bash
# One-time (and re-runnable) setup of the Oracle Always Free VM that runs
# the pipeline (2026-10-17). Run as root on Ubuntu 24.04:
#
#   sudo bash bootstrap.sh            # after /etc/geopulse/env exists
#
# Installs Node 22 (checksum-verified), clones the public repo to
# /opt/geopulse/app, and writes one systemd service + timer per schedule
# below. All times are UTC, the same slots the GitHub workflows used.
set -euo pipefail

# name | OnCalendar | jobs (run in order by run.sh)
SCHEDULE='
cycle|*-*-* *:07,37:00 UTC|ingest review-pending generate-briefs
snapshot|*-*-* 18:00:00 UTC|snapshot pipeline-health
flights|*-*-* 18:30:00 UTC|snapshot-flights
audit|*-*-* 20:00:00 UTC|audit-classifier
sanctions|Wed *-*-* 17:00:00 UTC|sync-sanctions
train_risk|Sun *-*-* 12:00:00 UTC|train-risk-model
train_narrative|Sun *-*-* 12:30:00 UTC|train-narrative-clusters
train_text|Sun *-*-* 13:00:00 UTC|train-text-classifier
'

[ -s /etc/geopulse/env ] || { echo "create /etc/geopulse/env first (see README.md)"; exit 1; }

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -yq git curl xz-utils unattended-upgrades

# Security updates install themselves; reboot at 04:30 UTC if one needs it
# (no pipeline slot then: the cycle runs at :07 and :37).
cat > /etc/apt/apt.conf.d/52geopulse-upgrades <<'CONF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:30";
CONF
systemctl enable --now unattended-upgrades

# Keep logs bounded on the free 47 GB boot volume.
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=500M\n' > /etc/systemd/journald.conf.d/geopulse.conf
systemctl restart systemd-journald

# Swap so `npm ci` survives on the 1 GB E2.1.Micro fallback shape.
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# Node 22 from nodejs.org, verified against the release's SHASUMS256.txt.
case "$(uname -m)" in aarch64) arch=arm64 ;; x86_64) arch=x64 ;; *) echo "unsupported arch"; exit 1 ;; esac
base=https://nodejs.org/dist/latest-v22.x
line=$(curl -fsSL "$base/SHASUMS256.txt" | grep " node-v.*-linux-$arch.tar.xz$")
file=${line##* }
want=$(echo "$file" | sed -E 's/^node-(v[0-9.]+)-.*/\1/')
if [ "$(node --version 2>/dev/null)" != "$want" ]; then
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/$file" "$base/$file"
  (cd "$tmp" && echo "$line" | sha256sum -c -)
  tar -xJf "$tmp/$file" -C /usr/local --strip-components=1
  rm -rf "$tmp"
fi
node --version

id geopulse >/dev/null 2>&1 || useradd --system --create-home --home-dir /opt/geopulse --shell /usr/sbin/nologin geopulse
chown root:geopulse /etc/geopulse /etc/geopulse/env && chmod 750 /etc/geopulse && chmod 640 /etc/geopulse/env

if [ ! -d /opt/geopulse/app/.git ]; then
  sudo -u geopulse git clone -q https://github.com/ronikmalik/geopulse.git /opt/geopulse/app
fi
sudo -u geopulse bash -c 'cd /opt/geopulse/app && git fetch -q origin master && git reset -q --hard origin/master && npm ci --no-audit --no-fund --loglevel=error'

# Remove units from an older schedule, then write the current ones.
for f in /etc/systemd/system/geopulse-*.timer; do
  [ -e "$f" ] && systemctl disable --now "$(basename "$f")" >/dev/null 2>&1 || true
done
rm -f /etc/systemd/system/geopulse-*.service /etc/systemd/system/geopulse-*.timer

echo "$SCHEDULE" | while IFS='|' read -r name cal jobs; do
  [ -n "$name" ] || continue
  cat > "/etc/systemd/system/geopulse-$name.service" <<UNIT
[Unit]
Description=GeoPulse $name ($jobs)
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
User=geopulse
EnvironmentFile=/etc/geopulse/env
Environment=NODE_ENV=production GEOPULSE_UNIT=$name
ExecStart=/bin/bash /opt/geopulse/app/deploy/oracle/run.sh $jobs
TimeoutStartSec=50min
Nice=5
UNIT
  # A timer never starts a second copy while the oneshot is still running,
  # so a slow cycle delays the next slot instead of overlapping it.
  cat > "/etc/systemd/system/geopulse-$name.timer" <<UNIT
[Unit]
Description=GeoPulse $name schedule

[Timer]
OnCalendar=$cal
AccuracySec=1s

[Install]
WantedBy=timers.target
UNIT
done

systemctl daemon-reload
for f in /etc/systemd/system/geopulse-*.timer; do systemctl enable --now "$(basename "$f")"; done
systemctl list-timers 'geopulse-*' --no-pager
