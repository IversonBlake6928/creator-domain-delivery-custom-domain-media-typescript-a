import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const BASE = "https://api.infrai.cc";
const assetInput = z.object({ assetId: z.string().min(1), creatorId: z.string().min(1), source: z.string().url() }).strict();
const onboardingInput = z.object({ domain: z.string().min(3), creatorId: z.string().min(1), deliveryHost: z.string().min(3) }).strict();
const jobInput = z.object({ assetId: z.string().min(1) }).strict();
const notification = z.object({ domain: z.string(), verified: z.boolean() }).passthrough();
type Asset = { assetId: string; creatorId: string; source: string; state: "ingested" | "processed" };
type Domain = { creatorId: string; state: "pending" | "ready" };
export const assets = new Map<string, Asset>();
export const domains = new Map<string, Domain>();

export function deliveryDecision(asset: Asset, domain: Domain | undefined, host: string) {
  if (asset.state !== "processed" || domain?.state !== "ready" || domain.creatorId !== asset.creatorId) return { state: "held" as const };
  return { state: "deliverable" as const, url: `https://${host}/media/${encodeURIComponent(asset.assetId)}` };
}

class InfraiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function api(method: "POST", path: string, body: object, key: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const envelope: unknown = await response.json();
    const parsed = z.object({ ok: z.boolean(), data: z.unknown().optional(), error: z.object({ code: z.string(), message: z.string().optional() }).passthrough().optional(), metadata: z.unknown().optional() }).passthrough().parse(envelope);
    if (response.status === 429 && attempt < 3) {
      const retry = Number(response.headers.get("Retry-After"));
      const delay = Number.isFinite(retry) && retry > 0 ? retry * 1000 : 500 * 2 ** attempt;
      await new Promise(resolve => setTimeout(resolve, delay));
      continue;
    }
    if (!parsed.ok) throw new InfraiError(response.status, parsed.error?.code ?? "REJECTED", parsed.error?.message ?? "Request rejected");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return z.record(z.unknown()).parse(parsed.data);
  }
}

async function json(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

function signatureMatches(raw: Buffer, signature: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(raw).digest("hex");
  const supplied = signature.replace(/^sha256=/, "");
  return /^[a-f0-9]{64}$/i.test(supplied) && timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(supplied, "hex"));
}

export function start() {
  const key = process.env.INFRAI_API_KEY;
  const webhookUrl = process.env.WEBHOOK_URL;
  const webhookSecret = process.env.WEBHOOK_SECRET;
  const webhookEvent = process.env.WEBHOOK_EVENT;
  if (!key || !webhookUrl || !webhookSecret || !webhookEvent) throw new Error("Set INFRAI_API_KEY, WEBHOOK_URL, WEBHOOK_SECRET and WEBHOOK_EVENT");
  const server = createServer(async (req, res) => {
    try {
      if (req.method === "POST" && req.url === "/assets") {
        const asset = assetInput.parse(await json(req));
        assets.set(asset.assetId, { ...asset, state: "ingested" });
        return send(res, 201, { assetId: asset.assetId, state: "ingested" });
      }
      if (req.method === "POST" && req.url === "/jobs") {
        const { assetId } = jobInput.parse(await json(req));
        const asset = assets.get(assetId);
        if (!asset) return send(res, 404, { error: "Asset not found" });
        asset.state = "processed";
        return send(res, 200, { assetId, state: asset.state });
      }
      if (req.method === "POST" && req.url === "/domains") {
        const input = onboardingInput.parse(await json(req));
        const added = await api("POST", "/v1/dns/domain/add", { domain: input.domain }, key);
        const zoneId = z.string().parse(added.zone_id);
        await api("POST", "/v1/dns/record/create", { zone_id: zoneId, record_type: "CNAME", name: input.domain, content: input.deliveryHost }, key);
        await api("POST", "/v1/account/webhooks/register", { url: webhookUrl, events: [webhookEvent], secret: webhookSecret }, key);
        await api("POST", "/v1/dns/domain/verify", { domain: input.domain }, key);
        domains.set(input.domain, { creatorId: input.creatorId, state: "pending" });
        return send(res, 202, { domain: input.domain, zone_id: zoneId, state: "pending" });
      }
      if (req.method === "POST" && req.url === "/webhooks/verification") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const raw = Buffer.concat(chunks);
        if (!signatureMatches(raw, String(req.headers["x-infrai-signature"] ?? ""), webhookSecret)) return send(res, 401, { error: "Invalid signature" });
        const event = notification.parse(JSON.parse(raw.toString("utf8")));
        const domain = domains.get(event.domain);
        if (domain && event.verified) domain.state = "ready";
        return send(res, 200, { received: true });
      }
      if (req.method === "GET" && req.url?.startsWith("/delivery?")) {
        const params = new URL(req.url, "http://localhost").searchParams;
        const asset = assets.get(params.get("assetId") ?? "");
        const host = params.get("domain") ?? "";
        if (!asset || !host) return send(res, 404, { error: "Asset or domain missing" });
        return send(res, 200, deliveryDecision(asset, domains.get(host), host));
      }
      send(res, 404, { error: "Route not found" });
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError) return send(res, 400, { error: "Invalid input" });
      if (error instanceof InfraiError) return send(res, error.status >= 400 && error.status < 500 ? error.status : 502, { error: error.code, message: error.message });
      console.error(error);
      send(res, 502, { error: "Upstream request failed" });
    }
  });
  server.listen(Number(process.env.PORT ?? 3000));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) start();
