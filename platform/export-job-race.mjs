/**
 * Resolve the Store-2 create-or-join edge for an immutable export key.
 *
 * PostgreSQL can let two workers observe no row before one INSERT wins the
 * unique key. The loser must join that exact row rather than surfacing 500 or
 * resetting work owned by the winner.
 */

export const isExportJobUniqueConflict = error => error?.code === "23505"
  || String(error?.code || "").startsWith("SQLITE_CONSTRAINT")
  || /unique constraint|duplicate key/i.test(String(error?.message || ""));

export async function createOrJoinExportJob({ find, create, load, candidate }) {
  const existing = await find();
  if (existing) return { job: existing, created: false, raced: false };
  try {
    await create(candidate);
    const job = await load(candidate.id);
    if (!job) throw Object.assign(new Error("created export job could not be read"),
      { code: "EXPORT_JOB_CREATE_MISSING" });
    return { job, created: true, raced: false };
  } catch (error) {
    if (!isExportJobUniqueConflict(error)) throw error;
    const winner = await find();
    if (!winner) throw error;
    return { job: winner, created: false, raced: true };
  }
}
