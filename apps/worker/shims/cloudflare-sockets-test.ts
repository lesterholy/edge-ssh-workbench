export function connect(): never {
  throw new Error("cloudflare:sockets is unavailable outside the Workers runtime");
}
