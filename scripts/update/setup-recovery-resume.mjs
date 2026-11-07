/** An interrupted native execution must be reconciled, never implicitly repeated. */
export function recoveryResumeDecision(events, outcome, version) {
  if (!events.some(({ state }) => ["Running", "Verifying"].includes(state))) return "launch";
  if (outcome?.state === "RolledBack") return "RolledBack";
  if (outcome?.state === "UpdateCancelled") return "Cancelled";
  if (outcome?.state === "Updated" && outcome.version === version) return "verify";
  const completed = events.findLast(
    (event) => event.state === "Verifying" && Number.isInteger(event.exitCode),
  );
  return completed?.exitCode === 0 ? "verify" : "Unresolved";
}
