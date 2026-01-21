export function calculateTimeLeft(endDateIso: string): string {
  const end = new Date(endDateIso).getTime();
  const now = Date.now();

  const diff = end - now;
  if (diff <= 0) return "expired";

  const totalSeconds = Math.floor(diff / 1000);

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const secPretty = seconds.toString().padStart(2, "0");

  if (hours > 0) {
    return `${hours}h ${minutes}m ${secPretty}s`;
  }

  return `${minutes}m ${secPretty}s`;
}
