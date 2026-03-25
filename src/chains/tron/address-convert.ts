/**
 * Tron address conversion — T... Base58Check ↔ 0x hex.
 *
 * Tron addresses are 21 bytes: 0x41 prefix + 20-byte address.
 * The JSON-RPC layer strips the 0x41 and returns standard 0x-prefixed hex.
 * We need to convert between the two at the watcher boundary.
 */
import { sha256 } from "@noble/hashes/sha2.js";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58decode(s: string): Uint8Array {
	// Count leading '1' characters (each represents a 0x00 byte)
	let leadingZeros = 0;
	for (const ch of s) {
		if (ch !== "1") break;
		leadingZeros++;
	}
	let num = 0n;
	for (const ch of s) {
		const idx = BASE58_ALPHABET.indexOf(ch);
		if (idx < 0) throw new Error(`Invalid base58 character: ${ch}`);
		num = num * 58n + BigInt(idx);
	}
	const hex = num.toString(16).padStart(2, "0");
	const dataBytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < dataBytes.length; i++) dataBytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	// Prepend leading zero bytes
	const result = new Uint8Array(leadingZeros + dataBytes.length);
	result.set(dataBytes, leadingZeros);
	return result;
}

/**
 * Convert a Tron T... address to 0x hex (20 bytes, no 0x41 prefix).
 * For feeding addresses to the EVM watcher JSON-RPC filters.
 */
export function tronToHex(tronAddr: string): string {
	if (!tronAddr.startsWith("T")) throw new Error(`Not a Tron address: ${tronAddr}`);
	const decoded = base58decode(tronAddr);
	// decoded: [0x41, ...20 bytes address..., ...4 bytes checksum]
	// Verify checksum
	const payload = decoded.slice(0, 21);
	const checksum = sha256(sha256(payload)).slice(0, 4);
	for (let i = 0; i < 4; i++) {
		if (decoded[21 + i] !== checksum[i]) throw new Error(`Invalid checksum for Tron address: ${tronAddr}`);
	}
	// Strip 0x41 prefix, return 20-byte hex with 0x prefix
	const addrBytes = payload.slice(1);
	return `0x${Array.from(addrBytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Convert a 0x hex address (20 bytes) back to Tron T... Base58Check.
 * For converting watcher event addresses back to DB format.
 */
export function hexToTron(hexAddr: string): string {
	const hex = hexAddr.startsWith("0x") ? hexAddr.slice(2) : hexAddr;
	if (hex.length !== 40) throw new Error(`Invalid hex address length: ${hex.length}`);
	// Build payload: 0x41 + 20 bytes
	const payload = new Uint8Array(21);
	payload[0] = 0x41;
	for (let i = 0; i < 20; i++) payload[i + 1] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	// Compute checksum
	const checksum = sha256(sha256(payload)).slice(0, 4);
	const full = new Uint8Array(25);
	full.set(payload);
	full.set(checksum, 21);
	// Base58 encode
	let num = 0n;
	for (const byte of full) num = num * 256n + BigInt(byte);
	let encoded = "";
	while (num > 0n) {
		encoded = BASE58_ALPHABET[Number(num % 58n)] + encoded;
		num = num / 58n;
	}
	for (const byte of full) {
		if (byte !== 0) break;
		encoded = `1${encoded}`;
	}
	return encoded;
}

/**
 * Check if an address is a Tron T... address.
 */
export function isTronAddress(addr: string): boolean {
	return addr.startsWith("T") && addr.length >= 33 && addr.length <= 35;
}
