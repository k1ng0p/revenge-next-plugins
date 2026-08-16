const CHARS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'

export default function randStr(len: number): string {
	const bytes = crypto.getRandomValues(new Uint8Array(len))
	let s = ''
	for (let i = 0; i < len; i++) s += CHARS[bytes[i] % CHARS.length]
	return s
}
