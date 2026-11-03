// Endpoints chosen by a cloud workspace owner are called by the server, so they must lead to the
// public internet only (no server-side request forgery into the operator's network). The text of
// the URL is not enough: a name can resolve to a private address (wildcard DNS such as
// 10.0.0.5.sslip.io), a single-label name can be a compose service (https://db:5432), and a public
// endpoint can redirect inward. So the host is resolved and every address checked, the connection
// is pinned to the checked addresses, and redirects are not followed.
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

export type ResolveFn = (hostname: string) => Promise<LookupAddress[]>;

export class NotPublicError extends Error {
  constructor(readonly host: string) {
    super("the endpoint is not a public internet address");
  }
}

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

/** True only for a unicast address on the public internet. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family !== 6) return false;
  const a = address.toLowerCase();
  // IPv4-mapped and IPv4-compatible forms carry an IPv4 address: check that one.
  const v4 = /^(?:::ffff:|::)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a)?.[1];
  if (v4) return isPublicAddress(v4);
  if (a.startsWith("::ffff:")) return false;
  return !blocked.check(a, "ipv6");
}

export const resolveAll: ResolveFn = (hostname) =>
  new Promise((resolve, reject) =>
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) =>
      err ? reject(err) : resolve(addresses),
    ),
  );

/**
 * Throws NotPublicError unless `hostname` is a multi-label DNS name whose every address is public.
 * IP literals are refused: a public provider is reached by name.
 */
export async function assertPublicHost(
  hostname: string,
  resolve: ResolveFn = resolveAll,
): Promise<LookupAddress[]> {
  const host = hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  if (!host || isIP(host) || !host.includes(".")) throw new NotPublicError(hostname);
  let addresses: LookupAddress[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new NotPublicError(hostname);
  }
  if (!addresses.length || !addresses.every((a) => isPublicAddress(a.address))) {
    throw new NotPublicError(hostname);
  }
  return addresses;
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * A fetch whose connections go only to checked public addresses: the address check runs in the
 * socket's own DNS lookup, so a name cannot resolve to a public address for the check and a
 * private one for the connection.
 */
export function pinnedPublicFetch(resolve: ResolveFn = resolveAll) {
  const agent = new Agent({
    connect: {
      lookup: (hostname: string, options: { all?: boolean }, cb: LookupCallback) => {
        assertPublicHost(hostname, resolve).then(
          (addresses) => {
            if (options?.all) cb(null, addresses);
            else cb(null, addresses[0]?.address ?? "", addresses[0]?.family);
          },
          (e: Error) => cb(Object.assign(e, { code: "ENOTPUBLIC" }), ""),
        );
      },
    },
  });
  return (input: string | URL | Request, init?: RequestInit) =>
    undiciFetch(
      input as Parameters<typeof undiciFetch>[0],
      {
        ...(init as Parameters<typeof undiciFetch>[1]),
        dispatcher: agent,
      } as Parameters<typeof undiciFetch>[1],
    ) as unknown as Promise<Response>;
}
