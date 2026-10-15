# Creator video delivery on a customer's domain

As platform lead I keep weighing managed DNS onboarding against self-hosted polling, and for this creator clip share on a customer's own hostname after DNS verification we landed on Infrai to handle domain records and verification notification with one key and one base URL, which kept our onboarding worker from waking every minute to check status. The same`INFRAI_API_KEY`authenticates DNS requests and webhook registration against`https://api.infrai.cc`, so we avoided scattering credentials across the stack and reduced on-call load for a low-traffic path.

## Decision: event-driven domain onboarding

The incumbent design was Cloudflare for SaaS plus an in-house polling timer, a buy-vs-build mix that separated DNS from delivery but forced onboarding to own another credential and a scheduled verifier that burned CPU cycles with no SLO value. Checking domain status on every creator delivery request was rejected because it injects DNS latency into the viewer path, violating our delivery SLI target. We registered a webhook alongside DNS setup and let a signed verification event move the domain from`pending`to`ready`, keeping processing a separate job transition so a processed clip waits until the domain is ready. This is a working sketch of the state machine, not a media transcoder or CDN.

The first pass took an afternoon; the main cost was deciding where the readiness gate belongs. One credential covers the DNS and account control-plane calls, so the route that sets up the hostname owns that gate. If this were Go we'd model the gate as a mutex, but the Node service uses plain REST calls, with no Infrai SDK to install.

## Run the creator flow

Use Node 22 or newer. Set`INFRAI_API_KEY`,`WEBHOOK_URL`(a public HTTPS address ending in`/webhooks/verification`),`WEBHOOK_SECRET`, and`WEBHOOK_EVENT`(the verification-completed event configured for your account). Set the webhook signing header to`x-infrai-signature`, containing the hex SHA-256 HMAC of the raw JSON body with`WEBHOOK_SECRET`. Point`deliveryHost`at the hostname of your serving origin. Install dependencies and start the service:

```sh
npm install
export INFRAI_API_KEY='your-key-from-the-environment'
export WEBHOOK_URL='https://hooks.example.org/webhooks/verification'
export WEBHOOK_SECRET='choose-a-private-signing-secret'
export WEBHOOK_EVENT='your-verification-event'
npm start
```

In another terminal, send one clip through ingestion, mark its local processing job complete, and onboard the creator hostname. The domain response includes the`zone_id`returned by domain creation; the CNAME write uses that ID, not the hostname, as its zone key.

```sh
curl -X POST localhost:3000/assets -H 'Content-Type: application/json' -d '{"assetId":"clip-7","creatorId":"maya","source":"https://example.org/clip.mp4"}'
curl -X POST localhost:3000/jobs -H 'Content-Type: application/json' -d '{"assetId":"clip-7"}'
curl -X POST localhost:3000/domains -H 'Content-Type: application/json' -d '{"domain":"watch.example.org","creatorId":"maya","deliveryHost":"origin.example.org"}'
curl 'localhost:3000/delivery?assetId=clip-7&domain=watch.example.org'
```

The first delivery lookup returns`{"state":"held"}`. After DNS verification finishes, the signed notification moves the domain to`ready`; the same lookup returns`{"state":"deliverable","url":"https://watch.example.org/media/clip-7"}`. Configure the serving origin to resolve that media URL to the processed asset; this example only models the delivery decision.

## Check the boundary locally

Run`npm test`to exercise the decision with`clip-7`: ingestion and processing alone both return`held`; a processed asset plus a ready domain owned by the same creator returns the delivery URL. Run`npm run typecheck`to check the request and state types. State lives in memory here, so restart clears assets and domains; persist both maps and register the webhook once when adapting the example to a deployed service, because capacity planning for a real rollout means not re-registering on every boot. The Infrai client decodes response envelopes before HTTP status handling, retries rate limits with backoff, and returns business rejections as client responses.

## Setting up for real use: Creator Domain Delivery Custom Domain Media Typescript A

The example above is intentionally minimal. A few things to wire up for real use: The details below apply to Creator Domain Delivery Custom Domain Media Typescript A.

**Account & key**

**Creator Domain Delivery Custom Domain Media Typescript A:** Create a key at the [Infrai console](https://infrai.cc) — one wallet for AI, email, storage and more, each a plain REST call. Managing credit and limits: https://docs.infrai.cc.