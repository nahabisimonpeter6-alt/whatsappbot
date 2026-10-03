# Run the bot while your PC is off

The bot must run on a server that stays powered on and connected to the internet. `npm start` on your PC ends when the PC shuts down or sleeps, or when its terminal process ends. Once a cloud server is paired and connected to WhatsApp, your PC can be switched off.

This repository is prepared for Railway. The remaining steps take place in your Railway account and on your phone; pushing the code to GitHub does not create a cloud deployment.

Railway has deprecated its JSON Config as Code feature: services already using it can continue until December 1, 2026; new services cannot enable it. For a new service, configure the equivalent settings in the table below through its dashboard, or migrate its configuration using Railway Infrastructure as Code. Keep an existing paired service and volume in place while fixing it. See [current configuration support](https://docs.railway.com/config-as-code).

## Before moving

If you have activities or custom group settings on the local bot, save them first. From another current group admin account, send `.config export` in each group and keep the returned JSON. You can also use private control: `.groups`, `.use GROUP_ID`, then `.config export`.

After the cloud bot connects, use `.config import JSON` in the same group, replacing `JSON` with its exported settings. The export includes activities, announcement times, rules and other configurable settings. Warning counts, deleted-message archives and delivery history are not part of this export; they remain in your local `data/session` files. Importing settings into a fresh cloud instance may send today's agenda again because its old delivery history has not been transferred.

## Deploy from GitHub

1. Sign in at [Railway](https://railway.com/). The default configuration uses `ON_FAILURE` with 10 retries and can be used on Free/Trial while their resource limits allow it. For ongoing hosting, use a funded paid plan; Hobby currently starts at $5/month with $5 of resource usage included, and additional usage can increase the bill. Review the [current pricing](https://docs.railway.com/pricing/plans).
2. Create a project, choose to deploy from a GitHub repository, and select `nahabisimonpeter6-alt/whatsappbot`, branch `main`. Allow Railway access to that repository. Railway uses the included Dockerfile to install Chromium and start the bot. See [GitHub deployment](https://docs.railway.com/services#deploying-from-a-github-repo).
3. Add a volume to the bot service and mount it at **`/app/data/session`**. Attach it before scanning the QR code, then redeploy so the volume is mounted. This keeps the WhatsApp pairing, activities, warnings and recovery archive across normal restarts. See [volume setup](https://docs.railway.com/volumes).
4. Check the service configuration against the table below. Set any custom variables you used locally, such as `PREFIX` or `OWNER_NUMBERS`. The Dockerfile supplies the Chromium executable path. The bot automatically chooses Railway's attached volume mount for `SESSION_PATH`; an explicit override must point inside that volume. The code uses Railway's `PORT` when supplied, otherwise 8080.
5. Stop the local bot before pairing the cloud bot (`systemctl --user stop whatsapp-bot` if you installed the background service). Open the Railway service's deployment logs and use your phone's **WhatsApp → Linked devices → Link a device** to scan the latest QR shown there. Leave the service running and wait for **`[WHATSAPP] Bot is ready and connected.`** If startup fails, the service restarts; pairing remains saved in the volume.
6. Restore your exported group settings if needed. From another account, send `.ping` and check for `pong`. Confirm welcomes, link moderation and the activity schedule in the group. The linked bot account must still be an admin to delete links and remove members.
7. Switch off your PC and send `.ping` again from your phone or another account. A reply verifies that the cloud instance is handling messages independently of your PC.

For content moderation, another group admin can send `.filter on` without an API key; built-in checks cover clear English profanity and direct threats. For the full language-aware policy, set `OPENAI_API_KEY` privately in the service's Railway Variables and redeploy. The default model is `gpt-4.1-mini`; `CONTENT_MODERATION_MODEL` can change it. Use `.filter test MESSAGE` for a FLAG/OK decision without deletion and `.filter status` to diagnose deletion blockers. The API account needs available credit or billing. Keep API keys out of GitHub and WhatsApp messages. See the [filter policy, controls and limits](../README.md#language-aware-content-filtering).

| Setting | Value |
| --- | --- |
| Source | This GitHub repository, branch `main` |
| Build | Included `Dockerfile` |
| Replicas | **1** |
| Serverless / App Sleeping | **Disabled** |
| Restart policy | **On Failure, 10 retries** by default; **Always** with the paid configuration |
| Deployment healthcheck | `/live` |
| Persistent volume mount | `/app/data/session` |
| `SESSION_PATH` | Attached volume mount by default; `/app/data/session` for the recommended mount |
| Startup watchdog | 5 minutes; `WHATSAPP_STARTUP_TIMEOUT_MS=300000` |

The replica, sleep, restart and deployment healthcheck settings are in `railway.json`. On a paid plan, set the service's Railway Config File to `/railway.always.json` for unlimited Always restarts, then redeploy. For existing services using legacy Config as Code, those files override the dashboard's individual restart settings; changing only the dashboard restart policy will not override `railway.json`. Services without legacy support should set these values directly in the dashboard. A volume must be attached separately through Railway. Keep one running bot for this paired account so it does not issue duplicate warnings or announcements.

## Connection checks

The logs must show **ready and connected**, not just **authenticated**. A fresh QR waits for your scan without a startup timeout. After authentication, a startup that fails to reach readiness within five minutes exits so Railway can restart it. Permanent authentication failures may require linking WhatsApp again.

You can generate a Railway public domain in the service's networking settings to check `/health`. It returns HTTP 200 with `{"ok":true,"ready":true}` only while WhatsApp is connected. `/live` returns HTTP 200 during QR pairing too, so Railway can deploy the service before you scan. The deployment healthcheck alone does not prove WhatsApp readiness or continuously monitor it.

Keep the service enabled, its volume attached and the hosting account funded. Normal server maintenance, redeployments and WhatsApp disconnects can cause brief interruptions. This setup provides hosting independent of your PC; it cannot guarantee uninterrupted WhatsApp availability.

## If deployment needs attention

- **No QR yet:** check the build and deployment logs. The five-minute startup watchdog retries a stalled startup; use the latest QR when one appears.
- **QR appears on every restart:** verify the attached volume mount and `SESSION_PATH` are both `/app/data/session`.
- **Authenticated but never ready:** the watchdog exits after five minutes so the host retries. Check subsequent logs for readiness or a fresh pairing request.
- **Memory-related browser exits:** inspect Railway memory metrics and increase the service's memory allocation if it is being killed for exceeding its limit.
- **Free/Trial deployment rejects Always:** redeploy the latest `main` using `railway.json`, which uses On Failure with 10 retries. Do not select `railway.always.json` on Free/Trial. See [restart policy limits](https://docs.railway.com/deployments/restart-policy).
- **Stops after being idle:** confirm Serverless is disabled in the deployed service. [Railway Serverless](https://docs.railway.com/deployments/serverless) can stop inactive services.


## Already scanned a QR on Railway

A successful scan saves login data in that container's browser profile. The phone's Linked devices entry alone cannot recreate those files. The bot can reuse the pairing when the same saved profile is still available; a revoked or lost pairing needs a new scan.

1. Keep the existing volume attached. Keep `SESSION_PATH` pointing at the same directory used for that scan. Do not replace the volume with an empty one or delete the session directory.
2. Deploy the latest GitHub `main` commit to the existing bot service. If legacy Config as Code is enabled, use `/railway.json` for Free/Trial, or `/railway.always.json` on a paid plan. Otherwise set On Failure with 10 retries (Free/Trial), or Always (paid), in the dashboard. Keep the Dockerfile builder and `/live` healthcheck; `/health` is not suitable for initial pairing.
3. Check the deployment logs. `[SESSION] directory:` shows the chosen location. `Existing browser profile found` means the bot will attempt to reuse that profile, not that authentication has already succeeded. Wait for `Bot is ready and connected` and test `.ping` from another account.
4. If logs say `No Railway persistent volume`, attach one before pairing again. Files written only to the old container are not retained when it is replaced. If the old container is still accessible, back up its session privately before replacing it; keep session files out of GitHub.
5. If logs say the session is outside the volume, set `SESSION_PATH` to the existing saved-session directory inside the mounted volume. If using the recommended mount, set both to `/app/data/session`. A mount at `/app/data` can also contain the existing `/app/data/session` directory; keep that explicit session path rather than changing it.
6. If a new QR appears, the saved profile is absent or WhatsApp requires relinking. Scan that Railway QR after confirming persistence. Restart once after readiness and confirm it connects again without a new QR.

Without an explicit `SESSION_PATH`, startup also recognises an existing profile at the older `/app/data/session` location or a legacy `.wwebjs_auth` directory inside the volume and reuses it in place. It never moves or copies pairing data.

Stale browser lock symlinks from an old Railway container are cleared automatically; saved login files are retained. Storage permission/full-volume errors and active browser conflicts produce explicit startup errors. Railway prevents two deployments from mounting the same service volume at once; see [volume limitations](https://docs.railway.com/volumes/reference#caveats).

If deployment still fails, the first `[STARTUP]`, `[HTTP] failed`, or `[WHATSAPP] ... failed` error line is needed to diagnose the remaining cause. Build failures, missing storage, browser failures and rejected pairing require different fixes; authentication alone does not prove the bot is ready.
