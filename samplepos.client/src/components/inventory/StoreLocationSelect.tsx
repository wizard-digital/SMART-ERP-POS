import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import type { StoreLocation } from '../../../../shared/types/warehouseNetwork';
import { MultistoreGate } from './MultistoreGate';
import { commitStoreLocationSelectValue } from './storeLocationSelectCommit';

interface StoreLocationSelectProps {
  stores: StoreLocation[];
  value: string;
  onChange: (storeId: string) => void;
  disabled?: boolean;
  triggerClassName?: string;
  id?: string;
  label?: string;
  allowEmpty?: boolean;
  emptyLabel?: string;
  placeholder?: string;
  filter?: (store: StoreLocation) => boolean;
  /** When true, returns null unless multistore is enabled (single-store fail-safe). */
  multistoreOnly?: boolean;
}

function StoreLocationSelectInner({
  stores,
  value,
  onChange,
  disabled = false,
  triggerClassName,
  id,
  label,
  allowEmpty = false,
  emptyLabel = 'Select store…',
  placeholder,
  filter,
}: Omit<StoreLocationSelectProps, 'multistoreOnly'>) {
  const options = filter ? stores.filter(filter) : stores;
  const optionIds = new Set(options.map((s) => s.id));
  const warehouses = options.filter((s) => s.storeType === 'MAIN');
  const shops = options.filter((s) => s.storeType === 'SELLING');
  const other = options.filter((s) => s.storeType !== 'MAIN' && s.storeType !== 'SELLING');
  const grouped = warehouses.length > 0 && shops.length > 0;
  // Always keep Select controlled — undefined value crashes Radix when options arrive later.
  const resolvedValue =
    value && optionIds.has(value)
      ? value
      : allowEmpty
        ? '__empty__'
        : (options[0]?.id ?? '__pending__');

  const renderItem = (store: StoreLocation) => (
    <SelectItem key={store.id} value={store.id}>
      {store.name} ({store.code}) — {store.storeType}
    </SelectItem>
  );

  return (
    <div className="space-y-2">
      {label && (
        <Label htmlFor={id} className="text-gray-700">
          {label}
        </Label>
      )}
      <Select
        value={resolvedValue}
        onValueChange={(next) => {
          commitStoreLocationSelectValue(next, onChange);
        }}
        disabled={disabled || options.length === 0}
      >
        <SelectTrigger id={id} className={triggerClassName}>
          <SelectValue placeholder={placeholder ?? emptyLabel} />
        </SelectTrigger>
        <SelectContent>
          {allowEmpty && <SelectItem value="__empty__">{emptyLabel}</SelectItem>}
          {!allowEmpty && options.length === 0 && (
            <SelectItem value="__pending__" disabled>
              Loading stores…
            </SelectItem>
          )}
          {grouped ? (
            <>
              <SelectGroup>
                <SelectLabel>Warehouse</SelectLabel>
                {warehouses.map(renderItem)}
              </SelectGroup>
              <SelectGroup>
                <SelectLabel>Shops</SelectLabel>
                {shops.map(renderItem)}
              </SelectGroup>
              {other.length > 0 ? (
                <SelectGroup>
                  <SelectLabel>Other</SelectLabel>
                  {other.map(renderItem)}
                </SelectGroup>
              ) : null}
            </>
          ) : (
            options.map(renderItem)
          )}
        </SelectContent>
      </Select>
    </div>
  );
}

export function StoreLocationSelect({ multistoreOnly = false, ...props }: StoreLocationSelectProps) {
  if (multistoreOnly) {
    return (
      <MultistoreGate>
        <StoreLocationSelectInner {...props} />
      </MultistoreGate>
    );
  }

  return <StoreLocationSelectInner {...props} />;
}
