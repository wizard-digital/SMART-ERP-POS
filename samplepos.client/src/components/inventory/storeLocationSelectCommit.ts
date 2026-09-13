/** Radix Select onValueChange — pending placeholder must not commit. */
export function commitStoreLocationSelectValue(
  next: string,
  onChange: (storeId: string) => void,
): void {
  if (next === '__pending__') return;
  if (next === '__empty__') {
    onChange('');
    return;
  }
  onChange(next);
}
