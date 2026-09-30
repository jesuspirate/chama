/** A local hide is only allowed after the signed cancellation is published. */
export async function deleteListings(
  ids: Iterable<string>,
  cancel: (id: string, reason: string) => Promise<unknown>,
  retire: (id: string) => void,
  reason = 'seller_cleared_listing',
): Promise<number> {
  let count = 0;
  for (const id of ids) {
    await cancel(id, reason);
    retire(id);
    count++;
  }
  return count;
}
