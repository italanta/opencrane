/**
 * Native collection utilities replacing lodash helpers for ESM compatibility.
 *
 * Each function mirrors the lodash signature it replaces so call-sites
 * need only swap the import path.
 */

/**
 * Sort an array of items by a string key or by natural string comparison.
 *
 * When called without a key the elements themselves are compared via
 * `String.prototype.localeCompare`, matching `_.sortBy(array)` for
 * string arrays.
 *
 * @param items - Source array (not mutated).
 * @param key - Optional property name to sort by.
 * @returns A new sorted array.
 */
export function ___SortBy<T>(items: T[], key?: keyof T): T[]
{
	const copy = [...items];

	if (key)
	{
		return copy.sort(function _compare(a, b)
		{
			const aVal = String(a[key] ?? "");
			const bVal = String(b[key] ?? "");
			return aVal.localeCompare(bVal);
		});
	}

	return copy.sort(function _compare(a, b)
	{
		return String(a).localeCompare(String(b));
	});
}

/**
 * Test whether any element in an array satisfies a predicate.
 *
 * This is a thin wrapper around `Array.prototype.some` that matches the
 * lodash `_.some(collection, predicate)` call signature for arrays.
 *
 * @param items - Array to test.
 * @param predicate - Callback invoked per element.
 * @returns True when at least one element passes.
 */
export function ___SomeArray<T>(items: T[], predicate: (item: T) => boolean): boolean
{
	return items.some(predicate);
}

/**
 * Test whether any entry in a plain object satisfies a predicate.
 *
 * Mirrors the lodash `_.some(object, iteratee)` overload that passes
 * `(value, key)` to the callback.
 *
 * @param record - Plain object to iterate.
 * @param predicate - Callback invoked with `(value, key)`.
 * @returns True when at least one entry passes.
 */
export function ___SomeRecord<V>(record: Record<string, V>, predicate: (value: V, key: string) => boolean): boolean
{
	for (const key of Object.keys(record))
	{
		if (predicate(record[key], key))
		{
			return true;
		}
	}

	return false;
}
