/**
 * Política de cancelación: el cliente puede cancelar hasta `cancellationHours`
 * antes del turno; después, solo el negocio.
 */
export function canClientCancel(startsAt: Date, now: Date, cancellationHours: number): boolean {
  return startsAt.getTime() - now.getTime() >= cancellationHours * 3_600_000;
}
