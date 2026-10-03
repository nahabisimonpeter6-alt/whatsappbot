# Run the bot while your PC is off

The bot must run on a server that stays powered on and connected to the internet. `npm start` on your PC ends when the PC shuts down or sleeps, or when its terminal process ends. Once a cloud server is paired and connected to WhatsApp, your PC can be switched off.

This repository is prepared for Railway. The remaining steps take place in your Railway account and on your phone; pushing the code to GitHub does not create a cloud deployment.

## Before moving

If you have activities or custom group settings on the local bot, save them first. From another current group admin account, send `.config export` in each group and keep the returned JSON. You can also use private control: `.groups`, `.use GROUP_ID`, then `.config export`.

After the cloud bot connects, use `.config import JSON` in the same group, replacing `JSON` with its exported settings. The export includes activities, announcement times, rules and other configurable settings. Warning counts, deleted-message archives and delivery history are not part of this export; they remain in your local `data/session` files. Importing settings into a fresh cloud instance may send today's agenda again because its old delivery history has not been transferred.

## Deploy from GitHub

1. Sign in at [Railway](https://railway.com/) and use a paid plan. The included `ALWAYS` restart policy is unavailable on Free/Trial. Hobby currently starts at $5/month with $5 of resource usage included; additional usage can increase the bill. Review the [current pricing](https://docs.railway.com/pricing/plans).
2. Create a project, choose to deploy from a GitHub repository, and select `nahabisimonpeter6-alt/whatsappbot`, branch `main`. Allow Railway access to that repository. Railway uses the included Dockerfile to install Chromium and start the bot. See [GitHub deployment](https://docs.railway.com/services#deploying-from-a-github-repo).
3. Add a volume to the bot service and mount it at **`/app/data/session`**. Attach it before scanning the QR code, then redeploy so the volume is mounted. This keeps the WhatsApp pairing, activities, warnings and recovery archive across normal restarts. See [volume setup](https://docs.railway.com/volumes).
4. Check the service configuration against the table below. Set any custom variables you used locally, such as `PREFIX` or `OWNER_NUMBERS`. The Dockerfile already supplies `SESSION_PATH` and the Chromium executable path. The code uses Railway's `PORT` when supplied, otherwise 8080.
5. Stop the local bot before pairing the cloud bot. Open the Railway service's deployment logs and use your phone's **WhatsApp → Linked devices → Link a device** to scan the latest QR shown there. Leave the service running and wait for **`[WHATSAPP] Bot is ready and connected.`** If startup fails, the service restarts; pairing remains saved in the volume.
6. Restore your exported group settings if needed. From another account, send `.ping` and check for `pong`. Confirm welcomes, link moderation and the activity schedule in the group. The linked bot account must still be an admin to delete links and remove members.
7. Switch off your PC and send `.ping` again from your phone or another account. A reply verifies that the cloud instance is handling messages independently of your PC.

| Setting | Value |
| --- | --- |
| Source | This GitHub repository, branch `main` |
| Build | Included `Dockerfile` |
| Replicas | **1** |
| Serverless / App Sleeping | **Disabled** |
| Restart policy | **Always** |
| Deployment healthcheck | `/live` |
| Persistent volume mount | `/app/data/session` |
| `SESSION_PATH` | `/app/data/session` (already set in Docker) |
| Startup watchdog | 5 minutes; `WHATSAPP_STARTUP_TIMEOUT_MS=300000` |

The replica, sleep, restart and deployment healthcheck settings are in `railway.json`. A volume must be attached separately through Railway. Keep one running bot for this paired account so it does not issue duplicate warnings or announcements.

## Connection checks

The logs must show **ready and connected**, not just **authenticated**. A fresh QR waits for your scan without a startup timeout. After authentication, a startup that fails to reach readiness within five minutes exits so Railway can restart it. Permanent authentication failures may require linking WhatsApp again.

You can generate a Railway public domain in the service's networking settings to check `/health`. It returns HTTP 200 with `{"ok":true,"ready":true}` only while WhatsApp is connected. `/live` returns HTTP 200 during QR pairing too, so Railway can deploy the service before you scan. The deployment healthcheck alone does not prove WhatsApp readiness or continuously monitor it.

Keep the service enabled, its volume attached and the hosting account funded. Normal server maintenance, redeployments and WhatsApp disconnects can cause brief interruptions. This setup provides hosting independent of your PC; it cannot guarantee uninterrupted WhatsApp availability.

## If deployment needs attention

- **No QR yet:** check the build and deployment logs. The five-minute startup watchdog retries a stalled startup; use the latest QR when one appears.
- **QR appears on every restart:** verify the attached volume mount and `SESSION_PATH` are both `/app/data/session`.
- **Authenticated but never ready:** the watchdog exits after five minutes so the host retries. Check subsequent logs for readiness or a fresh pairing request.
- **Memory-related browser exits:** inspect Railway memory metrics and increase the service's memory allocation if it is being killed for exceeding its limit.
- **Free/Trial deployment rejects Always:** the checked-in settings require a paid plan; see [restart policy limits](https://docs.railway.com/deployments/restart-policy).
- **Stops after being idle:** confirm Serverless is disabled in the deployed service. [Railway Serverless](https://docs.railway.com/deployments/serverless) can stop inactive services.
