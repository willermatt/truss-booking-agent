/** Strips customer contact details from text before it is logged or stored as error detail. */
export function redact(text: string): string {
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g, '[phone]')
    .slice(0, 500);
}

export function errorDetail(e: unknown): { error: string } {
  return { error: redact(e instanceof Error ? e.message : String(e)) };
}
