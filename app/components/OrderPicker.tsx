import { useMemo, useRef, useState } from "react";
import { Autocomplete } from "@shopify/polaris";

// Searchable replacement for Pack Check's order dropdown. Typing narrows the
// list to packages whose search text contains every word typed, ignoring
// case: customer names, Trade Me usernames, order numbers and emails.
// The full list shows when the box is focused with nothing typed.

export interface OrderPickerOption {
  value: string;
  label: string;
  search: string; // lower-case text to match against
}

export function matchesQuery(search: string, query: string): boolean {
  const words = query.toLowerCase().replace(/#/g, " ").split(/\s+/).filter(Boolean);
  return words.every((w) => search.includes(w));
}

export function OrderPicker({ options, value, onSelect }: {
  options: OrderPickerOption[];
  value: string;
  onSelect: (value: string) => void;
}) {
  // null = not searching (the box shows the selected package's label)
  const [query, setQuery] = useState<string | null>(null);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selectedLabel = options.find((o) => o.value === value)?.label ?? "";
  const filtered = useMemo(
    () => (query ? options.filter((o) => matchesQuery(o.search, query)) : options)
      .map(({ value, label }) => ({ value, label })),
    [options, query],
  );

  return (
    <Autocomplete
      options={filtered}
      selected={value ? [value] : []}
      onSelect={(sel) => {
        setQuery(null);
        if (sel[0]) onSelect(sel[0]);
      }}
      emptyState={<div style={{ padding: "8px 12px", color: "#666" }}>No orders match “{query}”</div>}
      textField={
        <Autocomplete.TextField
          label="Order"
          labelHidden
          autoComplete="off"
          value={query ?? selectedLabel}
          placeholder="Search name, username, order # or email…"
          onChange={(v) => setQuery(v)}
          onFocus={() => {
            if (blurTimer.current) clearTimeout(blurTimer.current);
            setQuery("");
          }}
          // Delay so a click on a list option registers before the search resets.
          onBlur={() => { blurTimer.current = setTimeout(() => setQuery(null), 200); }}
          clearButton
          onClearButtonClick={() => setQuery("")}
        />
      }
    />
  );
}
