import { getJsonStorage, pluginStoragePathFor } from '@revenge-mod/json-storage'

export interface Storage {
	nameLength: number
}

export const DEFAULT_LEN = 10

export const storage = getJsonStorage<Storage>(
	pluginStoragePathFor('k1ngop.anonymous-file-names'),
	{ default: { nameLength: DEFAULT_LEN }, load: true },
)

export function getLen(): number {
	const n = Number(storage.cache?.nameLength)
	return n > 0 ? n : DEFAULT_LEN
}
