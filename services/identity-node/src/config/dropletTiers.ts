// DigitalOcean Basic (shared-CPU) Droplet plans, smallest to largest — sourced from
// digitalocean.com/pricing/droplets (checked 2026-07-30). Only powers the "you're on
// tier X, consider tier Y" recommendation surfaced on overloaded nodes; actually
// resizing is still a manual step via the DO console (a resize requires a power-off,
// so it's not something to trigger automatically from a heartbeat-driven alert).
export interface DropletTier {
  id: string;
  vcpus: number;
  ram_gb: number;
  disk_gb: number;
  monthly_usd: number;
}

export const DROPLET_TIERS: DropletTier[] = [
  { id: 'basic-1vcpu-0.5gb', vcpus: 1, ram_gb: 0.5, disk_gb: 10,  monthly_usd: 4 },
  { id: 'basic-1vcpu-1gb',   vcpus: 1, ram_gb: 1,   disk_gb: 25,  monthly_usd: 6 },
  { id: 'basic-1vcpu-2gb',   vcpus: 1, ram_gb: 2,   disk_gb: 50,  monthly_usd: 12 },
  { id: 'basic-2vcpu-2gb',   vcpus: 2, ram_gb: 2,   disk_gb: 60,  monthly_usd: 18 },
  { id: 'basic-2vcpu-4gb',   vcpus: 2, ram_gb: 4,   disk_gb: 80,  monthly_usd: 24 },
  { id: 'basic-4vcpu-8gb',   vcpus: 4, ram_gb: 8,   disk_gb: 160, monthly_usd: 48 },
  { id: 'basic-8vcpu-16gb',  vcpus: 8, ram_gb: 16,  disk_gb: 320, monthly_usd: 96 },
];

export const getNextTier = (currentTierId: string | null | undefined): DropletTier | null => {
  if (!currentTierId) return null;
  const idx = DROPLET_TIERS.findIndex((t) => t.id === currentTierId);
  if (idx === -1 || idx === DROPLET_TIERS.length - 1) return null;
  return DROPLET_TIERS[idx + 1];
};
