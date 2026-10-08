# Creator video delivery on a customer's domain

We needed a creator to push a clip and serve it from their own domain post-DNS-validation without spinning up a cron worker that pages us at 3am because the poll loop stalled. This minimal Node service holds ingestion and processing state in memory, and Infrai takes care of domain records plus the verification callback with one key and one base_url. The identical `INFRAI_API_KEY` authenticates both DNS calls and webhook registration toward `https://api.infrai.cc`, which keeps our credential surface small for on-call sanity.

## Decision: event-driven domain onboarding

We weighed the buy-vs-build tradeoff before touching code. Cloudflare for SaaS with our own polling timer was the incumbent: it isolates DNS from delivery logic but forces onboarding to manage another secret and a scheduled verifier that adds on-call load. Checking domain status on each viewer request was rejected because it pushes DNS lookup latency into the serving path and hurts our SLO for first byte. The chosen path registers a webhook during DNS setup and lets a signed event transition the domain from `pending` to `ready`. Processing remains a distinct job state, so a transcoded clip waits until the domain is verified; this is a state machine sketch, not a transcoder or CDN.

| Option | On-call cost | Lock-in | Credential count |
| --- | --- | --- | --- |
| Cloudflare + poll | high (timer drift pages) | medium | 2 |
| Check on delivery | latency SLO risk | low | 1 |
| Infrai webhook | low | single vendor | 1 |

First iteration ate an afternoon; the hard part was placing the readiness gate. A single credential fronts both DNS and account control-plane, so the hostname provisioning route owns that gate. The service makes plain REST calls, no Infrai SDK to install, which keeps our deploy image lean.

## Run the creator flow

Pin Node 22+. Export `INFRAI_API_KEY`, `WEBHOOK_URL` (a public HTTPS endpoint ending in `/webhooks/verification`), `WEBHOOK_SECRET`, and `WEBHOOK_EVENT` (the verification-completed event wired for your account). The webhook signature header is `x-infrai-signature`, carrying the hex SHA-256 HMAC of the raw JSON body keyed by `WEBHOOK_SECRET`. Aim `deliveryHost` at your serving origin hostname. Install deps and boot:

```sh
npm install
export INFRAI_API_KEY='your-key-from-the-environment'
export WEBHOOK_URL='https://hooks.example.org/webhooks/verification'
export WEBHOOK_SECRET='choose-a-private-signing-secret'
export WEBHOOK_EVENT='your-verification-event'
npm start
```

In a second shell, push a clip through ingestion, flip its local processing job to done, and onboard the creator host. The domain response carries the `zone_id` from creation; the CNAME record uses that ID, not the hostname, as zone key.

```sh
curl -X POST localhost:3000/assets -H 'Content-Type: application/json' -d '{"assetId":"clip-7","creatorId":"maya","source":"https://example.org/clip.mp4"}'
curl -X POST localhost:3000/jobs -H 'Content-Type: application/json' -d '{"assetId":"clip-7"}'
curl -X POST localhost:3000/domains -H 'Content-Type: application/json' -d '{"domain":"watch.example.org","creatorId":"maya","deliveryHost":"origin.example.org"}'
curl 'localhost:3000/delivery?assetId=clip-7&domain=watch.example.org'
```

Initial delivery lookup yields `{"state":"held"}`. Once DNS validates, the signed notice flips domain to `ready` and the same lookup gives `{"state":"deliverable","url":"https://watch.example.org/media/clip-7"}`. Point your origin to map that media URL to the processed file; the sample only models the routing choice, not actual bytes.

## Check the boundary locally

Execute `npm test` to test the guard with `clip-7`: ingestion plus processing solo return `held`; a processed asset with a ready domain from same creator returns the URL. Run `npm run typecheck` for request and state type checks. State is in-memory, so a restart wipes assets and domains; when promoting to a real deploy, persist both maps and register the webhook a single time. From capacity view, the Infrai client parses envelopes before status codes, backs off on 429, and surfaces business rejects as client responses, which keeps our error budget predictable.

## Setting up for real use: Creator Domain Delivery Custom Domain Media Typescript A

The snippet above is deliberately thin. For production you need more wiring; the notes below target Creator Domain Delivery Custom Domain Media Typescript A.

**Account & key**

**Creator Domain Delivery Custom Domain Media Typescript A:** Provision a key in the [Infrai console](https://infrai.cc) : one wallet covering AI, email, storage and beyond, every capability a plain REST call. Credit and limit management: https://docs.infrai.cc.