import { BlockList, isIP } from 'node:net';
import type { Request } from 'express';

/**
 * The address a request really came from, for rate limiting and the audit log.
 *
 * On Render, `trust proxy = 1` makes req.ip the address that connected to
 * Render's load balancer. For traffic on the custom domain that is a
 * Cloudflare edge, not the user, so every user behind one edge would share a
 * rate-limit bucket and every attachment-link audit row would name the edge.
 * Cloudflare puts the user's address in CF-Connecting-IP — but anyone who can
 * reach the origin URL directly can send that header too, so it is only
 * believed when the connecting address is itself one of Cloudflare's. That
 * keeps the key unspoofable on both paths without raising TRUST_PROXY, which
 * would let a direct caller forge X-Forwarded-For instead.
 */

// https://www.cloudflare.com/ips/ — stable for years; override with
// CLOUDFLARE_IP_RANGES (comma-separated CIDRs) if Cloudflare publishes a change.
const CLOUDFLARE_RANGES = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18',
  '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17',
  '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32',
  '2a06:98c0::/29', '2c0f:f248::/32',
];

function buildBlockList(ranges: string[]): BlockList {
  const list = new BlockList();
  for (const cidr of ranges) {
    const [addr, bits] = cidr.split('/');
    const family = isIP(addr);
    if (!family || !bits) continue;
    list.addSubnet(addr, Number(bits), family === 6 ? 'ipv6' : 'ipv4');
  }
  return list;
}

const cloudflare = buildBlockList(
  (process.env.CLOUDFLARE_IP_RANGES ?? '').split(',').map((s) => s.trim()).filter(Boolean).length
    ? (process.env.CLOUDFLARE_IP_RANGES as string).split(',').map((s) => s.trim()).filter(Boolean)
    : CLOUDFLARE_RANGES,
);

/** Strip the IPv4-mapped IPv6 prefix Node reports for IPv4 sockets. */
function normalizeIp(ip: string): string {
  return ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
}

export function isCloudflareAddress(ip: string | undefined): boolean {
  if (!ip) return false;
  const addr = normalizeIp(ip);
  const family = isIP(addr);
  if (!family) return false;
  return cloudflare.check(addr, family === 6 ? 'ipv6' : 'ipv4');
}

export function clientIp(req: Pick<Request, 'ip' | 'get'>): string {
  const connecting = normalizeIp(req.ip ?? '');
  const viaCloudflare = req.get('cf-connecting-ip');
  if (viaCloudflare && isCloudflareAddress(connecting)) {
    const candidate = normalizeIp(viaCloudflare.trim());
    if (isIP(candidate)) return candidate;
  }
  return connecting;
}
