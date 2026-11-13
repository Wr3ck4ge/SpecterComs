/** Coarse network hint for persisted rows: IPv4 /24, IPv6 /48. Never the full address. */
export const coarseIp = (raw: string | null | undefined): string | null => {
  if (!raw) return null;
  const ip = String(raw).replace(/^::ffff:/, '');
  const v4 = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/.exec(ip);
  if (v4) return `${v4[1]}.0/24`;
  if (ip.includes(':')) {
    const g = ip.split('::')[0].split(':').filter(Boolean).slice(0, 3);
    return `${g.join(':')}::/48`;
  }
  return null;
};
