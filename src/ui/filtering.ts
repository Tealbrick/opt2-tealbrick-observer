// What the long lists of Observer share for the kit filter (C382 batch 4): the remembered key, one per screen
// (`tb-filter:observer:<screen>`), the length from which a list gets a filter bar, and the choices of a "which one" select.
import type { SelectOption } from "@opt2-tealbrick/ui";

/** A list shorter than this shows no filter bar, unless a filter is on, or the list is paged. */
export const FILTER_FROM = 8;
/** The choice that means "no facet". */
export const ALL = "__all";
/** Connect's catalog read gives at most this many conversations or collections of an account (src/connect.ts MAX_CONVERSATIONS); at this many, the list may be cut. */
export const CONVERSATIONS_MOST = 200;

export const filterKey = (screen: string): string => `tb-filter:observer:${screen}`;

/**
 * Select options: the first one clears the facet; then every known choice by name; a remembered choice that is no longer
 * known stays selectable, so a filter that is on is never hidden.
 */
export function facetChoices(all: string, known: readonly { value: string; label: string }[], selected: string, gone: string): SelectOption[] {
  const byValue = new Map<string, string>();
  for (const k of known) if (!byValue.has(k.value)) byValue.set(k.value, k.label);
  const options: SelectOption[] = [{ value: ALL, label: all }];
  for (const [value, label] of [...byValue].sort((a, b) => a[1].localeCompare(b[1]))) options.push({ value, label });
  if (selected !== "" && !byValue.has(selected)) options.push({ value: selected, label: gone });
  return options;
}
