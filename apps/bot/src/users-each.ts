/**
 * Look several users up so that one we cannot resolve costs only its own slot.
 *
 * mtcute 0.31 `getUsers(ids)` resolves eight or more ids through `parallelMap`,
 * which keeps an unresolvable id as `null` in the list, then hands that `null`
 * to the batcher, whose key function reads `item._` and throws. Under eight ids
 * the nulls are skipped, so the bug shows only on long lists: a ten-row `/top`
 * with one member the peer cache never saw rejected as a whole, the caller's
 * `.catch(() => [])` turned that into "no users", and every row fell back to
 * its id at once.
 *
 * One call per id avoids the list path entirely. The batcher still merges the
 * concurrent calls into a single `users.getUsers` request, so it costs the same
 * round trip.
 */
export const getUsersEach = async <U>(
  fetchOne: (id: number) => Promise<U | null>,
  ids: readonly number[]
): Promise<(U | null)[]> =>
  Promise.all(ids.map((id) => fetchOne(id).catch(() => null)))
