# Pipeline host: Oracle Cloud Always Free VM

Since 2026-10-17 the scheduled pipeline runs on an Oracle Cloud Always Free
VM in us-ashburn-1 (next to Neon's aws us-east-1), not GitHub Actions.
GitHub disabled Actions on this repo on 2026-10-14. The likely trigger was
the self-dispatching ingest chain, whose runner slept about 28 of every
30 minutes.

## Why Oracle (the owner's requirement is a $0 bill)

Measured on 2026-10-17, one cycle (ingest, review-pending, generate-briefs)
uses about 76 s of wall time, about 24 CPU-seconds, 285 MB peak memory,
sends about 1.5 MB and receives about 15 MB. At 1,440 cycles a month:

- Google Cloud Run sends about 2.2 GB/month against 1 GiB free egress, so
  it is never $0.
- Vercel Hobby would need about 9.6 active-CPU hours a month, more than
  its allowance.
- Oracle Always Free is a fixed VM, not per-second metering, with 10 TB
  of free egress.

## Guardrails (in the Oracle tenancy, not this repo)

- **Pay As You Go account.** This stops Oracle reclaiming "idle" Always
  Free VMs. Ours is busy about 5% of the time, under the 20% threshold.
- **Tenancy quota policy `geopulse-free-only`.** It sets every
  compute-core quota to zero except the Always Free shapes, so a paid
  instance cannot be launched.
- **Budget alert.** It emails the owner as soon as any actual cost
  appears.
- **Nothing billable in the setup.** No reserved IPs, no extra backups,
  nothing outside the home region.

## Layout on the VM

| Path | Purpose |
|---|---|
| `/opt/geopulse/app` | Clone of this repo. `run.sh` resets it to `origin/master` at the start of each cycle, so a push deploys within 30 min. |
| `/etc/geopulse/env` | Secrets, mode 640, `root:geopulse`. Same names as the old Actions secrets. |
| `geopulse-<name>.timer` and `.service` | One pair per schedule in `bootstrap.sh`. All times UTC. |

Re-run `sudo bash /opt/geopulse/app/deploy/oracle/bootstrap.sh` after
changing the schedule table.

Useful commands:

```
systemctl list-timers 'geopulse-*'
journalctl -u geopulse-cycle -n 100 --no-pager
sudo systemctl start geopulse-cycle    # run a cycle now
```

`/etc/geopulse/env` needs these variables:

```
DATABASE_URL=            GEMINI_API_KEY=       GOOGLE_TRANSLATE_API_KEY=
FIRMS_MAP_KEY=           EIA_API_KEY=          MBFC_RAPIDAPI_KEY=
CRON_SECRET=             APP_ORIGIN=https://geopulse-green.vercel.app
# Optional dead-man's-switch ping URLs, one per unit name:
# HC_PING_cycle=  HC_PING_snapshot=
```
