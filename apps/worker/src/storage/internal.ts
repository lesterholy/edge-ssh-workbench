export function nowIso(): string {
  return new Date().toISOString();
}

export function createId(_kind?: string): string {
  return crypto.randomUUID();
}

export function asBoolean(value: number | boolean): boolean {
  return value === true || value === 1;
}

export function toInteger(value: boolean): number {
  return value ? 1 : 0;
}

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export function assertOwnerId(ownerId: string): void {
  if (!ownerId || ownerId.length > 128) throw new Error("Invalid owner ID");
}

export function assertRecordId(id: string): void {
  if (!id || id.length > 128) throw new Error("Invalid record ID");
}
